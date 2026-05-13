/**
 * @NApiVersion 2.1
 *
 * LLM gateway for Record AI — resolves provider/model from shared custom
 * records, dispatches chat completion via N/llm or HTTPS, applies tunable
 * temperature/topP/topK/frequencyPenalty parameters, and returns parsed text.
 */
define([
  "N/https",
  "N/search",
  "N/record",
  "N/llm",
  "./record_ai_lib_records",
], (https, search, record, nllm, R) => {
  /** Promise-mode HTTPS avoids default short sync timeouts on long LLM calls (ms). */
  const HTTP_TIMEOUT_MS = 300000;

  const PROV = R.provider;
  const MDL = R.model;

  const extractContent = (messageContent) => {
    if (typeof messageContent === "string") {
      return messageContent;
    }

    if (Array.isArray(messageContent)) {
      return messageContent
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part.text === "string") return part.text;
          return "";
        })
        .join("");
    }

    return "";
  };

  const getProviderModel = (providerId, preferredModel) => {
    if (!providerId) {
      return "";
    }

    const models = search
      .create({
        type: MDL.type,
        filters: [
          [MDL.fields.parent, "anyof", providerId],
          "AND",
          ["isinactive", "is", "F"],
        ],
        columns: [
          search.createColumn({ name: "internalid", sort: search.Sort.ASC }),
          MDL.fields.modelId,
        ],
      })
      .run()
      .getRange({ start: 0, end: 200 })
      .map((result) => result.getValue({ name: MDL.fields.modelId }))
      .filter(Boolean);

    if (preferredModel && models.includes(preferredModel)) {
      return preferredModel;
    }

    return models[0] || "";
  };

  const getActiveProvider = (options) => {
    const opts = options || {};

    const results = search
      .create({
        type: PROV.type,
        filters: [["isinactive", "is", "F"]],
        columns: [
          search.createColumn({ name: "internalid", sort: search.Sort.ASC }),
          PROV.fields.name,
          PROV.fields.url,
        ],
      })
      .run()
      .getRange({ start: 0, end: 200 });

    const preferredId = opts.providerRecordId;
    const result =
      results.find(
        (item) =>
          String(item.getValue({ name: "internalid" })) ===
          String(preferredId || ""),
      ) || results[0];

    if (!result) {
      throw new Error(
        "No active NSAI LLM provider record found. Create a " +
          PROV.type +
          " entry.",
      );
    }

    const providerId = result.getValue({ name: "internalid" });
    const providerRecord = record.load({
      type: PROV.type,
      id: providerId,
      isDynamic: false,
    });
    const provider = {
      id: providerId,
      provider: providerRecord.getValue({ fieldId: PROV.fields.name }),
      key: providerRecord.getValue({ fieldId: PROV.fields.apiKey }),
      url: providerRecord.getValue({ fieldId: PROV.fields.url }),
      model: getProviderModel(providerId, opts.model),
    };

    const isNative = provider.provider.toLowerCase() === "nllm";
    if (!isNative && !provider.key) {
      throw new Error("The active NSAI provider record is missing an API key.");
    }
    const requireModel = opts.requireModel !== false;
    if (requireModel && !provider.model) {
      throw new Error(
        "The selected NSAI provider does not have any related model records.",
      );
    }
    if (!isNative && !provider.url) {
      throw new Error("Active LLM provider is missing an API URL.");
    }
    provider.isNative = isNative;

    return provider;
  };

  const parseResponseBody = (response) => {
    let parsed;

    try {
      parsed = JSON.parse(response.body || "{}");
    } catch (err) {
      throw new Error(
        "LLM response was not valid JSON (" +
          response.code +
          "): " +
          String(response.body || "").slice(0, 300),
      );
    }

    if (Number(response.code) < 200 || Number(response.code) >= 300) {
      const errorMessage =
        (parsed && parsed.error && parsed.error.message) ||
        (parsed && parsed.message) ||
        String(response.body || "").slice(0, 300) ||
        "HTTP " + response.code;
      throw new Error("LLM request failed: " + errorMessage);
    }

    const choices = parsed && parsed.choices;
    const firstMsg = choices && choices[0] && choices[0].message;
    const content = extractContent(firstMsg && firstMsg.content);
    if (!content) {
      throw new Error(
        "LLM response did not contain assistant message content.",
      );
    }

    return content;
  };

  const extractJsonString = (content) => {
    if (!content) {
      throw new Error("Structured LLM response was empty.");
    }

    const fenced = String(content).match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) {
      return fenced[1];
    }

    const firstBrace = String(content).indexOf("{");
    const lastBrace = String(content).lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return String(content).slice(firstBrace, lastBrace + 1);
    }

    return content;
  };

  const convertMessagesForNative = (messages) => {
    const msgs = Array.isArray(messages) ? messages : [];
    var preamble = "";
    var prompt = "";
    var chatHistory = [];

    var systemIdx = -1;
    var lastUserIdx = -1;
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i].role === "system" && systemIdx === -1) systemIdx = i;
      if (msgs[i].role === "user") lastUserIdx = i;
    }

    if (systemIdx !== -1) {
      preamble = msgs[systemIdx].content || "";
    }
    if (lastUserIdx !== -1) {
      prompt = msgs[lastUserIdx].content || "";
    }

    for (var j = 0; j < msgs.length; j++) {
      if (j === systemIdx || j === lastUserIdx) continue;
      var m = msgs[j];
      if (m.role === "user") {
        chatHistory.push({
          role: nllm.ChatRole.USER,
          text: m.content || "",
        });
      } else if (m.role === "assistant") {
        chatHistory.push({
          role: nllm.ChatRole.CHATBOT,
          text: m.content || "",
        });
      }
    }

    return { preamble, prompt, chatHistory };
  };

  const callNativeLLM = (messages, provider, opts) => {
    var converted = convertMessagesForNative(messages);

    var modelFamily = nllm.ModelFamily[provider.model] || provider.model;

    var genOpts = {
      prompt: converted.prompt,
      modelFamily: modelFamily,
      timeout: opts.timeout || HTTP_TIMEOUT_MS,
    };
    if (converted.preamble) {
      genOpts.preamble = converted.preamble;
    }
    if (converted.chatHistory.length > 0) {
      genOpts.chatHistory = converted.chatHistory;
    }

    var modelParams = {};
    var temp = typeof opts.temperature === "number" ? opts.temperature : 0.2;
    modelParams.temperature = temp;
    if (typeof opts.topP === "number") {
      modelParams.topP = opts.topP;
    }
    if (typeof opts.topK === "number") {
      modelParams.topK = opts.topK;
    }
    if (typeof opts.frequencyPenalty === "number") {
      modelParams.frequencyPenalty = opts.frequencyPenalty;
    }
    if (opts.maxTokens) {
      modelParams.maxTokens = opts.maxTokens;
    }
    genOpts.modelParameters = modelParams;

    var response = nllm.generateText(genOpts);
    var content = response.text || "";

    if (!content) {
      throw new Error("N/llm response did not contain any text.");
    }
    return content;
  };

  const callLLM = (messages, options) => {
    const opts = options || {};
    const provider = getActiveProvider(opts);

    if (provider.isNative) {
      var nativeResult = Promise.resolve(
        callNativeLLM(messages, provider, opts),
      );
      return nativeResult;
    }

    const payload = {
      model: provider.model,
      messages: Array.isArray(messages) ? messages : [],
      temperature:
        typeof opts.temperature === "number" ? opts.temperature : 0.2,
    };

    if (opts.maxTokens) {
      payload.max_tokens = opts.maxTokens;
    }
    if (typeof opts.topP === "number") {
      payload.top_p = opts.topP;
    }
    if (typeof opts.topK === "number") {
      payload.top_k = opts.topK;
    }
    if (typeof opts.frequencyPenalty === "number") {
      payload.frequency_penalty = opts.frequencyPenalty;
    }
    if (opts.responseFormat) {
      payload.response_format = opts.responseFormat;
    }

    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer " + provider.key,
    };

    if (provider.provider.toLowerCase() === "openrouter") {
      headers["HTTP-Referer"] =
        opts.httpReferer || "https://netsuite.local/record_ai";
      headers["X-Title"] = opts.title || "Record AI";
    }

    var httpCall = https.post.promise({
      url: provider.url,
      headers: headers,
      body: JSON.stringify(payload),
      timeout: HTTP_TIMEOUT_MS,
    });

    var result = httpCall.then(function (response) {
      const content = parseResponseBody(response);
      return content;
    });
    return result;
  };

  const callLLMStructured = (messages, options) => {
    var llmResult = callLLM(messages, options);

    var result = llmResult.then(function (content) {
      try {
        const parsed = JSON.parse(extractJsonString(content));
        return parsed;
      } catch (err) {
        throw new Error(
          "Unable to parse structured LLM response: " + err.message,
        );
      }
    });
    return result;
  };

  return {
    callLLM,
    callLLMStructured,
    getActiveProvider,
  };
});

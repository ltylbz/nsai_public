/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Record AI panel UI — renders the in-record chat page (provider/model picker,
 * tunable LLM params, prompt input), enqueues jobs on customrecord_record_ai_job,
 * polls for results, and exposes cleanup endpoints for the per-record memory
 * files under /SuiteScripts/record_ai/logs/.
 */
define([
  "N/ui/serverWidget",
  "N/file",
  "N/record",
  "N/search",
  "N/runtime",
  "N/task",
  "N/url",
  "./lib/record_ai_lib_records",
], (serverWidget, file, record, search, runtime, task, url, R) => {
  const JOB = R.job;
  const PROV = R.provider;
  const MDL = R.model;
  const HTML_PATH = "./metadata/record_ai_sl.html";
  const MR_SCRIPT_ID = "customscript_record_ai_mr";
  const ORIG_DEPLOY_ID = "customdeploy_record_ai_mr";
  const MAX_MR_DEPLOYMENTS = 10;
  const DEPLOY_PREFIX = "_record_ai_mr_";
  const DEPLOY_TITLE_BASE = "Record AI";
  const LOG_FOLDER_PATH = "/SuiteScripts/record_ai/logs/";
  /** Account-wide defaults row (see `customrecord_ai_defaults` in the `common` SDF project). */
  const AI_DEFAULTS = {
    type: "customrecord_ai_defaults",
    fields: {
      provider: "custrecord_ai_default_provider",
      model: "custrecord_ai_default_model",
    },
  };
  const DEFAULT_QUESTIONS = [
    "What should I pay attention to in this record?",
    "Summarize this record in a few sentences.",
    "Are there any overdue items or risks?",
    "Explain the key financial figures.",
    "List all related contacts and their roles.",
  ];
  const STATUS = {
    QUEUED: "queued",
    PROCESSING: "processing",
    COMPLETED: "completed",
    FAILED: "failed",
  };

  const escapeHtml = (v) =>
    String(v == null ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const sendJson = (context, body) => {
    context.response.setHeader({
      name: "Content-Type",
      value: "application/json; charset=utf-8",
    });
    context.response.write(JSON.stringify(body));
  };

  const loadHtml = (path) => file.load({ id: path }).getContents();

  const sanitizeKey = (value) =>
    String(value == null ? "" : value).replace(/[^A-Za-z0-9_-]/g, "_") || "na";

  const buildMemoryFilePaths = (userId, recType, recId) => {
    var safeUser = sanitizeKey(userId);
    var safeType = sanitizeKey(recType);
    var safeId = sanitizeKey(recId);
    return {
      detailPath:
        LOG_FOLDER_PATH +
        "ra_detail_" +
        safeUser +
        "_" +
        safeType +
        "_" +
        safeId +
        ".csv",
      summaryPath:
        LOG_FOLDER_PATH +
        "ra_summary_" +
        safeUser +
        "_" +
        safeType +
        "_" +
        safeId +
        ".csv",
      recordPath:
        LOG_FOLDER_PATH +
        "ra_record_" +
        safeUser +
        "_" +
        safeType +
        "_" +
        safeId +
        ".json",
      txnPath:
        LOG_FOLDER_PATH +
        "ra_txn_" +
        safeUser +
        "_" +
        safeType +
        "_" +
        safeId +
        ".json",
    };
  };

  const safeDeleteByPath = (path) => {
    try {
      var loaded = file.load({ id: path });
      file.delete({ id: loaded.id });
    } catch (err) {
      var text =
        String((err && err.name) || "") +
        " " +
        String((err && err.message) || "");
      if (
        /RCRD_DSNT_EXIST|does not exist|FILE_DOES_NOT_EXIST|not exist/i.test(
          text,
        )
      ) {
        return;
      }
      throw err;
    }
  };

  const cleanupMemoryFiles = (userId, recType, recId) => {
    var paths = buildMemoryFilePaths(userId, recType, recId);
    safeDeleteByPath(paths.detailPath);
    safeDeleteByPath(paths.summaryPath);
    safeDeleteByPath(paths.recordPath);
    safeDeleteByPath(paths.txnPath);
  };

  const clampNumber = (v, min, max, fallback) => {
    var n = Number(v);
    if (isNaN(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  };

  const normalizeLlmParams = (raw) => {
    var src = raw || {};
    var topKRaw = Number(src.topK);
    if (isNaN(topKRaw)) topKRaw = 3;
    var topK = Math.floor(topKRaw);
    if (topK < 2) topK = 2;
    var params = {
      temperature: clampNumber(src.temperature, 0, 1, 0.2),
      topP: clampNumber(src.topP, 0, 1, 0.2),
      topK: topK,
      frequencyPenalty: clampNumber(src.frequencyPenalty, -2, 2, 0),
    };
    return params;
  };

  const handleCleanup = (context, recType, recId) => {
    if (!recType || !recId) {
      sendJson(context, {
        success: false,
        error: "recordType and recordId are required.",
      });
      return;
    }
    var currentUser = runtime.getCurrentUser();
    cleanupMemoryFiles(currentUser.id, recType, recId);
    sendJson(context, { success: true });
  };

  const buildRecordLink = (label, recordType, recordId) => {
    try {
      var href = url.resolveRecord({
        recordType: recordType,
        recordId: recordId,
        isEditMode: false,
      });
      return (
        '<a href="' +
        escapeHtml(href) +
        '" target="_blank" rel="noopener noreferrer">' +
        escapeHtml(label) +
        "</a>"
      );
    } catch (e) {
      return escapeHtml(label);
    }
  };

  const resolveTokens = (text) => {
    var source = String(text == null ? "" : text);
    var tokenRe =
      /(?:<code>)?\[\[([^|\]]+)\|([^|\]]*)\|([^|\]]*)\]\](?:<\/code>)?/g;
    var cursor = 0;
    var out = "";
    var match;
    while ((match = tokenRe.exec(source))) {
      out += source.slice(cursor, match.index);
      if (match[2] && match[3]) {
        out += buildRecordLink(match[1], match[2], match[3]);
      } else {
        out += escapeHtml(match[1]);
      }
      cursor = tokenRe.lastIndex;
    }
    out += source.slice(cursor);
    return out;
  };

  const markdownToHtml = (md) => {
    var lines = String(md || "").split(/\r?\n/);
    var out = [];
    var inUl = false,
      inOl = false,
      inTbl = false,
      inTb = false;
    var pBuf = [];
    var flush = function () {
      if (pBuf.length) {
        out.push("<p>" + pBuf.join(" ") + "</p>");
        pBuf = [];
      }
    };
    var closeLists = function () {
      if (inUl) {
        out.push("</ul>");
        inUl = false;
      }
      if (inOl) {
        out.push("</ol>");
        inOl = false;
      }
    };
    var closeTbl = function () {
      if (inTb) {
        out.push("</tbody>");
        inTb = false;
      }
      if (inTbl) {
        out.push("</table>");
        inTbl = false;
      }
    };
    var closeAll = function () {
      flush();
      closeLists();
      closeTbl();
    };
    var fmt = function (t) {
      t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      t = t.replace(/\*(.+?)\*/g, "<em>$1</em>");
      t = t.replace(/`(.+?)`/g, "<code>$1</code>");
      t = t.replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      );
      return t;
    };

    for (var i = 0; i < lines.length; i++) {
      var tr = lines[i].trim();
      if (!tr) {
        flush();
        closeTbl();
        continue;
      }
      if (/^---+$/.test(tr)) {
        closeAll();
        out.push("<hr>");
        continue;
      }

      var hm = tr.match(/^(#{1,6})\s+(.+)$/);
      if (hm) {
        closeAll();
        var lvl = hm[1].length;
        out.push("<h" + lvl + ">" + fmt(hm[2]) + "</h" + lvl + ">");
        continue;
      }

      if (tr.charAt(0) === "|") {
        flush();
        closeLists();
        if (/^\|[\s\-:|]+\|$/.test(tr)) continue;
        var cells = tr.replace(/^\||\|$/g, "").split("|");
        if (!inTbl) {
          out.push("<table><thead><tr>");
          cells.forEach(function (c) {
            out.push("<th>" + fmt(c.trim()) + "</th>");
          });
          out.push("</tr></thead>");
          inTbl = true;
          continue;
        }
        if (!inTb) {
          out.push("<tbody>");
          inTb = true;
        }
        out.push("<tr>");
        cells.forEach(function (c) {
          out.push("<td>" + fmt(c.trim()) + "</td>");
        });
        out.push("</tr>");
        continue;
      }

      var ulm = tr.match(/^[-*]\s+(.+)$/);
      if (ulm) {
        flush();
        closeTbl();
        if (inOl) {
          out.push("</ol>");
          inOl = false;
        }
        if (!inUl) {
          out.push("<ul>");
          inUl = true;
        }
        out.push("<li>" + fmt(ulm[1]) + "</li>");
        continue;
      }

      var olm = tr.match(/^(\d+)[.)]\s+(.+)$/);
      if (olm) {
        flush();
        closeTbl();
        if (inUl) {
          out.push("</ul>");
          inUl = false;
        }
        if (!inOl) {
          out.push("<ol>");
          inOl = true;
        }
        out.push('<li value="' + olm[1] + '">' + fmt(olm[2]) + "</li>");
        continue;
      }

      closeLists();
      closeTbl();
      pBuf.push(fmt(tr));
    }
    closeAll();
    return out.join("\n");
  };

  const formatAnswer = (rawText) => {
    return resolveTokens(markdownToHtml(rawText));
  };

  // -- Dynamic deployment helpers --

  const isDeploymentBusy = (deploymentId) => {
    var s = search.create({
      type: "scheduledscriptinstance",
      filters: [
        ["status", "anyof", ["PENDING", "PROCESSING", "RESTART", "RETRY"]],
        "AND",
        ["script.scriptid", "is", MR_SCRIPT_ID],
        "AND",
        ["scriptdeployment.scriptid", "is", deploymentId],
      ],
      columns: ["status"],
    });
    return s.runPaged().count > 0;
  };

  const findOrCreateDeployment = (excludedIds) => {
    var depSearch = search.create({
      type: search.Type.SCRIPT_DEPLOYMENT,
      filters: [
        ["script.scriptid", "is", MR_SCRIPT_ID],
        "AND",
        ["isdeployed", "is", "T"],
      ],
      columns: ["scriptid"],
    });
    var deployments = [];
    depSearch.run().each(function (r) {
      deployments.push(r.getValue("scriptid"));
      return true;
    });

    for (var i = 0; i < deployments.length; i++) {
      if (excludedIds[deployments[i].toUpperCase()]) continue;
      if (!isDeploymentBusy(deployments[i])) {
        return { deploymentId: deployments[i], created: false };
      }
    }

    if (deployments.length >= MAX_MR_DEPLOYMENTS) {
      throw new Error("All M/R deployments are busy. Please try again later.");
    }

    var maxSeq = 0;
    var existingIds = {};
    for (var i = 0; i < deployments.length; i++) {
      existingIds[deployments[i]] = true;
      var m = deployments[i].match(/_(\d+)$/);
      if (m) {
        var n = parseInt(m[1], 10);
        if (n > maxSeq) maxSeq = n;
      }
    }

    var scriptSearch = search.create({
      type: search.Type.MAP_REDUCE_SCRIPT,
      filters: [["scriptid", "is", MR_SCRIPT_ID]],
      columns: ["internalid"],
    });
    var scriptInternalId;
    scriptSearch.run().each(function (r) {
      scriptInternalId = r.getValue("internalid");
      return false;
    });
    if (!scriptInternalId)
      throw new Error("Script " + MR_SCRIPT_ID + " not found");

    var sequence = maxSeq + 1;
    for (var attempt = 0; attempt < 5; attempt++) {
      var newId = DEPLOY_PREFIX + sequence;
      var fullId = "customdeploy" + newId;
      while (existingIds[fullId]) {
        sequence++;
        newId = DEPLOY_PREFIX + sequence;
        fullId = "customdeploy" + newId;
      }
      try {
        var dep = record.create({
          type: record.Type.SCRIPT_DEPLOYMENT,
          defaultValues: { script: scriptInternalId },
        });
        dep.setValue({ fieldId: "scriptid", value: newId });
        dep.setValue({
          fieldId: "title",
          value: DEPLOY_TITLE_BASE + " " + sequence,
        });
        dep.setValue({ fieldId: "status", value: "NOTSCHEDULED" });
        dep.setValue({ fieldId: "isdeployed", value: true });
        dep.setValue({ fieldId: "loglevel", value: "DEBUG" });
        dep.save();
        return { deploymentId: fullId, created: true };
      } catch (e) {
        var eName = String(e.name || "");
        var eMsg = String(e.message || "");
        if (!/DUP_RCRD/i.test(eName) && !/already exists/i.test(eMsg)) throw e;
        existingIds[fullId] = true;
        sequence++;
      }
    }
    throw new Error("Unable to create deployment after multiple attempts");
  };

  const deleteDynamicDeployment = (deployScriptId) => {
    if (!deployScriptId || deployScriptId === ORIG_DEPLOY_ID) return;
    try {
      var s = search.create({
        type: search.Type.SCRIPT_DEPLOYMENT,
        filters: [["scriptid", "is", deployScriptId]],
        columns: ["internalid"],
      });
      s.run().each(function (r) {
        record.delete({
          type: record.Type.SCRIPT_DEPLOYMENT,
          id: r.getValue("internalid"),
        });
        return false;
      });
    } catch (e) {
      log.error("deleteDynamicDeployment", e.message);
    }
  };

  // -- Provider catalog --

  const getProviderCatalog = () => {
    var providerRows = search
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

    var providerMap = {};
    var providers = providerRows.map(function (r) {
      var internalId = r.getValue({ name: "internalid" });
      var providerName = r.getValue({ name: PROV.fields.name });
      var provider = {
        internalId: internalId,
        label: providerName || internalId || "Provider",
        models: [],
      };
      providerMap[internalId] = provider;
      return provider;
    });

    search
      .create({
        type: MDL.type,
        filters: [["isinactive", "is", "F"]],
        columns: [
          search.createColumn({ name: "internalid", sort: search.Sort.ASC }),
          MDL.fields.parent,
          MDL.fields.modelId,
        ],
      })
      .run()
      .getRange({ start: 0, end: 1000 })
      .forEach(function (r) {
        var pid = r.getValue({ name: MDL.fields.parent });
        var mid = r.getValue({ name: MDL.fields.modelId });
        if (pid && mid && providerMap[pid]) {
          providerMap[pid].models.push(mid);
        }
      });

    return providers;
  };

  var getAiDefaultsRow = function () {
    var row = { providerInternalId: "", modelRecordInternalId: "" };
    try {
      var results = search
        .create({
          type: AI_DEFAULTS.type,
          filters: [["isinactive", "is", "F"]],
          columns: [
            search.createColumn({ name: "internalid", sort: search.Sort.ASC }),
            AI_DEFAULTS.fields.provider,
            AI_DEFAULTS.fields.model,
          ],
        })
        .run()
        .getRange({ start: 0, end: 1 });
      if (!results || !results.length) return row;
      row.providerInternalId = String(
        results[0].getValue({ name: AI_DEFAULTS.fields.provider }) || "",
      );
      row.modelRecordInternalId = String(
        results[0].getValue({ name: AI_DEFAULTS.fields.model }) || "",
      );
    } catch (e) {
      log.debug({
        title: "record_ai_sl getAiDefaultsRow",
        details: String((e && e.message) || e),
      });
    }
    return row;
  };

  var getModelIdFromModelRecordInternalId = function (modelRecordInternalId) {
    if (!modelRecordInternalId) return "";
    try {
      var m = record.load({
        type: MDL.type,
        id: modelRecordInternalId,
        isDynamic: false,
      });
      return String(m.getValue({ fieldId: MDL.fields.modelId }) || "");
    } catch (e) {
      return "";
    }
  };

  var resolveDefaults = function (providers, paramProviderId, paramModel, cfg) {
    var providerId = paramProviderId || "";
    var modelId = paramModel || "";
    var defProv =
      cfg && cfg.providerInternalId ? String(cfg.providerInternalId) : "";
    var defModelSlug =
      cfg && cfg.defaultModelSlug ? String(cfg.defaultModelSlug) : "";

    if (!providerId) {
      var hasDefProv = false;
      var i;
      if (defProv) {
        for (i = 0; i < providers.length; i++) {
          if (String(providers[i].internalId) === defProv) {
            hasDefProv = true;
            break;
          }
        }
      }
      if (hasDefProv) providerId = defProv;
      else if (providers.length) providerId = providers[0].internalId;
    }

    if (!modelId) {
      var prov;
      for (var j = 0; j < providers.length; j++) {
        if (String(providers[j].internalId) === String(providerId)) {
          prov = providers[j];
          break;
        }
      }
      if (prov && defModelSlug && prov.models.indexOf(defModelSlug) !== -1) {
        modelId = defModelSlug;
      } else if (prov && prov.models.length) {
        modelId = prov.models[0];
      }
    }

    return { providerId: providerId, modelId: modelId };
  };

  // -- Suitelet handlers --

  const renderPage = (context) => {
    var params = context.request.parameters;
    var providers = getProviderCatalog();
    var aiRow = getAiDefaultsRow();
    var aiCfg = {
      providerInternalId: aiRow.providerInternalId,
      defaultModelSlug: getModelIdFromModelRecordInternalId(
        aiRow.modelRecordInternalId,
      ),
    };
    var defaults = resolveDefaults(
      providers,
      params.providerId,
      params.model,
      aiCfg,
    );

    var bootstrap = {
      providers: providers,
      providerId: defaults.providerId,
      modelId: defaults.modelId,
      recordType: params.recordType || "",
      recordId: params.recordId || "",
      defaultQuestion: DEFAULT_QUESTIONS[0],
      defaultQuestions: DEFAULT_QUESTIONS,
    };

    var form = serverWidget.createForm({ title: "Record AI" });
    var htmlField = form.addField({
      id: "custpage_record_ai_html",
      type: serverWidget.FieldType.INLINEHTML,
      label: " ",
    });
    htmlField.defaultValue =
      "<script>window.__RECORD_AI_BOOTSTRAP__ = " +
      JSON.stringify(bootstrap) +
      ";</script>\n" +
      loadHtml(HTML_PATH);

    context.response.writePage(form);
  };

  const handlePost = (context) => {
    var currentUser = runtime.getCurrentUser();
    var body = JSON.parse(context.request.body || "{}");
    var api = context.request.parameters.recordAiApi || "";
    if (api === "cleanup" || body.cleanup === true) {
      handleCleanup(
        context,
        body.recordType || context.request.parameters.recordType || "",
        body.recordId || context.request.parameters.recordId || "",
      );
      return;
    }
    var recType = body.recordType;
    var recId = body.recordId;
    var question = body.question || DEFAULT_QUESTIONS[0];
    var history = body.history;
    var llmParams = normalizeLlmParams(body.llmParams || {});
    var providers = getProviderCatalog();
    var aiRowPost = getAiDefaultsRow();
    var aiCfgPost = {
      providerInternalId: aiRowPost.providerInternalId,
      defaultModelSlug: getModelIdFromModelRecordInternalId(
        aiRowPost.modelRecordInternalId,
      ),
    };
    var defaults = resolveDefaults(
      providers,
      body.providerId || "",
      body.model || "",
      aiCfgPost,
    );
    var providerId = defaults.providerId;
    var modelId = defaults.modelId;

    if (!recType || !recId) {
      sendJson(context, {
        success: false,
        error: "Record type and ID are required.",
      });
      return;
    }

    var jobRecord = record.create({ type: JOB.type, isDynamic: false });
    jobRecord.setValue({ fieldId: JOB.fields.user, value: currentUser.id });
    jobRecord.setValue({ fieldId: JOB.fields.recordType, value: recType });
    jobRecord.setValue({ fieldId: JOB.fields.recordId, value: recId });
    jobRecord.setValue({ fieldId: JOB.fields.question, value: question });
    jobRecord.setValue({
      fieldId: JOB.fields.history,
      value:
        typeof history === "string" ? history : JSON.stringify(history || []),
    });
    if (providerId) {
      jobRecord.setValue({ fieldId: JOB.fields.provider, value: providerId });
    }
    if (modelId) {
      jobRecord.setValue({ fieldId: JOB.fields.model, value: modelId });
    }
    if (JOB.fields.params) {
      jobRecord.setValue({
        fieldId: JOB.fields.params,
        value: JSON.stringify(llmParams),
      });
    }
    jobRecord.setValue({ fieldId: JOB.fields.status, value: STATUS.QUEUED });
    jobRecord.setValue({ fieldId: JOB.fields.error, value: "" });
    var jobId = jobRecord.save();

    var taskId = "";
    var deploy;
    var lastErr;
    var excludedIds = {};

    for (var attempt = 0; attempt < 3; attempt++) {
      deploy = null;
      try {
        deploy = findOrCreateDeployment(excludedIds);
        var mrTask = task.create({
          taskType: task.TaskType.MAP_REDUCE,
          scriptId: MR_SCRIPT_ID,
          deploymentId: deploy.deploymentId,
        });
        taskId = mrTask.submit();
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (/already running/i.test(String(err.message || ""))) {
          if (deploy) excludedIds[deploy.deploymentId.toUpperCase()] = true;
        } else {
          if (deploy && deploy.created)
            deleteDynamicDeployment(deploy.deploymentId);
          break;
        }
      }
    }

    if (lastErr) {
      record.submitFields({
        type: JOB.type,
        id: jobId,
        values: {
          [JOB.fields.status]: STATUS.FAILED,
          [JOB.fields.error]: lastErr.message || "Failed to queue M/R task.",
        },
      });
      sendJson(context, { success: false, error: lastErr.message });
      return;
    }

    var taskIdToStore = deploy.created
      ? taskId + "::" + deploy.deploymentId
      : taskId;

    record.submitFields({
      type: JOB.type,
      id: jobId,
      values: { [JOB.fields.taskId]: taskIdToStore },
    });

    sendJson(context, {
      success: true,
      jobId: jobId,
      taskId: taskId,
      status: STATUS.QUEUED,
    });
  };

  const getJobStatus = (context) => {
    var jobId = context.request.parameters.jobId;
    if (!jobId) {
      sendJson(context, { success: false, error: "Job ID is required." });
      return;
    }

    var currentUser = runtime.getCurrentUser();
    var jr = record.load({ type: JOB.type, id: jobId, isDynamic: false });
    if (
      String(jr.getValue({ fieldId: JOB.fields.user })) !==
      String(currentUser.id)
    ) {
      sendJson(context, { success: false, error: "Access denied." });
      return;
    }

    var taskIdRaw = jr.getValue({ fieldId: JOB.fields.taskId }) || "";
    var taskIdVal = taskIdRaw;
    var dynamicDeployId = "";
    if (taskIdRaw.indexOf("::") !== -1) {
      var parts = taskIdRaw.split("::");
      taskIdVal = parts[0];
      dynamicDeployId = parts[1];
    }

    var taskStatus = "";
    if (taskIdVal) {
      try {
        taskStatus = task.checkStatus({ taskId: taskIdVal }).status;
      } catch (e) {
        taskStatus = "";
      }
    }

    var recStatus = jr.getValue({ fieldId: JOB.fields.status });
    var status =
      recStatus === STATUS.COMPLETED || recStatus === STATUS.FAILED
        ? recStatus
        : taskStatus === "failed" || taskStatus === "canceled"
          ? STATUS.FAILED
          : taskStatus === "pending" || taskStatus === "processing"
            ? STATUS.PROCESSING
            : recStatus;

    var rawError = jr.getValue({ fieldId: JOB.fields.error }) || "";
    var progress = "";
    var errorText = "";
    if (status === STATUS.FAILED) {
      errorText =
        rawError || (taskStatus ? "Background task " + taskStatus + "." : "");
    } else if (status !== STATUS.COMPLETED) {
      progress = rawError;
    }

    var result =
      status === STATUS.COMPLETED
        ? formatAnswer(jr.getValue({ fieldId: JOB.fields.result }) || "")
        : "";

    if (
      (status === STATUS.COMPLETED || status === STATUS.FAILED) &&
      dynamicDeployId
    ) {
      deleteDynamicDeployment(dynamicDeployId);
      record.submitFields({
        type: JOB.type,
        id: jobId,
        values: { [JOB.fields.taskId]: taskIdVal },
      });
    }

    sendJson(context, {
      success: true,
      jobId: jobId,
      status: status,
      error: errorText,
      progress: progress,
      result: result,
    });
  };

  const onRequest = (context) => {
    try {
      if (context.request.method === "GET") {
        var api = context.request.parameters.recordAiApi;
        if (api === "jobStatus") {
          getJobStatus(context);
          return;
        }
        if (api === "cleanup") {
          handleCleanup(
            context,
            context.request.parameters.recordType || "",
            context.request.parameters.recordId || "",
          );
          return;
        }
        renderPage(context);
        return;
      }
      handlePost(context);
    } catch (err) {
      log.error({ title: "Record AI failure", details: err });
      sendJson(context, {
        success: false,
        error: err.message || "Failed to process the request.",
      });
    }
  };

  return { onRequest };
});

/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Search Insight UI — lets the user pick a saved search and ask a question,
 * enqueues the job on customrecord_search_insight_job, and polls for the
 * narrative analysis produced by the Map/Reduce processor.
 */
define([
  "N/ui/serverWidget",
  "N/file",
  "N/record",
  "N/search",
  "N/runtime",
  "N/task",
  "N/url",
  "./lib/search_insight_lib_records",
], (serverWidget, file, record, search, runtime, task, url, R) => {
  const JOB = R.job;
  const PROV = R.provider;
  const MDL = R.model;
  const HTML_PATH = "./metadata/search_insight_sl.html";
  const MR_SCRIPT_ID = "customscript_search_insight_mr";
  const ORIG_DEPLOY_ID = "customdeploy_search_insight_mr";
  const MAX_MR_DEPLOYMENTS = 10;
  const DEPLOY_PREFIX = "_search_insight_mr_";
  const DEPLOY_TITLE_BASE = "Search Insight";
  /** Account-wide defaults row (see `customrecord_ai_defaults` in the `common` SDF project). */
  const AI_DEFAULTS = {
    type: "customrecord_ai_defaults",
    fields: {
      provider: "custrecord_ai_default_provider",
      model: "custrecord_ai_default_model",
    },
  };
  const PREVIEW_ROWS = 12;
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

  const formatInsightResult = (html) => {
    var source = String(html == null ? "" : html);
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

  const getProviderCatalog = () => {
    const providerRows = search
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

    const providerMap = {};
    const providers = providerRows.map((r) => {
      const internalId = r.getValue({ name: "internalid" });
      const providerName = r.getValue({ name: PROV.fields.name });
      const provider = {
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
      .forEach((r) => {
        const pid = r.getValue({ name: MDL.fields.parent });
        const mid = r.getValue({ name: MDL.fields.modelId });
        if (pid && mid && providerMap[pid]) {
          providerMap[pid].models.push(mid);
        }
      });

    return providers;
  };

  const getAiDefaultsRow = () => {
    const row = { providerInternalId: "", modelRecordInternalId: "" };
    try {
      const results = search
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
    } catch (err) {
      log.debug({
        title: "search_insight_sl getAiDefaultsRow",
        details: String(err && err.message ? err.message : err),
      });
    }
    return row;
  };

  const getModelIdFromModelRecordInternalId = (modelRecordInternalId) => {
    if (!modelRecordInternalId) return "";
    try {
      const m = record.load({
        type: MDL.type,
        id: modelRecordInternalId,
        isDynamic: false,
      });
      return String(m.getValue({ fieldId: MDL.fields.modelId }) || "");
    } catch (err) {
      return "";
    }
  };

  const resolveDefaults = (providers, paramProviderId, paramModel, cfg) => {
    let providerId = paramProviderId || "";
    let modelId = paramModel || "";
    const defProv =
      cfg && cfg.providerInternalId ? String(cfg.providerInternalId) : "";
    const defModelSlug =
      cfg && cfg.defaultModelSlug ? String(cfg.defaultModelSlug) : "";

    if (!providerId) {
      if (defProv && providers.some((p) => String(p.internalId) === defProv)) {
        providerId = defProv;
      } else if (providers.length) {
        providerId = providers[0].internalId;
      }
    }

    if (!modelId) {
      const prov = providers.find(
        (p) => String(p.internalId) === String(providerId),
      );
      if (prov && defModelSlug && prov.models.indexOf(defModelSlug) !== -1) {
        modelId = defModelSlug;
      } else if (prov && prov.models.length) {
        modelId = prov.models[0];
      }
    }

    return { providerId: providerId, modelId: modelId };
  };

  const getSavedSearchList = () => {
    var results = [];
    search
      .create({
        type: "savedsearch",
        filters: [["isinactive", "is", "F"]],
        columns: [
          search.createColumn({ name: "internalid", sort: search.Sort.ASC }),
          search.createColumn({ name: "title" }),
          search.createColumn({ name: "recordtype" }),
        ],
      })
      .run()
      .each(function (r) {
        results.push({
          id: r.getValue({ name: "internalid" }),
          title: r.getValue({ name: "title" }) || "",
          recordType: r.getValue({ name: "recordtype" }) || "",
        });
        return results.length < 2000;
      });
    return results;
  };

  const resolveEntityType = (entityId) => {
    var types = ["customer", "vendor", "employee"];
    for (var i = 0; i < types.length; i++) {
      try {
        var hits = search
          .create({
            type: types[i],
            filters: [["internalid", "anyof", entityId]],
            columns: ["internalid"],
          })
          .run()
          .getRange({ start: 0, end: 1 });
        if (hits.length) return types[i];
      } catch (e) {
        /* not this type */
      }
    }
    return "";
  };

  const getSearchPreview = (searchId) => {
    var savedSearch = search.load({ id: searchId });
    var columns = savedSearch.columns;
    var headers = columns.map(function (col) {
      return col.label || col.name || String(col);
    });

    var rows = [];
    var count = 0;
    var hasRecordId = false;
    var entityCol = -1;

    savedSearch.run().each(function (result) {
      count++;
      if (rows.length < PREVIEW_ROWS) {
        var cells = [];
        var entityId = "";
        columns.forEach(function (col, idx) {
          var text = result.getText(col);
          var value = result.getValue(col);
          cells.push(text || value);
          if (text && value && text !== value && /^\d+$/.test(String(value))) {
            if (entityCol === -1) entityCol = idx;
            if (idx === entityCol) entityId = value;
          }
        });
        var recId = result.id;
        if (recId) hasRecordId = true;
        rows.push({
          cells: cells,
          recordType: result.recordType || savedSearch.searchType,
          recordId: recId,
          entityId: entityId,
        });
      }
      return count < 1000;
    });

    if (!hasRecordId && entityCol !== -1 && rows.length) {
      var firstId = "";
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].entityId) {
          firstId = rows[i].entityId;
          break;
        }
      }
      if (firstId) {
        var entityType = resolveEntityType(firstId);
        if (entityType) {
          rows.forEach(function (row) {
            if (row.entityId) {
              row.recordType = entityType;
              row.recordId = row.entityId;
            }
          });
        }
      }
    }

    rows.forEach(function (row) {
      delete row.entityId;
    });

    var html = "<table><thead><tr>";
    headers.forEach(function (h) {
      html += "<th>" + escapeHtml(h) + "</th>";
    });
    html += "</tr></thead><tbody>";
    rows.forEach(function (row) {
      html += "<tr>";
      row.cells.forEach(function (cell, idx) {
        if (idx === 0 && row.recordId) {
          html +=
            "<td>" +
            buildRecordLink(cell, row.recordType, row.recordId) +
            "</td>";
        } else {
          html += "<td>" + escapeHtml(cell) + "</td>";
        }
      });
      html += "</tr>";
    });
    html += "</tbody></table>";

    return {
      html: html,
      title: savedSearch.title || "",
      rowCount: count,
      previewCount: rows.length,
    };
  };

  const renderPage = (context) => {
    var params = context.request.parameters;
    var initialSearchId = params.searchId || "";
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
      searchId: initialSearchId,
    };

    var form = serverWidget.createForm({ title: "Search Insight" });
    var htmlField = form.addField({
      id: "custpage_search_insight_html",
      type: serverWidget.FieldType.INLINEHTML,
      label: " ",
    });
    htmlField.defaultValue =
      "<script>window.__SEARCH_INSIGHT_BOOTSTRAP__ = " +
      JSON.stringify(bootstrap) +
      ";</script>\n" +
      loadHtml(HTML_PATH);

    context.response.writePage(form);
  };

  const handlePost = (context) => {
    var currentUser = runtime.getCurrentUser();
    var body = JSON.parse(context.request.body || "{}");
    var searchId = body.searchId;
    var question = body.question || "";
    var historyJson = typeof body.history === "string" ? body.history : "";
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

    if (!searchId) {
      sendJson(context, { success: false, error: "Search ID is required." });
      return;
    }

    var searchTitle = "";
    try {
      var s = search.load({ id: searchId });
      searchTitle = s.title || s.id || "";
    } catch (e) {
      /* ignore */
    }

    var jobRecord = record.create({ type: JOB.type, isDynamic: false });
    jobRecord.setValue({ fieldId: JOB.fields.user, value: currentUser.id });
    jobRecord.setValue({ fieldId: JOB.fields.searchId, value: searchId });
    jobRecord.setValue({ fieldId: JOB.fields.searchTitle, value: searchTitle });
    jobRecord.setValue({ fieldId: JOB.fields.question, value: question });
    if (historyJson) {
      jobRecord.setValue({ fieldId: JOB.fields.history, value: historyJson });
    }
    if (providerId) {
      jobRecord.setValue({ fieldId: JOB.fields.provider, value: providerId });
    }
    if (modelId) {
      jobRecord.setValue({ fieldId: JOB.fields.model, value: modelId });
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
        ? formatInsightResult(jr.getValue({ fieldId: JOB.fields.result }) || "")
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
        // log.debug("P1 in GET", context.request.parameters);
        var api = context.request.parameters.searchInsightApi;
        if (api === "jobStatus") {
          getJobStatus(context);
          return;
        }
        if (api === "searches") {
          sendJson(context, {
            success: true,
            searches: getSavedSearchList(),
          });
          return;
        }
        if (api === "preview") {
          var sid = context.request.parameters.searchId;
          if (!sid) {
            sendJson(context, {
              success: false,
              error: "Search ID is required.",
            });
            return;
          }
          sendJson(context, {
            success: true,
            ...getSearchPreview(sid),
          });
          return;
        }
        renderPage(context);
        return;
      }
      handlePost(context);
    } catch (err) {
      log.error({ title: "Search Insight failure", details: err });
      sendJson(context, {
        success: false,
        error: err.message || "Failed to process the request.",
      });
    }
  };

  return { onRequest };
});

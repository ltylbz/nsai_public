/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Search Insight job processor — runs the saved search referenced on
 * customrecord_search_insight_job, formats results as a CSV-style table,
 * sends it to the LLM with the user question, and writes the narrative
 * answer (with [[record links]]) back onto the job.
 */
define([
  "N/record",
  "N/search",
  "N/file",
  "./lib/search_insight_lib_llm",
  "./lib/search_insight_lib_records",
], (record, search, file, llm, R) => {
  const JOB = R.job;
  const PROMPT_PATH = "./metadata/pmpt_search_insight_001.json";
  const NS_TYPES_PATH = "./metadata/ns_types.json";
  const MAX_ROWS = 1000;

  const STATUS = {
    QUEUED: "queued",
    PROCESSING: "processing",
    COMPLETED: "completed",
    FAILED: "failed",
  };

  /**
   * Parse JSON file content, tolerating a UTF-8 BOM (U+FEFF) that some editors
   * inject when saving on Windows. JSON.parse rejects a leading BOM, but
   * `file.getContents()` returns the raw bytes including it, so strip it here.
   */
  const parseJsonContents = (text) => {
    var s = String(text || "");
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return JSON.parse(s);
  };

  const updateProgress = (jobId, step) => {
    try {
      record.submitFields({
        type: JOB.type,
        id: jobId,
        values: { [JOB.fields.error]: step },
      });
    } catch (e) {
      /* ignore */
    }
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
        closeAll();
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

      var olm = tr.match(/^\d+[.)]\s+(.+)$/);
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
        out.push("<li>" + fmt(olm[1]) + "</li>");
        continue;
      }

      closeLists();
      closeTbl();
      pBuf.push(fmt(tr));
    }
    closeAll();
    return out.join("\n");
  };

  const claimJob = (jobId) => {
    try {
      var jr = record.load({ type: JOB.type, id: jobId, isDynamic: false });
      if (jr.getValue({ fieldId: JOB.fields.status }) !== STATUS.QUEUED)
        return null;

      record.submitFields({
        type: JOB.type,
        id: jobId,
        values: {
          [JOB.fields.status]: STATUS.PROCESSING,
          [JOB.fields.error]: "",
        },
      });

      return {
        id: jobId,
        userId: jr.getValue({ fieldId: JOB.fields.user }),
        searchId: jr.getValue({ fieldId: JOB.fields.searchId }),
        searchTitle: jr.getValue({ fieldId: JOB.fields.searchTitle }),
        providerId: jr.getValue({ fieldId: JOB.fields.provider }),
        modelId: jr.getValue({ fieldId: JOB.fields.model }),
        question: jr.getValue({ fieldId: JOB.fields.question }) || "",
        history: jr.getValue({ fieldId: JOB.fields.history }) || "",
      };
    } catch (err) {
      var errText = err && (err.name || err.message);
      if (/RCRD_HAS_BEEN_CHANGED|record has been changed/i.test(errText))
        return null;
      throw err;
    }
  };

  const loadTypeLookup = () => {
    var types = parseJsonContents(
      file.load({ id: NS_TYPES_PATH }).getContents(),
    );
    var lookup = {};
    types.forEach(function (t) {
      if (t.searchTypeId && t.recordTypeId) {
        lookup[t.searchTypeId] = t.recordTypeId;
      }
    });
    return lookup;
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

  const runSavedSearch = (searchId) => {
    var typeLookup = loadTypeLookup();
    var savedSearch = search.load({ id: searchId });
    var columns = savedSearch.columns;
    var headers = columns.map(function (col) {
      return col.label || col.name || String(col);
    });

    var refCols = [];
    columns.forEach(function (col, idx) {
      var colName = col.name || "";
      if (typeLookup[colName]) {
        refCols.push({ index: idx, recordTypeId: typeLookup[colName] });
      }
    });

    var rows = [];
    var hasRecordId = false;
    var dynamicCandidates = {};

    savedSearch.run().each(function (result) {
      var row = {};
      columns.forEach(function (col, idx) {
        var text = result.getText(col);
        var value = result.getValue(col);
        row[headers[idx]] = text || value;
        if (text && value && text !== value && /^\d+$/.test(String(value))) {
          var isRef = refCols.some(function (r) {
            return r.index === idx;
          });
          if (!isRef) {
            row["_dyn_" + idx] = value;
            if (!(idx in dynamicCandidates)) {
              dynamicCandidates[idx] = value;
            }
          }
        }
      });

      refCols.forEach(function (ref) {
        var col = columns[ref.index];
        var text = result.getText(col);
        var value = result.getValue(col);
        if (text && value && text !== value && /^\d+$/.test(String(value))) {
          row["_ref_" + ref.index + "_type"] = ref.recordTypeId;
          row["_ref_" + ref.index + "_id"] = value;
        }
      });

      var recId = result.id;
      if (recId) {
        hasRecordId = true;
        row._recordType = result.recordType || savedSearch.searchType;
        row._recordId = recId;
      }

      rows.push(row);
      return rows.length < MAX_ROWS;
    });

    var dynIdxs = Object.keys(dynamicCandidates);
    for (var di = 0; di < dynIdxs.length; di++) {
      var dIdx = Number(dynIdxs[di]);
      var resolvedType = resolveEntityType(dynamicCandidates[dIdx]);
      if (resolvedType) {
        refCols.push({ index: dIdx, recordTypeId: resolvedType });
        rows.forEach(function (row) {
          if (row["_dyn_" + dIdx]) {
            row["_ref_" + dIdx + "_type"] = resolvedType;
            row["_ref_" + dIdx + "_id"] = row["_dyn_" + dIdx];
          }
        });
      }
    }

    if (!hasRecordId && rows.length) {
      for (var ei = 0; ei < refCols.length; ei++) {
        var eType = refCols[ei].recordTypeId;
        if (
          eType === "customer" ||
          eType === "vendor" ||
          eType === "employee"
        ) {
          var eIdx = refCols[ei].index;
          rows.forEach(function (row) {
            if (row["_ref_" + eIdx + "_id"]) {
              row._recordType = eType;
              row._recordId = row["_ref_" + eIdx + "_id"];
            }
          });
          break;
        }
      }
    }

    rows.forEach(function (row) {
      var keys = Object.keys(row);
      for (var ki = 0; ki < keys.length; ki++) {
        if (keys[ki].indexOf("_dyn_") === 0) delete row[keys[ki]];
      }
    });

    return {
      headers: headers,
      rows: rows,
      searchTitle: savedSearch.title,
      refCols: refCols,
    };
  };

  const csvEscape = (v) => {
    var s = String(v == null ? "" : v);
    if (
      s.indexOf(",") !== -1 ||
      s.indexOf('"') !== -1 ||
      s.indexOf("\n") !== -1
    )
      return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };

  const buildLlmTable = (headers, rows, refCols) => {
    var allHeaders = headers.slice();
    refCols.forEach(function (ref) {
      allHeaders.push(headers[ref.index] + "_recordType");
      allHeaders.push(headers[ref.index] + "_recordId");
    });
    allHeaders.push("recordType");
    allHeaders.push("recordId");

    var lines = [allHeaders.map(csvEscape).join(",")];
    rows.forEach(function (row) {
      var cells = headers.map(function (h) {
        return csvEscape(row[h]);
      });
      refCols.forEach(function (ref) {
        cells.push(csvEscape(row["_ref_" + ref.index + "_type"]));
        cells.push(csvEscape(row["_ref_" + ref.index + "_id"]));
      });
      cells.push(csvEscape(row._recordType));
      cells.push(csvEscape(row._recordId));
      lines.push(cells.join(","));
    });

    return lines.join("\n");
  };

  const loadPrompt = () => {
    var f = file.load({ id: PROMPT_PATH });
    return parseJsonContents(f.getContents());
  };

  const buildInsightMessages = (
    prompt,
    searchTitle,
    tableText,
    focusQuestion,
  ) => {
    var userMsg = prompt.user
      .replace("{{searchTitle}}", searchTitle || "")
      .replace("{{tableData}}", tableText);
    var fq = String(focusQuestion || "").replace(/^\s+|\s+$/g, "");
    if (fq) {
      userMsg +=
        "\n\nUser requested focus (address explicitly in your analysis): " + fq;
    }
    return [
      { role: "system", content: prompt.system },
      { role: "user", content: userMsg },
    ];
  };

  const buildFollowUpMessages = (
    prompt,
    searchTitle,
    tableText,
    question,
    historyJson,
  ) => {
    var chatHistory = [];
    try {
      chatHistory = JSON.parse(historyJson);
    } catch (e) {
      /* ignore */
    }

    var systemContent =
      prompt.system +
      "\n\nYou are answering a follow-up question about the saved search data below." +
      "\nSaved search: " +
      (searchTitle || "(untitled)") +
      "\n\nData (CSV):\n" +
      tableText;

    var messages = [{ role: "system", content: systemContent }];

    if (Array.isArray(chatHistory)) {
      chatHistory.forEach(function (entry) {
        if (entry.role && entry.content) {
          messages.push({ role: entry.role, content: entry.content });
        }
      });
    }

    messages.push({ role: "user", content: question });
    return messages;
  };

  return {
    getInputData: function () {
      var inputSearch = search.create({
        type: JOB.type,
        filters: [[JOB.fields.status, "is", STATUS.QUEUED]],
        columns: [
          search.createColumn({ name: "created", sort: search.Sort.ASC }),
          search.createColumn({ name: "internalid" }),
        ],
      });
      return inputSearch;
    },

    map: function (context) {
      var jobId = context.key;
      if (!jobId) return;

      var job = claimJob(jobId);
      if (!job) return;

      if (!job.searchId) {
        record.submitFields({
          type: JOB.type,
          id: jobId,
          values: {
            [JOB.fields.status]: STATUS.FAILED,
            [JOB.fields.error]: "Missing saved search ID.",
          },
        });
        return;
      }

      try {
        updateProgress(jobId, "Getting AI credentials...");
        var prompt = loadPrompt();

        updateProgress(jobId, "Loading saved search data...");
        var data = runSavedSearch(job.searchId);

        updateProgress(
          jobId,
          "Preparing data (" + data.rows.length + " rows)...",
        );
        var llmTable = buildLlmTable(data.headers, data.rows, data.refCols);

        var messages;
        var historyHasEntries = false;
        try {
          var hp = JSON.parse(job.history || "[]");
          historyHasEntries = Array.isArray(hp) && hp.length > 0;
        } catch (eHist) {
          historyHasEntries = false;
        }
        var isFollowUp = historyHasEntries;

        if (isFollowUp) {
          if (!job.question) {
            record.submitFields({
              type: JOB.type,
              id: jobId,
              values: {
                [JOB.fields.status]: STATUS.FAILED,
                [JOB.fields.error]: "Follow-up job is missing a question.",
              },
            });
            return;
          }
          updateProgress(jobId, "Sending follow-up question to AI...");
          messages = buildFollowUpMessages(
            prompt,
            data.searchTitle || job.searchTitle,
            llmTable,
            job.question,
            job.history,
          );
        } else {
          updateProgress(jobId, "Sending to AI for analysis...");
          messages = buildInsightMessages(
            prompt,
            data.searchTitle || job.searchTitle,
            llmTable,
            job.question,
          );
        }

        var llmCall = llm.callLLM(messages, {
          temperature: 0.5,
          title: "Search Insight",
          providerRecordId: job.providerId,
          model: job.modelId,
        });

        var pipeline = llmCall.then(function (replyText) {
          updateProgress(jobId, "AI replied, converting to readable format...");
          var resultHtml =
            '<div class="nai-insight-analysis">' +
            markdownToHtml(replyText) +
            "</div>";

          record.submitFields({
            type: JOB.type,
            id: jobId,
            values: {
              [JOB.fields.status]: STATUS.COMPLETED,
              [JOB.fields.result]: resultHtml,
              [JOB.fields.error]: "",
            },
          });
        });

        var pipelineCatch = pipeline.catch(function (err) {
          log.error({
            title: "Search Insight failed",
            details: {
              jobId: jobId,
              message: err.message,
              stack: err.stack,
            },
          });
          record.submitFields({
            type: JOB.type,
            id: jobId,
            values: {
              [JOB.fields.status]: STATUS.FAILED,
              [JOB.fields.error]: err.message || "Insight processing failed.",
            },
          });
        });
        return pipelineCatch;
      } catch (err) {
        log.error({
          title: "Search Insight failed",
          details: {
            jobId: jobId,
            message: err.message,
            stack: err.stack,
          },
        });
        record.submitFields({
          type: JOB.type,
          id: jobId,
          values: {
            [JOB.fields.status]: STATUS.FAILED,
            [JOB.fields.error]: err.message || "Insight processing failed.",
          },
        });
      }
    },

    summarize: function (summary) {
      if (summary.inputSummary.error) {
        log.error({
          title: "Search Insight summarize error",
          details: summary.inputSummary.error,
        });
        return;
      }
      log.audit({
        title: "Search Insight summarize",
        details:
          "Queued: " +
          Number(summary.inputSummary.totalKeys || 0) +
          ". Map errors: " +
          Number(summary.mapSummary.errorCount || 0) +
          ".",
      });
    },
  };
});

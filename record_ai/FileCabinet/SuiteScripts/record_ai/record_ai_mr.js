/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Record AI job processor — picks up queued customrecord_record_ai_job rows,
 * loads the target record, builds the prompt with cached memory + record JSON,
 * sends it to the LLM with the user's chosen parameters, and writes the answer
 * back onto the job.
 */
define([
  "N/record",
  "N/search",
  "N/file",
  "N/query",
  "./lib/record_ai_lib_llm",
  "./lib/record_ai_lib_records",
], (record, search, file, query, llm, R) => {
  const JOB = R.job;
  const PROMPT_PATH = "./metadata/pmpt_record_ai_001.json";
  const LOG_FOLDER_PATH = "/SuiteScripts/record_ai/logs/";

  const STATUS = {
    QUEUED: "queued",
    PROCESSING: "processing",
    COMPLETED: "completed",
    FAILED: "failed",
  };

  /**
   * Record types whose `internalid` matches `Transaction.entity`. For these we
   * fetch related transaction history (headers + lines + GL impact) via SuiteQL
   * and feed it to the LLM alongside the record JSON. Contacts and partners
   * are intentionally excluded — they don't appear as `Transaction.entity`.
   */
  const ENTITY_RECORD_TYPES = {
    customer: true,
    lead: true,
    prospect: true,
    vendor: true,
    employee: true,
  };

  const TXN_MAX_HEADERS = 50;
  const TXN_MAX_LINES = 300;

  const isEntityRecordType = (recordType) =>
    !!ENTITY_RECORD_TYPES[String(recordType || "").toLowerCase()];

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
        recordType: jr.getValue({ fieldId: JOB.fields.recordType }),
        recordId: jr.getValue({ fieldId: JOB.fields.recordId }),
        providerId: jr.getValue({ fieldId: JOB.fields.provider }),
        modelId: jr.getValue({ fieldId: JOB.fields.model }),
        params: jr.getValue({ fieldId: JOB.fields.params }) || "",
        question: jr.getValue({ fieldId: JOB.fields.question }),
        history: jr.getValue({ fieldId: JOB.fields.history }) || "[]",
      };
    } catch (err) {
      var errText = err && (err.name || err.message);
      if (/RCRD_HAS_BEEN_CHANGED|record has been changed/i.test(errText))
        return null;
      throw err;
    }
  };

  const loadRecordAsJson = (recType, recId) => {
    // log.debug(
    //   "point 5 in mr loadRecordAsJson",
    //   `recType=${recType}, recId=${recId}`,
    // );
    var rec = record.load({ type: recType, id: recId, isDynamic: false });
    var obj = { _type: recType, _id: recId };

    var fields = rec.getFields();
    // log.debug("point 6 in mr loadRecordAsJson", `field count=${fields.length}`);
    for (var i = 0; i < fields.length; i++) {
      var fid = fields[i];
      if (/^sys_/i.test(fid)) continue;
      var val = rec.getValue({ fieldId: fid });
      if (val == null || val === "" || val === false) continue;
      var text = "";
      try {
        text = rec.getText({ fieldId: fid });
      } catch (e) {
        /* unsupported */
      }
      obj[fid] = text && text !== String(val) ? text + " (" + val + ")" : val;
    }

    var sublists = rec.getSublists();
    // log.debug(
    //   "point 7 in mr loadRecordAsJson",
    //   `sublist count=${sublists.length}, sublists=${sublists.join(",")}`,
    // );
    for (var s = 0; s < sublists.length; s++) {
      var slId = sublists[s];
      var lineCount = rec.getLineCount({ sublistId: slId });
      if (lineCount <= 0) continue;
      var slFields = rec.getSublistFields({ sublistId: slId });
      if (!slFields || !slFields.length) continue;
      // log.debug(
      //   "point 8 in mr loadRecordAsJson",
      //   `sublist=${slId}, lineCount=${lineCount}, fieldCount=${slFields.length}`,
      // );
      var lines = [];
      for (var ln = 0; ln < lineCount; ln++) {
        var lineObj = {};
        for (var f = 0; f < slFields.length; f++) {
          var sfid = slFields[f];
          var sv = rec.getSublistValue({
            sublistId: slId,
            fieldId: sfid,
            line: ln,
          });
          if (sv == null || sv === "" || sv === false) continue;
          var st = "";
          try {
            st = rec.getSublistText({
              sublistId: slId,
              fieldId: sfid,
              line: ln,
            });
          } catch (e) {
            /* unsupported */
          }
          lineObj[sfid] = st && st !== String(sv) ? st + " (" + sv + ")" : sv;
        }
        if (Object.keys(lineObj).length) lines.push(lineObj);
      }
      if (lines.length) obj["_sublist_" + slId] = lines;
    }

    var jsonSize = JSON.stringify(obj).length;
    // log.debug(
    //   "point 9 in mr loadRecordAsJson",
    //   `done, body fields=${Object.keys(obj).length}, jsonSize=${jsonSize}`,
    // );
    return obj;
  };

  const loadPrompt = () => {
    // log.debug("point 10 in mr loadPrompt", `path=${PROMPT_PATH}`);
    var prompt = parseJsonContents(
      file.load({ id: PROMPT_PATH }).getContents(),
    );
    // log.debug(
    //   "point 11 in mr loadPrompt",
    //   `systemLength=${prompt.system.length}, userTemplateLength=${prompt.user.length}`,
    // );
    return prompt;
  };

  const formatNum = (v) => {
    if (v == null || v === "") return "";
    var n = Number(v);
    if (isNaN(n)) return String(v);
    return n.toFixed(2);
  };

  const csvSafe = (v) => {
    var s = String(v == null ? "" : v).replace(/[\r\n]+/g, " ");
    if (s.indexOf(",") !== -1 || s.indexOf('"') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  /**
   * For entity records (customer / lead / prospect / vendor / employee),
   * fetch transaction history via SuiteQL: header summary, line details, and GL impact.
   * Returns null on non-entity records or unrecoverable errors so the rest of the pipeline
   * runs without transaction context. Each query is wrapped in its own try/catch so a
   * missing column (e.g. `taxrate1` on accounts without per-line tax) only drops that piece.
   */
  const loadEntityTransactions = (recordType, recordId) => {
    if (!isEntityRecordType(recordType)) return null;
    var entityId = Number(recordId);
    if (!entityId) return null;

    var headers = [];
    var lines = [];
    var glImpact = [];

    // `Transaction.subsidiary` is NOT_EXPOSED for the SuiteQL SEARCH channel
    // in some accounts (per doc/tricks.md). Try the full header query first,
    // then fall back to a minimal version that drops subsidiary so the rest
    // of the analysis still works.
    var headerSqlFull =
      "SELECT t.id, t.tranid, t.type, BUILTIN.DF(t.type) AS type_name, " +
      "TO_CHAR(t.trandate, 'YYYY-MM-DD') AS trandate, " +
      "t.status, BUILTIN.DF(t.status) AS status_name, " +
      "t.subsidiary, BUILTIN.DF(t.subsidiary) AS subsidiary_name, " +
      "t.currency, BUILTIN.DF(t.currency) AS currency_name, " +
      "t.foreigntotal AS total_amount " +
      "FROM Transaction t " +
      "WHERE t.entity = " +
      entityId +
      " " +
      "ORDER BY t.trandate DESC, t.id DESC " +
      "FETCH FIRST " +
      TXN_MAX_HEADERS +
      " ROWS ONLY";
    var headerSqlMin =
      "SELECT t.id, t.tranid, t.type, BUILTIN.DF(t.type) AS type_name, " +
      "TO_CHAR(t.trandate, 'YYYY-MM-DD') AS trandate, " +
      "t.status, BUILTIN.DF(t.status) AS status_name, " +
      "t.currency, BUILTIN.DF(t.currency) AS currency_name, " +
      "t.foreigntotal AS total_amount " +
      "FROM Transaction t " +
      "WHERE t.entity = " +
      entityId +
      " " +
      "ORDER BY t.trandate DESC, t.id DESC " +
      "FETCH FIRST " +
      TXN_MAX_HEADERS +
      " ROWS ONLY";
    var headerSqlUsed = headerSqlFull;

    try {
      headers =
        query.runSuiteQL({ query: headerSqlFull }).asMappedResults() || [];
    } catch (e1) {
      log.audit({
        title: "Record AI header query fell back (likely NOT_EXPOSED column)",
        details: { message: e1.message },
      });
      try {
        headers =
          query.runSuiteQL({ query: headerSqlMin }).asMappedResults() || [];
        headerSqlUsed = headerSqlMin;
      } catch (e2) {
        log.error({
          title: "Record AI entity txn header query failed",
          details: {
            recordType: recordType,
            recordId: recordId,
            entityId: entityId,
            sqlFull: headerSqlFull,
            sqlMin: headerSqlMin,
            firstError: e1.message,
            secondError: e2.message,
          },
        });
        return null;
      }
    }

    log.audit({
      title: "Record AI entity txn header query",
      details: {
        recordType: recordType,
        recordId: recordId,
        entityId: entityId,
        rowCount: headers.length,
        sql: headerSqlUsed,
      },
    });

    if (!headers.length) {
      return { headers: [], lines: [], gl: [] };
    }

    var txnIds = headers
      .map(function (h) {
        return Number(h.id) || 0;
      })
      .filter(function (n) {
        return n > 0;
      });
    if (!txnIds.length) {
      return { headers: headers, lines: [], gl: [] };
    }
    var inList = txnIds.join(",");

    var lineSqlFull =
      "SELECT tl.transaction, tl.linesequencenumber, " +
      "tl.item, BUILTIN.DF(tl.item) AS item_name, " +
      "tl.expenseaccount, BUILTIN.DF(tl.expenseaccount) AS expense_name, " +
      "tl.quantity, tl.netamount AS line_amount, " +
      "tl.taxrate1 AS tax_rate, tl.taxamount AS tax_amount, " +
      "tl.memo " +
      "FROM TransactionLine tl " +
      "WHERE tl.transaction IN (" +
      inList +
      ") " +
      "AND tl.mainline = 'F' AND tl.taxline = 'F' " +
      "ORDER BY tl.transaction DESC, tl.linesequencenumber ASC " +
      "FETCH FIRST " +
      TXN_MAX_LINES +
      " ROWS ONLY";
    var lineSqlMin =
      "SELECT tl.transaction, tl.linesequencenumber, " +
      "tl.item, BUILTIN.DF(tl.item) AS item_name, " +
      "tl.expenseaccount, BUILTIN.DF(tl.expenseaccount) AS expense_name, " +
      "tl.quantity, tl.netamount AS line_amount, tl.memo " +
      "FROM TransactionLine tl " +
      "WHERE tl.transaction IN (" +
      inList +
      ") " +
      "AND tl.mainline = 'F' AND tl.taxline = 'F' " +
      "ORDER BY tl.transaction DESC, tl.linesequencenumber ASC " +
      "FETCH FIRST " +
      TXN_MAX_LINES +
      " ROWS ONLY";

    var hasTaxColumns = true;
    try {
      lines = query.runSuiteQL({ query: lineSqlFull }).asMappedResults() || [];
    } catch (e1) {
      hasTaxColumns = false;
      try {
        lines = query.runSuiteQL({ query: lineSqlMin }).asMappedResults() || [];
        log.audit({
          title: "Record AI line query fell back without tax columns",
          details:
            "Tax columns (taxrate1 / taxamount) are NOT_EXPOSED or REMOVED " +
            "for TransactionLine in this account. Continuing without tax data. " +
            "Original error: " +
            e1.message,
        });
      } catch (e2) {
        log.error({
          title: "Record AI line query failed",
          details: e2.message,
        });
      }
    }

    try {
      var glSql =
        "SELECT tal.transaction, " +
        "tal.account, BUILTIN.DF(tal.account) AS account_name, " +
        "SUM(tal.debit) AS debit_total, SUM(tal.credit) AS credit_total " +
        "FROM TransactionAccountingLine tal " +
        "WHERE tal.transaction IN (" +
        inList +
        ") AND tal.posting = 'T' " +
        "GROUP BY tal.transaction, tal.account, BUILTIN.DF(tal.account) " +
        "ORDER BY tal.transaction DESC";
      glImpact = query.runSuiteQL({ query: glSql }).asMappedResults() || [];
    } catch (e) {
      log.audit({
        title: "Record AI GL impact query failed (non-fatal)",
        details: e.message,
      });
    }

    return {
      headers: headers,
      lines: lines,
      gl: glImpact,
      hasTaxColumns: hasTaxColumns,
    };
  };

  const formatTransactionsContext = (txnData) => {
    if (!txnData) return "";
    var headers = txnData.headers || [];
    if (!headers.length) {
      return "Related Transactions: none found for this entity.\n\n";
    }

    var sections = [];
    sections.push(
      "Related Transactions for this entity (most recent " +
        headers.length +
        " of up to " +
        TXN_MAX_HEADERS +
        "):",
    );

    var headerCols = [
      "id",
      "tranid",
      "type",
      "date",
      "status",
      "subsidiary",
      "currency",
      "total_amount",
    ];
    var headerLines = [headerCols.map(csvSafe).join(",")];
    headers.forEach(function (h) {
      headerLines.push(
        [
          h.id || "",
          h.tranid || "",
          h.type_name || h.type || "",
          h.trandate || "",
          h.status_name || h.status || "",
          h.subsidiary_name || "",
          h.currency_name || h.currency || "",
          formatNum(h.total_amount),
        ]
          .map(csvSafe)
          .join(","),
      );
    });
    sections.push("Headers (CSV):\n" + headerLines.join("\n"));

    var lines = txnData.lines || [];
    if (lines.length) {
      var includeTax = txnData.hasTaxColumns !== false;
      var lineCols = includeTax
        ? [
            "transaction",
            "line_no",
            "item",
            "expense_account",
            "quantity",
            "line_amount",
            "tax_rate",
            "tax_amount",
            "memo",
          ]
        : [
            "transaction",
            "line_no",
            "item",
            "expense_account",
            "quantity",
            "line_amount",
            "memo",
          ];
      var lineRows = [lineCols.map(csvSafe).join(",")];
      lines.forEach(function (l) {
        var row = [
          l.transaction || "",
          l.linesequencenumber || "",
          l.item_name || l.item || "",
          l.expense_name || l.expenseaccount || "",
          l.quantity || "",
          formatNum(l.line_amount),
        ];
        if (includeTax) {
          row.push(formatNum(l.tax_rate));
          row.push(formatNum(l.tax_amount));
        }
        row.push(l.memo || "");
        lineRows.push(row.map(csvSafe).join(","));
      });
      sections.push(
        "Lines (CSV)" +
          (includeTax ? "" : " — tax columns unavailable on this account") +
          ":\n" +
          lineRows.join("\n"),
      );
    }

    var gl = txnData.gl || [];
    if (gl.length) {
      var glCols = ["transaction", "account", "debit_total", "credit_total"];
      var glRows = [glCols.map(csvSafe).join(",")];
      gl.forEach(function (g) {
        glRows.push(
          [
            g.transaction || "",
            g.account_name || g.account || "",
            formatNum(g.debit_total),
            formatNum(g.credit_total),
          ]
            .map(csvSafe)
            .join(","),
        );
      });
      sections.push("GL Impact (CSV):\n" + glRows.join("\n"));
    }

    return sections.join("\n\n") + "\n\n";
  };

  const sanitizeKey = (value) => {
    var cleaned = String(value == null ? "" : value).replace(
      /[^A-Za-z0-9_-]/g,
      "_",
    );
    return cleaned || "na";
  };

  const csvEscape = (value) => {
    var txt = String(value == null ? "" : value);
    var escaped = txt.replace(/"/g, '""');
    return '"' + escaped + '"';
  };

  const parseCsvLine = (line) => {
    var cells = [];
    var current = "";
    var inQuote = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      var next = i + 1 < line.length ? line.charAt(i + 1) : "";
      if (ch === '"' && inQuote && next === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === "," && !inQuote) {
        cells.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    cells.push(current);
    return cells;
  };

  const isMissingFileError = (err) => {
    var text =
      String((err && err.name) || "") +
      " " +
      String((err && err.message) || "");
    return /RCRD_DSNT_EXIST|does not exist|FILE_DOES_NOT_EXIST|not exist/i.test(
      text,
    );
  };

  const getFolderByName = (name, parentId) => {
    var filters = [["name", "is", name], "AND", ["isinactive", "is", "F"]];
    if (parentId) {
      filters.push("AND");
      filters.push(["parent", "anyof", parentId]);
    }
    var rows = search
      .create({
        type: search.Type.FOLDER,
        filters: filters,
        columns: [search.createColumn({ name: "internalid" })],
      })
      .run()
      .getRange({ start: 0, end: 1 });
    if (!rows || !rows.length) return "";
    return rows[0].getValue({ name: "internalid" });
  };

  const createFolder = (name, parentId) => {
    var fd = record.create({ type: record.Type.FOLDER, isDynamic: false });
    fd.setValue({ fieldId: "name", value: name });
    if (parentId) {
      fd.setValue({ fieldId: "parent", value: parentId });
    }
    return fd.save();
  };

  const ensureLogFolder = () => {
    var suiteScriptsId = getFolderByName("SuiteScripts", "");
    if (!suiteScriptsId) {
      throw new Error("SuiteScripts folder not found.");
    }
    var recordAiRootId = getFolderByName("record_ai", suiteScriptsId);
    if (!recordAiRootId) {
      recordAiRootId = createFolder("record_ai", suiteScriptsId);
    }
    var logsId = getFolderByName("logs", recordAiRootId);
    if (!logsId) {
      logsId = createFolder("logs", recordAiRootId);
    }
    return logsId;
  };

  const buildFilePaths = (userId, recordType, recordId) => {
    var safeUser = sanitizeKey(userId);
    var safeType = sanitizeKey(recordType);
    var safeId = sanitizeKey(recordId);
    var detailPath =
      LOG_FOLDER_PATH +
      "ra_detail_" +
      safeUser +
      "_" +
      safeType +
      "_" +
      safeId +
      ".csv";
    var summaryPath =
      LOG_FOLDER_PATH +
      "ra_summary_" +
      safeUser +
      "_" +
      safeType +
      "_" +
      safeId +
      ".csv";
    var recordPath =
      LOG_FOLDER_PATH +
      "ra_record_" +
      safeUser +
      "_" +
      safeType +
      "_" +
      safeId +
      ".json";
    var txnPath =
      LOG_FOLDER_PATH +
      "ra_txn_" +
      safeUser +
      "_" +
      safeType +
      "_" +
      safeId +
      ".json";
    return {
      detailPath: detailPath,
      summaryPath: summaryPath,
      recordPath: recordPath,
      txnPath: txnPath,
    };
  };

  const loadFileText = (path) => {
    try {
      var loaded = file.load({ id: path });
      return { id: loaded.id, text: loaded.getContents() || "" };
    } catch (err) {
      if (isMissingFileError(err)) return null;
      throw err;
    }
  };

  const loadSummaryFile = (summaryPath) => {
    var loaded = loadFileText(summaryPath);
    if (!loaded || !loaded.text) return [];
    var lines = loaded.text.split(/\r?\n/).filter(function (line) {
      return !!line;
    });
    if (!lines.length) return [];
    var rows = [];
    for (var i = 1; i < lines.length; i++) {
      var cols = parseCsvLine(lines[i]);
      rows.push({
        id: cols[0] || "",
        question: cols[1] || "",
        summary: cols[2] || "",
      });
    }
    return rows;
  };

  const loadRecordCache = (recordPath) => {
    var loaded = loadFileText(recordPath);
    if (!loaded || !loaded.text) return null;
    return JSON.parse(loaded.text);
  };

  const loadTransactionCache = (txnPath) => {
    var loaded = loadFileText(txnPath);
    if (!loaded || !loaded.text) return null;
    try {
      return JSON.parse(loaded.text);
    } catch (e) {
      return null;
    }
  };

  const getDateYmd = () => {
    var now = new Date();
    var y = String(now.getFullYear());
    var m = String(now.getMonth() + 1).padStart(2, "0");
    var d = String(now.getDate()).padStart(2, "0");
    return y + m + d;
  };

  const nextSequence = (rows, idPrefix) => {
    var max = 0;
    for (var i = 0; i < rows.length; i++) {
      var id = String((rows[i] && rows[i].id) || "");
      if (id.indexOf(idPrefix) !== 0) continue;
      var seq = Number(id.slice(idPrefix.length));
      if (!isNaN(seq) && seq > max) max = seq;
    }
    return max + 1;
  };

  const buildConversationId = (userId, recordType, recordId, rows) => {
    var datePart = getDateYmd();
    var idPrefix =
      datePart +
      "_" +
      sanitizeKey(userId) +
      "_" +
      sanitizeKey(recordType) +
      "_" +
      sanitizeKey(recordId) +
      "_";
    var seq = String(nextSequence(rows, idPrefix)).padStart(3, "0");
    return idPrefix + seq;
  };

  const appendCsvRow = (path, headerLine, rowValues) => {
    var folderId = ensureLogFolder();
    var rowLine =
      rowValues
        .map(function (value) {
          return csvEscape(value);
        })
        .join(",") + "\n";
    var loaded = loadFileText(path);
    var nextContent = "";
    var fileName = path.split("/").pop();
    if (!loaded) {
      nextContent = headerLine + "\n" + rowLine;
    } else {
      nextContent = (loaded.text || "").replace(/\s*$/, "") + "\n" + rowLine;
      try {
        file.delete({ id: loaded.id });
      } catch (err) {
        if (!isMissingFileError(err)) throw err;
      }
    }
    var created = file.create({
      name: fileName,
      fileType: file.Type.CSV,
      contents: nextContent,
      folder: folderId,
      isOnline: false,
    });
    created.save();
  };

  const saveRecordCache = (recordPath, data) => {
    var folderId = ensureLogFolder();
    var loaded = loadFileText(recordPath);
    var fileName = recordPath.split("/").pop();
    if (loaded) {
      try {
        file.delete({ id: loaded.id });
      } catch (err) {
        if (!isMissingFileError(err)) throw err;
      }
    }
    var created = file.create({
      name: fileName,
      fileType: file.Type.PLAINTEXT,
      contents: JSON.stringify(data),
      folder: folderId,
      isOnline: false,
    });
    created.save();
  };

  const saveTransactionCache = (txnPath, data) => {
    saveRecordCache(txnPath, data);
  };

  const extractSummary = (answer) => {
    var source = String(answer == null ? "" : answer);
    var match = source.match(/\[\[SUMMARY:\s*([\s\S]*?)\]\]\s*$/);
    var summary = "";
    var displayAnswer = source;
    if (match) {
      summary = String(match[1] || "").trim();
      displayAnswer = source.replace(/\n?\s*\[\[SUMMARY:[\s\S]*?\]\]\s*$/, "");
    }
    if (!summary) {
      summary = source.replace(/\s+/g, " ").trim().slice(0, 160);
    }
    return {
      displayAnswer: displayAnswer,
      summary: summary,
    };
  };

  const buildSummaryContext = (summaryRows) => {
    if (!summaryRows || !summaryRows.length) return "";
    var lines = [];
    lines.push("Previous conversations about this record:");
    var start = Math.max(0, summaryRows.length - 20);
    for (var i = start; i < summaryRows.length; i++) {
      lines.push(
        "- [" +
          summaryRows[i].id +
          "] Q: " +
          summaryRows[i].question +
          " -> " +
          summaryRows[i].summary,
      );
    }
    return lines.join("\n") + "\n\n";
  };

  const buildMessages = (
    prompt,
    job,
    recordJson,
    summaryRows,
    transactionContext,
  ) => {
    // log.debug(
    //   "point 12 in mr buildMessages",
    //   `recordType=${job.recordType}, recordId=${job.recordId}`,
    // );
    var historyArr = [];
    try {
      historyArr = JSON.parse(job.history);
    } catch (e) {
      /* ignore */
    }
    // log.debug(
    //   "point 13 in mr buildMessages",
    //   `historyRounds=${historyArr.length}`,
    // );
    var historyText = "";
    for (var i = 0; i < historyArr.length; i++) {
      historyText +=
        "Q: " +
        historyArr[i].question +
        "\nA: " +
        historyArr[i].answer +
        "\n\n";
    }

    var userMsg = prompt.user
      .replace("{{recordType}}", job.recordType)
      .replace("{{recordId}}", job.recordId)
      .replace("{{recordJson}}", JSON.stringify(recordJson, null, 2))
      .replace("{{transactionContext}}", transactionContext || "")
      .replace("{{summaryContext}}", buildSummaryContext(summaryRows))
      .replace(
        "{{history}}",
        historyText ? "Previous conversation:\n" + historyText + "\n" : "",
      )
      .replace("{{question}}", job.question);

    var messages = [
      { role: "system", content: prompt.system },
      { role: "user", content: userMsg },
    ];
    // log.debug(
    //   "point 14 in mr buildMessages",
    //   `messageCount=${messages.length}, userMsgLength=${userMsg.length}`,
    // );
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

      if (!job.recordType || !job.recordId) {
        record.submitFields({
          type: JOB.type,
          id: jobId,
          values: {
            [JOB.fields.status]: STATUS.FAILED,
            [JOB.fields.error]: "Missing record type or ID.",
          },
        });
        return;
      }

      try {
        updateProgress(jobId, "Loading record data...");
        var filePaths = buildFilePaths(
          job.userId,
          job.recordType,
          job.recordId,
        );
        var recordJson = loadRecordCache(filePaths.recordPath);
        if (!recordJson) {
          recordJson = loadRecordAsJson(job.recordType, job.recordId);
          saveRecordCache(filePaths.recordPath, recordJson);
        }

        var transactionContext = "";
        if (isEntityRecordType(job.recordType)) {
          updateProgress(jobId, "Loading related transactions...");
          var txnData = loadTransactionCache(filePaths.txnPath);
          // Only trust the cache when it actually has rows. An empty result
          // (zero headers) is re-queried every turn so a transient miss or a
          // bad first attempt does not stick around for the whole session.
          var cacheHit = !!(
            txnData &&
            txnData.headers &&
            txnData.headers.length
          );
          if (!cacheHit) {
            txnData = loadEntityTransactions(job.recordType, job.recordId);
            if (txnData && txnData.headers && txnData.headers.length) {
              saveTransactionCache(filePaths.txnPath, txnData);
            }
          }
          transactionContext = formatTransactionsContext(txnData);
        }

        var summaryRows = loadSummaryFile(filePaths.summaryPath);
        var llmParams = {};
        try {
          llmParams = JSON.parse(job.params || "{}");
        } catch (e) {
          llmParams = {};
        }
        var temperature = Number(llmParams.temperature);
        if (isNaN(temperature)) temperature = 0.2;
        if (temperature < 0) temperature = 0;
        if (temperature > 1) temperature = 1;
        var topP = Number(llmParams.topP);
        if (isNaN(topP)) topP = 0.2;
        if (topP < 0) topP = 0;
        if (topP > 1) topP = 1;
        var topK = Math.floor(Number(llmParams.topK));
        if (isNaN(topK) || topK <= 1) topK = 3;
        var frequencyPenalty = Number(llmParams.frequencyPenalty);
        if (isNaN(frequencyPenalty)) frequencyPenalty = 0;
        if (frequencyPenalty < -2) frequencyPenalty = -2;
        if (frequencyPenalty > 2) frequencyPenalty = 2;

        updateProgress(jobId, "Preparing AI request...");
        var prompt = loadPrompt();
        var messages = buildMessages(
          prompt,
          job,
          recordJson,
          summaryRows,
          transactionContext,
        );
        var conversationId = buildConversationId(
          job.userId,
          job.recordType,
          job.recordId,
          summaryRows,
        );

        updateProgress(jobId, "Sent to AI, waiting for reply...");
        log.debug({
          title: "Record AI before LLM",
          details: {
            jobId: jobId,
            providerId: job.providerId,
            modelId: job.modelId,
            temperature: temperature,
            topP: topP,
            topK: topK,
            frequencyPenalty: frequencyPenalty,
            recordType: job.recordType,
            recordId: job.recordId,
            question: job.question,
            history: job.history,
            messageCount: messages.length,
            messages: messages,
          },
        });
        var llmCall = llm.callLLM(messages, {
          temperature: temperature,
          topP: topP,
          topK: topK,
          frequencyPenalty: frequencyPenalty,
          title: "Record AI",
          providerRecordId: job.providerId,
          model: job.modelId,
        });

        var pipeline = llmCall.then(function (answer) {
          log.debug({
            title: "Record AI after LLM",
            details: {
              jobId: jobId,
              answer: answer,
            },
          });
          var parsed = extractSummary(answer);
          appendCsvRow(filePaths.detailPath, "id,question,answer", [
            conversationId,
            job.question,
            parsed.displayAnswer,
          ]);
          appendCsvRow(filePaths.summaryPath, "id,question,summary", [
            conversationId,
            job.question,
            parsed.summary,
          ]);
          record.submitFields({
            type: JOB.type,
            id: jobId,
            values: {
              [JOB.fields.status]: STATUS.COMPLETED,
              [JOB.fields.result]: parsed.displayAnswer,
              [JOB.fields.error]: "",
            },
          });
        });

        var pipelineCatch = pipeline.catch(function (err) {
          log.error({
            title: "Record AI failed",
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
              [JOB.fields.error]: err.message || "Record AI processing failed.",
            },
          });
        });
        return pipelineCatch;
      } catch (err) {
        log.error({
          title: "Record AI failed",
          details: { jobId: jobId, message: err.message, stack: err.stack },
        });
        record.submitFields({
          type: JOB.type,
          id: jobId,
          values: {
            [JOB.fields.status]: STATUS.FAILED,
            [JOB.fields.error]: err.message || "Record AI processing failed.",
          },
        });
      }
    },

    summarize: function (summary) {
      if (summary.inputSummary.error) {
        log.error({
          title: "Record AI summarize error",
          details: summary.inputSummary.error,
        });
        return;
      }
      log.audit({
        title: "Record AI summarize",
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

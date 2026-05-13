/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 *
 * Record AI client glue — toggles the floating panel injected by the user
 * event script and tears down the iframe when the panel is closed.
 */
define(["N/url", "N/currentRecord"], (url, currentRecord) => {
  const closeRecordAiPanel = () => {
    var panel = document.getElementById("naiRaPanel");
    var iframe = document.getElementById("naiRaIframe");
    if (iframe) {
      iframe.src = "about:blank";
      iframe.removeAttribute("data-loaded");
    }
    if (panel) {
      panel.style.display = "none";
    }
  };

  const pageInit = () => {
    window.naiRaClosePanel = closeRecordAiPanel;
  };

  const openRecordAi = () => {
    var panel = document.getElementById("naiRaPanel");
    if (!panel) return;

    var isVisible = panel.style.display === "flex";
    if (isVisible) {
      closeRecordAiPanel();
      return;
    }

    var iframe = document.getElementById("naiRaIframe");
    if (iframe && !iframe.getAttribute("data-loaded")) {
      var rec = currentRecord.get();
      var slUrl = url.resolveScript({
        scriptId: "customscript_record_ai_sl",
        deploymentId: "customdeploy_record_ai_sl",
        returnExternalUrl: false,
      });
      slUrl += "&recordType=" + encodeURIComponent(rec.type);
      slUrl += "&recordId=" + encodeURIComponent(rec.id);
      iframe.src = slUrl;
      iframe.setAttribute("data-loaded", "1");
    }

    panel.style.display = "flex";
  };

  return { pageInit, openRecordAi, naiRaClosePanel: closeRecordAiPanel };
});

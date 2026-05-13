/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Injects the Record AI floating panel (movable/resizable iframe) and the
 * "Ask AI" toggle button onto every record VIEW page.
 */
define(["N/ui/serverWidget"], (serverWidget) => {
  const PANEL_HTML =
    "<style>" +
    ".nai-ra-panel{position:fixed;top:60px;right:20px;width:550px;height:520px;" +
    "min-width:320px;min-height:250px;" +
    "z-index:10000;background:#fff;box-shadow:0 4px 20px rgba(0,0,0,.25);border-radius:8px;" +
    "display:none;flex-direction:column;font-family:Arial,Helvetica,sans-serif;" +
    "resize:both;overflow:hidden}" +
    ".nai-ra-panel-hdr{display:flex;align-items:center;justify-content:space-between;" +
    "padding:8px 12px;background:#1565c0;color:#fff;font-size:14px;font-weight:600;" +
    "flex-shrink:0;cursor:move;user-select:none;border-radius:8px 8px 0 0}" +
    ".nai-ra-panel-close{background:none;border:none;color:#fff;font-size:20px;" +
    "cursor:pointer;padding:0 4px;line-height:1}" +
    ".nai-ra-panel iframe{flex:1;border:none;width:100%;border-radius:0 0 8px 8px}" +
    "</style>" +
    '<div id="naiRaPanel" class="nai-ra-panel">' +
    '<div class="nai-ra-panel-hdr" id="naiRaPanelHdr">' +
    "<span>Record AI</span>" +
    "<button class=\"nai-ra-panel-close\" onclick=\"if(window.naiRaClosePanel){window.naiRaClosePanel()}else{document.getElementById('naiRaPanel').style.display='none'}\">&times;</button>" +
    "</div>" +
    '<iframe id="naiRaIframe" src="about:blank"></iframe>' +
    "</div>" +
    "<script>(function(){" +
    "var hdr=document.getElementById('naiRaPanelHdr');" +
    "var panel=document.getElementById('naiRaPanel');" +
    "if(!hdr||!panel)return;" +
    "var ox=0,oy=0,sx=0,sy=0,dragging=false;" +
    "hdr.addEventListener('mousedown',function(e){" +
    "if(e.target.tagName==='BUTTON')return;" +
    "dragging=true;ox=e.clientX;oy=e.clientY;" +
    "sx=panel.offsetLeft;sy=panel.offsetTop;" +
    "e.preventDefault()});" +
    "document.addEventListener('mousemove',function(e){" +
    "if(!dragging)return;" +
    "var nx=sx+(e.clientX-ox);" +
    "var ny=sy+(e.clientY-oy);" +
    "if(nx<0)nx=0;if(ny<0)ny=0;" +
    "panel.style.left=nx+'px';panel.style.top=ny+'px';" +
    "panel.style.right='auto'});" +
    "document.addEventListener('mouseup',function(){dragging=false})" +
    "})()</script>";

  const beforeLoad = (context) => {
    if (context.type !== context.UserEventType.VIEW) return;

    context.form.clientScriptModulePath = "./record_ai_cs.js";
    context.form.addButton({
      id: "custpage_record_ai_ask_ai",
      label: "Ask AI",
      functionName: "openRecordAi",
    });

    var panelField = context.form.addField({
      id: "custpage_record_ai_panel",
      type: serverWidget.FieldType.INLINEHTML,
      label: " ",
    });
    panelField.defaultValue = PANEL_HTML;
  };

  return { beforeLoad };
});

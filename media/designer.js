(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const grid = 8;
  const defaults = {
    Form: [800, 500], Panel: [240, 160], Button: [120, 36], Label: [120, 24], TextBox: [180, 28],
    RichTextBox: [220, 120], CheckBox: [120, 24], RadioButton: [120, 24], ComboBox: [160, 28], ListBox: [160, 120],
    PictureBox: [160, 120], GroupBox: [240, 160], TabControl: [300, 200], DataGridView: [360, 200]
  };
  const controlTypes = ["Form", "Panel", "Button", "Label", "TextBox", "RichTextBox", "CheckBox", "RadioButton", "ComboBox", "ListBox", "PictureBox", "GroupBox", "TabControl", "DataGridView"];
  let documentModel = null;
  let selected = new Set();
  let history = [];
  let future = [];
  let clipboard = [];
  let projectName = "";
  let saveTimer = 0;
  let pointerAction = null;
  let previewMode = false;

  app.innerHTML = `
    <header class="toolbar">
      <span class="brand">WinForms Designer</span><span class="project-name" id="project-name"></span>
      <button class="tool-action preview-toggle" id="preview" title="Toggle interactive preview">▶</button>
      <button class="tool-action" id="run-native" title="Build and run the native Form">▷</button>
      <button class="tool-action" id="stop-native" title="Stop the Form" disabled>■</button>
      <button class="tool-action" id="undo" title="Undo (Ctrl+Z)">↶</button>
      <button class="tool-action" id="redo" title="Redo (Ctrl+Y)">↷</button>
      <span class="hint">Snap 8px</span>
    </header>
    <main class="layout">
      <aside class="sidebar leftbar">
        <div class="section-title">Toolbox</div><div class="tool-list" id="toolbox"></div>
        <div class="section-title">Document Outline</div><div class="tree" id="tree"></div>
      </aside>
      <section class="canvas-wrap" id="canvas-wrap"><div class="form-surface" id="form-surface"></div></section>
      <aside class="sidebar rightbar"><div class="section-title">Properties</div><div id="properties" class="properties"></div></aside>
    </main>
    <footer class="status" id="status"><span class="status-message" id="status-message">Loading designer...</span><span class="status-actions" id="conflict-actions" hidden><button id="reload-file">Reload</button><button id="overwrite-file">Save and overwrite</button></span><span id="status-size"></span></footer>`;

  const surface = document.getElementById("form-surface");
  const canvasWrap = document.getElementById("canvas-wrap");
  const toolbox = document.getElementById("toolbox");
  const tree = document.getElementById("tree");
  const properties = document.getElementById("properties");
  const status = document.getElementById("status");

  controlTypes.forEach(type => {
    const button = document.createElement("button");
    button.className = "tool";
    button.textContent = type;
    button.draggable = true;
    button.addEventListener("dragstart", event => event.dataTransfer?.setData("application/x-winforms-control", type));
    button.addEventListener("click", () => {
      if (type === "Form") {
        const root = documentModel?.controls.find(item => item.type === "Form");
        if (root) { selected = new Set([root.name]); render(); }
      } else addControl(type);
    });
    toolbox.append(button);
  });
  canvasWrap.addEventListener("dragover", event => { if (Array.from(event.dataTransfer?.types || []).includes("application/x-winforms-control")) event.preventDefault(); });
  canvasWrap.addEventListener("drop", event => {
    const type = event.dataTransfer?.getData("application/x-winforms-control");
    if (!type || type === "Form" || previewMode) return;
    event.preventDefault();
    const dropTarget = event.target instanceof Element ? event.target.closest(".control.panel, .control.groupbox, .control.tabcontrol") : null;
    const container = dropTarget ? find(dropTarget.dataset.name) : null;
    const bounds = (dropTarget || surface).getBoundingClientRect();
    addControl(type, null, { parent: container, location: { x: snap(event.clientX - bounds.left), y: snap(event.clientY - bounds.top) } });
  });

  window.addEventListener("message", event => {
    const message = event.data;
    if (message.type === "load") {
      clearTimeout(saveTimer);
      documentModel = message.document;
      projectName = message.project || "";
      document.getElementById("project-name").textContent = projectName;
      selected.clear(); render();
      const diagnostics = documentModel.diagnostics || [];
      document.getElementById("conflict-actions").hidden = true;
      setStatus(diagnostics.length ? diagnostics.join(" | ") : "Designer ready", diagnostics.length > 0);
    } else if (message.type === "conflict") {
      document.getElementById("conflict-actions").hidden = false;
      const detail = message.reason === "buffer"
        ? "The Designer.cs editor buffer has unsaved changes. Save it or confirm Save and overwrite."
        : "Designer.cs changed on disk. Reload it or confirm Save and overwrite.";
      setStatus(detail, true);
    } else if (message.type === "build") {
      const errors = message.errors || [];
      setStatus(errors.length ? errors.join(" | ") : "Project build succeeded", errors.length > 0);
    } else if (message.type === "native") {
      document.getElementById("run-native").disabled = !!message.running || !!message.building;
      document.getElementById("stop-native").disabled = !message.running;
      if (message.message) setStatus(message.message, false);
    } else if (message.type === "saved") {
      document.getElementById("conflict-actions").hidden = true;
      setStatus("All changes saved", false);
    }
    else if (message.type === "error") setStatus(message.message, true);
  });

  document.getElementById("undo").addEventListener("click", undo);
  document.getElementById("redo").addEventListener("click", redo);
  document.getElementById("run-native").addEventListener("click", () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; vscode.postMessage({ type: "save", document: documentModel }); }
    vscode.postMessage({ type: "run" });
  });
  document.getElementById("stop-native").addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  document.getElementById("reload-file").addEventListener("click", () => vscode.postMessage({ type: "reload" }));
  document.getElementById("overwrite-file").addEventListener("click", () => {
    document.getElementById("conflict-actions").hidden = true;
    vscode.postMessage({ type: "save", document: documentModel, force: true });
  });
  document.getElementById("preview").addEventListener("click", event => {
    previewMode = !previewMode; selected.clear();
    event.currentTarget.classList.toggle("active", previewMode);
    event.currentTarget.title = previewMode ? "Return to Designer" : "Toggle interactive preview";
    render();
  });
  document.addEventListener("keydown", onKeyDown);
  surface.addEventListener("pointermove", movePointer);
  surface.addEventListener("pointerup", endPointer);
  surface.addEventListener("pointercancel", endPointer);
  surface.addEventListener("click", event => { if (event.target === surface) { selected.clear(); render(); } });
  vscode.postMessage({ type: "ready" });

  function allControls() {
    const list = [];
    const visit = items => items.forEach(item => { list.push(item); visit(item.children || []); });
    visit(documentModel?.controls || []);
    return list;
  }
  function find(name) { return allControls().find(control => control.name === name); }
  function controlItems(control) {
    try { const items = JSON.parse(control.properties?.Items || "[]"); return Array.isArray(items) ? items.map(String) : []; }
    catch { return []; }
  }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
  function snap(value) { return Math.max(0, Math.round(value / grid) * grid); }
  function checkpoint() { history.push(JSON.stringify(documentModel)); if (history.length > 100) history.shift(); future = []; }
  function scheduleSave() {
    setStatus("Saving Designer.cs...", false);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => vscode.postMessage({ type: "save", document: documentModel }), 300);
  }
  function setStatus(message, error) { const item = document.getElementById("status-message"); item.textContent = message; item.title = message; status.classList.toggle("error", !!error); }
  function addControl(type, copy, placement) {
    if (!documentModel) return;
    checkpoint();
    const used = new Set(allControls().map(item => item.name));
    const nextName = controlType => { let index = 1; while (used.has(`${controlType.toLowerCase()}${index}`)) index++; const generated = `${controlType.toLowerCase()}${index}`; used.add(generated); return generated; };
    const name = nextName(type);
    const dims = defaults[type] || defaults.Button;
    const form = documentModel.controls.find(item => item.type === "Form");
    const parent = placement?.parent || form;
    const control = copy ? JSON.parse(JSON.stringify(copy)) : {
      type, name,
      properties: { Name: name, Text: type === "Button" ? "button" : type === "Label" ? "label" : "", Enabled: true, Visible: true },
      managedProperties: ["Location", "Size", "Name", "Text", "Enabled", "Visible"],
      events: { Click: "" },
      children: [], parent: null, location: placement?.location || { x: 24, y: 24 }, size: { width: dims[0], height: dims[1] }
    };
    const setTreeNames = (item, parentControl) => {
      item.name = item === control ? name : nextName(item.type);
      item.properties ||= {};
      item.properties.Name = item.name;
      item.parent = parentControl && parentControl.type !== "Form" ? parentControl.name : null;
      item.parentSize = { width: parentControl?.size?.width || form?.size?.width || 800, height: parentControl?.size?.height || form?.size?.height || 500 };
      (item.children || []).forEach(child => setTreeNames(child, item));
    };
    if (copy) setTreeNames(control, parent);
    control.parent = parent && parent.type !== "Form" ? parent.name : null;
    control.parentSize = { width: parent?.size?.width || form?.size?.width || 800, height: parent?.size?.height || form?.size?.height || 500 };
    if (placement?.location) control.location = placement.location;
    (parent ? parent.children : documentModel.controls).push(control);
    selected = new Set([control.name]); render(); scheduleSave();
  }
  function render() {
    if (!documentModel) return;
    const form = documentModel.controls.find(item => item.type === "Form") || documentModel.controls[0];
    const width = Number(form?.size?.width) || 800, height = Number(form?.size?.height) || 500;
    surface.style.width = `${width}px`; surface.style.height = `${height}px`;
    surface.style.backgroundColor = String(form?.properties?.BackColor || "");
    surface.style.color = String(form?.properties?.ForeColor || "");
    surface.style.fontFamily = String(form?.properties?.FontFamily || "");
    surface.style.fontSize = form?.properties?.FontSize ? `${form.properties.FontSize}pt` : "";
    surface.innerHTML = "";
    surface.classList.toggle("preview-mode", previewMode);
    const guideX = document.createElement("div"); guideX.className = "guide vertical"; guideX.hidden = true; surface.append(guideX);
    const guideY = document.createElement("div"); guideY.className = "guide horizontal"; guideY.hidden = true; surface.append(guideY);
    (form?.children || documentModel.controls.filter(item => item.type !== "Form")).forEach(control => renderControl(control, surface, form?.size || { width, height }));
    renderTree(); renderProperties();
    document.getElementById("status-size").textContent = `${width} × ${height}px`;
  }
  function renderControl(control, parent, parentSize) {
    const toggleControl = previewMode && ["CheckBox", "RadioButton"].includes(control.type);
    const previewTags = { Button: "button", Label: "label", TextBox: "input", RichTextBox: "textarea", ComboBox: "select", ListBox: "select", PictureBox: "img", GroupBox: "fieldset", DataGridView: "table" };
    const tag = previewMode && !toggleControl ? (previewTags[control.type] || "div") : "div";
    const element = document.createElement(tag);
    element.className = `control ${control.type.toLowerCase()}${selected.has(control.name) ? " selected" : ""}${selected.has(control.name) && [...selected][0] === control.name ? " primary-selection" : ""}`;
    element.dataset.name = control.name;
    const bounds = previewMode ? previewBounds(control, parentSize) : { ...control.location, ...control.size };
    element.style.left = `${bounds.x || 0}px`; element.style.top = `${bounds.y || 0}px`;
    element.style.width = `${bounds.width || 100}px`; element.style.height = `${bounds.height || 28}px`;
    const controlText = String(control.properties?.Text ?? control.name);
    let eventTarget = element;
    if (previewMode && ["TextBox", "RichTextBox"].includes(control.type)) element.value = String(control.properties?.Text ?? "");
    else if (toggleControl) {
      element.classList.add("toggle-control");
      element.textContent = "";
      const input = document.createElement("input"); input.type = control.type === "CheckBox" ? "checkbox" : "radio";
      input.checked = control.properties?.Checked === true;
      const caption = document.createElement("span"); caption.textContent = controlText;
      element.append(input, caption); eventTarget = input;
    } else if (previewMode && ["ComboBox", "ListBox"].includes(control.type)) {
      element.textContent = "";
      const options = controlItems(control);
      options.forEach((text, index) => { const option = document.createElement("option"); option.textContent = text; option.value = text; if (index === 0) option.selected = true; element.append(option); });
      if (control.type === "ListBox") element.size = 4;
    } else if (previewMode && control.type === "PictureBox") {
      element.alt = controlText;
      if (control.properties?.ImageLocation) element.src = String(control.properties.ImageLocation);
    } else if (previewMode && control.type === "GroupBox") {
      const legend = document.createElement("legend"); legend.textContent = controlText; element.append(legend);
    } else if (previewMode && control.type === "DataGridView") {
      const header = document.createElement("thead"), headerRow = document.createElement("tr");
      ["Column 1", "Column 2", "Column 3"].forEach(text => { const cell = document.createElement("th"); cell.textContent = text; headerRow.append(cell); });
      header.append(headerRow); element.append(header);
      const body = document.createElement("tbody");
      for (let rowIndex = 0; rowIndex < 3; rowIndex++) { const row = document.createElement("tr"); for (let column = 0; column < 3; column++) { const cell = document.createElement("td"); cell.textContent = rowIndex === 0 && column === 0 ? controlText : ""; row.append(cell); } body.append(row); }
      element.append(body);
    } else if (!(previewMode && ["ComboBox", "ListBox", "PictureBox"].includes(control.type))) element.textContent = controlText;
    element.style.color = String(control.properties?.ForeColor || "");
    if (control.properties?.BackColor) element.style.backgroundColor = String(control.properties.BackColor);
    if (control.properties?.FontFamily) element.style.fontFamily = String(control.properties.FontFamily);
    if (control.properties?.FontSize) element.style.fontSize = `${control.properties.FontSize}pt`;
    if (control.properties?.FontBold) element.style.fontWeight = "bold";
    if (control.properties?.FontItalic) element.style.fontStyle = "italic";
    if (control.properties?.Visible === false && previewMode) element.hidden = true;
    if (control.properties?.Visible === false && !previewMode) element.classList.add("design-hidden");
    if (control.properties?.Enabled === false) element.disabled = true;
    if (!previewMode) {
      element.addEventListener("pointerdown", event => beginPointer(event, control, element, "move"));
      element.addEventListener("click", event => { event.stopPropagation(); if (!event.shiftKey && !selected.has(control.name)) selected.clear(); selected.add(control.name); render(); });
    } else {
      const browserEvents = { Click: "click", DoubleClick: "dblclick", MouseEnter: "mouseenter", MouseLeave: "mouseleave", TextChanged: "input", CheckedChanged: "change", SelectedIndexChanged: "change" };
      Object.entries(control.events || {}).forEach(([name, handler]) => {
        if (browserEvents[name]) eventTarget.addEventListener(browserEvents[name], () => setStatus(`${name} handler: ${handler}`, false));
      });
    }
    if (!previewMode && selected.has(control.name)) {
      ["nw", "n", "ne", "e", "se", "s", "sw", "w"].forEach(position => {
        const handle = document.createElement("span"); handle.className = `resize-handle ${position}`;
        handle.addEventListener("pointerdown", event => beginPointer(event, control, element, "resize", position)); element.append(handle);
      });
    }
    parent.append(element);
    (control.children || []).forEach(child => renderControl(child, element, { width: bounds.width, height: bounds.height }));
  }
  function previewBounds(control, parentSize) {
    const bounds = { x: control.location.x, y: control.location.y, width: control.size.width, height: control.size.height };
    const parent = parentSize || control.parentSize || { width: 800, height: 500 };
    const dock = control.properties?.Dock || "None";
    if (dock === "Fill") return { x: 0, y: 0, width: parent.width, height: parent.height };
    if (dock === "Top") return { ...bounds, x: 0, y: 0, width: parent.width };
    if (dock === "Bottom") return { ...bounds, x: 0, y: parent.height - bounds.height, width: parent.width };
    if (dock === "Left") return { ...bounds, x: 0, y: 0, height: parent.height };
    if (dock === "Right") return { ...bounds, x: parent.width - bounds.width, y: 0, height: parent.height };
    const base = control.parentSize || parent;
    const anchor = new Set(String(control.properties?.Anchor || "Top, Left").split(/[,|]/).map(item => item.trim()));
    const widthDelta = parent.width - base.width, heightDelta = parent.height - base.height;
    if (anchor.has("Right") && !anchor.has("Left")) bounds.x += widthDelta;
    if (anchor.has("Left") && anchor.has("Right")) bounds.width += widthDelta;
    if (anchor.has("Bottom") && !anchor.has("Top")) bounds.y += heightDelta;
    if (anchor.has("Top") && anchor.has("Bottom")) bounds.height += heightDelta;
    return bounds;
  }
  function renderTree() {
    tree.innerHTML = "";
    const form = documentModel.controls.find(item => item.type === "Form") || documentModel.controls[0];
    const addRow = (control, depth) => {
      const row = document.createElement("div"); row.className = `tree-row${selected.has(control.name) ? " selected" : ""}`; row.style.paddingLeft = `${8 + depth * 15}px`;
      row.innerHTML = `<span class="tree-icon">${control.type === "Form" ? "▱" : "▪"}</span><span>${escapeHtml(control.name)}</span>`;
      row.addEventListener("click", () => { selected = new Set([control.name]); render(); }); tree.append(row);
      (control.children || []).forEach(child => addRow(child, depth + 1));
    };
    if (form) addRow(form, 0);
    else documentModel.controls.forEach(item => addRow(item, 0));
  }
  function renderProperties() {
    properties.innerHTML = "";
    const control = find([...selected][0]);
    if (!control) { properties.innerHTML = '<div class="empty">Select a control to edit its properties.</div>'; return; }
    const addGroup = title => { const group = document.createElement("div"); group.className = "property-group"; group.textContent = title; properties.append(group); };
    const addField = (label, value, key, numeric = false) => {
      const row = document.createElement("div"); row.className = "property-row";
      const caption = document.createElement("label"); caption.textContent = label;
      const input = document.createElement("input"); input.value = String(value ?? ""); if (numeric) input.type = "number";
      input.addEventListener("change", () => { checkpoint(); updateProperty(control, key, numeric ? Math.max(0, Number(input.value) || 0) : input.value); render(); scheduleSave(); });
      row.append(caption, input); properties.append(row);
    };
    const addTextArea = (label, value, key) => {
      const row = document.createElement("div"); row.className = "property-row property-row-multiline";
      const caption = document.createElement("label"); caption.textContent = label;
      const input = document.createElement("textarea"); input.rows = 4; input.value = value;
      input.addEventListener("change", () => { checkpoint(); updateProperty(control, key, input.value); render(); scheduleSave(); });
      row.append(caption, input); properties.append(row);
    };
    const addSelect = (label, values, key, value) => {
      const row = document.createElement("div"); row.className = "property-row";
      const caption = document.createElement("label"); caption.textContent = label;
      const select = document.createElement("select");
      [...new Set([value, ...values])].forEach(optionValue => { const option = document.createElement("option"); option.value = optionValue; option.textContent = optionValue; select.append(option); });
      select.value = value; select.addEventListener("change", () => { checkpoint(); control.properties[key] = select.value; markManaged(control, key); render(); scheduleSave(); });
      row.append(caption, select); properties.append(row);
    };
    const addColor = (label, key) => {
      const row = document.createElement("div"); row.className = "property-row";
      const caption = document.createElement("label"); caption.textContent = label;
      const input = document.createElement("input"); input.type = "color";
      const stored = String(control.properties?.[key] || ""); input.value = /^#[0-9a-f]{6}$/i.test(stored) ? stored : "#ffffff";
      input.addEventListener("change", () => { checkpoint(); control.properties[key] = input.value.toUpperCase(); markManaged(control, key); render(); scheduleSave(); });
      row.append(caption, input); properties.append(row);
    };
    addGroup("Design"); addField("(Name)", control.properties?.Name ?? control.name, "Name");
    if (!["Panel", "PictureBox", "DataGridView"].includes(control.type)) addField("Text", control.properties?.Text ?? "", "Text");
    addGroup("Layout"); addField("Location.X", control.location.x, "X", true); addField("Location.Y", control.location.y, "Y", true);
    addField("Size.Width", control.size.width, "Width", true); addField("Size.Height", control.size.height, "Height", true);
    if (control.type !== "Form") {
      addSelect("Anchor", ["Top, Left", "Top, Left, Right", "Top, Bottom, Left, Right", "Bottom, Right", "Bottom, Left"], "Anchor", control.properties?.Anchor || "Top, Left");
      addSelect("Dock", ["None", "Top", "Bottom", "Left", "Right", "Fill"], "Dock", control.properties?.Dock || "None");
      addField("TabIndex", control.properties?.TabIndex ?? 0, "TabIndex", true);
    }
    addGroup("Appearance"); addColor("BackColor", "BackColor"); addColor("ForeColor", "ForeColor");
    if (control.type === "PictureBox") addField("ImageLocation", control.properties?.ImageLocation ?? "", "ImageLocation");
    if (["ComboBox", "ListBox"].includes(control.type)) addTextArea("Items", controlItems(control).join("\n"), "Items");
    addField("Font family", control.properties?.FontFamily ?? "Segoe UI", "FontFamily");
    addField("Font size", control.properties?.FontSize ?? 9, "FontSize", true);
    ["FontBold", "FontItalic", "FontUnderline", "FontStrikeout"].forEach(key => {
      const row = document.createElement("div"); row.className = "property-row";
      const label = document.createElement("label"); label.textContent = key.replace("Font", "");
      const input = document.createElement("input"); input.type = "checkbox"; input.checked = !!control.properties[key];
      input.addEventListener("change", () => { checkpoint(); control.properties[key] = input.checked; if (!control.properties.FontFamily) control.properties.FontFamily = "Segoe UI"; if (!control.properties.FontSize) control.properties.FontSize = 9; markManaged(control, "Font"); render(); scheduleSave(); });
      row.append(label, input); properties.append(row);
    });
    if (control.type !== "Form") {
      addGroup("Events");
      const eventNames = new Set(["Click", "DoubleClick", "MouseEnter", "MouseLeave", "TextChanged", "CheckedChanged", "SelectedIndexChanged", ...Object.keys(control.events || {})]);
      eventNames.forEach(eventName => addField(eventName, control.events?.[eventName] ?? "", `event:${eventName}`));
    }
    addGroup("Behavior");
    const behaviorProperties = ["Enabled", "Visible", ...(["CheckBox", "RadioButton"].includes(control.type) ? ["Checked"] : [])];
    behaviorProperties.forEach(key => {
      const row = document.createElement("div"); row.className = "property-row";
      const label = document.createElement("label"); label.textContent = key;
      const input = document.createElement("input"); input.type = "checkbox"; input.checked = control.properties[key] !== false;
      input.addEventListener("change", () => { checkpoint(); control.properties[key] = input.checked; markManaged(control, key); render(); scheduleSave(); });
      row.append(label, input); properties.append(row);
    });
  }
  function updateProperty(control, key, value) {
    if (key === "Name") {
      control.properties.Name = String(value);
      markManaged(control, "Name");
    } else if (key.startsWith("event:")) {
      const eventName = key.slice("event:".length);
      control.events[eventName] = String(value).trim();
    } else if (key === "Items") {
      control.properties.Items = JSON.stringify(String(value).split(/\r?\n/).filter(item => item.length > 0));
      markManaged(control, "Items");
    } else if (key === "X" || key === "Y") { control.location[key.toLowerCase()] = value; markManaged(control, "Location"); }
    else if (key === "Width" || key === "Height") { control.size[key.toLowerCase()] = value; markManaged(control, "Size"); }
    else {
      control.properties[key] = value;
      if (key.startsWith("Font") && !control.properties.FontFamily) control.properties.FontFamily = "Segoe UI";
      markManaged(control, key.startsWith("Font") ? "Font" : key);
    }
  }
  function markManaged(control, property) {
    if (!Array.isArray(control.managedProperties)) control.managedProperties = [];
    if (!control.managedProperties.includes(property)) control.managedProperties.push(property);
  }
  function beginPointer(event, control, element, action, handle = "se") {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (event.shiftKey) selected.add(control.name);
    else if (!selected.has(control.name)) selected = new Set([control.name]);
    const targetNames = action === "resize" ? [control.name] : [...selected];
    pointerAction = { action, handle, startX: event.clientX, startY: event.clientY, snapshots: targetNames.map(name => { const item = find(name); return { name, x: item.location.x, y: item.location.y, width: item.size.width, height: item.size.height }; }) };
    checkpoint(); surface.setPointerCapture(event.pointerId); render();
  }
  function movePointer(event) {
    if (!pointerAction) return;
    const dx = event.clientX - pointerAction.startX, dy = event.clientY - pointerAction.startY;
    if (pointerAction.action === "resize") {
      const item = find(pointerAction.snapshots[0].name);
      const base = pointerAction.snapshots[0], handle = pointerAction.handle;
      if (handle.includes("e")) item.size.width = Math.max(24, snap(base.width + dx));
      if (handle.includes("s")) item.size.height = Math.max(20, snap(base.height + dy));
      if (handle.includes("w")) { const nextX = snap(base.x + dx); item.size.width = Math.max(24, base.width - (nextX - base.x)); item.location.x = base.x + base.width - item.size.width; }
      if (handle.includes("n")) { const nextY = snap(base.y + dy); item.size.height = Math.max(20, base.height - (nextY - base.y)); item.location.y = base.y + base.height - item.size.height; }
      markManaged(item, "Size");
      if (handle.includes("w")) markManaged(item, "Location");
      if (handle.includes("n")) markManaged(item, "Location");
    } else {
      const base = pointerAction.snapshots[0], primary = find(base.name);
      const peers = allControls().filter(item => !selected.has(item.name) && normalizedParent(item.parent) === normalizedParent(primary.parent));
      const xMatch = alignedPosition(snap(base.x + dx), primary.size.width, peers.map(item => [item.location.x, item.location.x + item.size.width / 2, item.location.x + item.size.width]).flat());
      const yMatch = alignedPosition(snap(base.y + dy), primary.size.height, peers.map(item => [item.location.y, item.location.y + item.size.height / 2, item.location.y + item.size.height]).flat());
      const moveX = (xMatch?.position ?? snap(base.x + dx)) - base.x;
      const moveY = (yMatch?.position ?? snap(base.y + dy)) - base.y;
      pointerAction.snapshots.forEach(snapshot => {
        const item = find(snapshot.name); item.location.x = snapshot.x + moveX; item.location.y = snapshot.y + moveY; markManaged(item, "Location");
      });
      render();
      const guides = surface.querySelectorAll(".guide");
      if (xMatch) { guides[0].hidden = false; guides[0].style.left = `${xMatch.line}px`; }
      if (yMatch) { guides[1].hidden = false; guides[1].style.top = `${yMatch.line}px`; }
      return;
    }
    render();
  }
  function endPointer() { if (!pointerAction) return; pointerAction = null; scheduleSave(); }
  function undo() { if (!history.length) return; future.push(JSON.stringify(documentModel)); documentModel = JSON.parse(history.pop()); selected.clear(); render(); scheduleSave(); }
  function redo() { if (!future.length) return; history.push(JSON.stringify(documentModel)); documentModel = JSON.parse(future.pop()); selected.clear(); render(); scheduleSave(); }
  function onKeyDown(event) {
    if (event.target instanceof HTMLInputElement) return;
    const key = event.key.toLowerCase();
    if (event.ctrlKey && key === "z") { event.preventDefault(); undo(); }
    else if (event.ctrlKey && (key === "y" || (event.shiftKey && key === "z"))) { event.preventDefault(); redo(); }
    else if (event.ctrlKey && key === "c") { clipboard = [...selected].map(name => JSON.parse(JSON.stringify(find(name)))); }
    else if (event.ctrlKey && key === "v" && clipboard.length) clipboard.forEach(item => { item.name = ""; item.location.x += grid; item.location.y += grid; addControl(item.type, item); });
    else if (event.ctrlKey && key === "d" && selected.size) { event.preventDefault(); const item = JSON.parse(JSON.stringify(find([...selected][0]))); item.name = ""; item.location.x += grid; item.location.y += grid; addControl(item.type, item); }
    else if ((key === "delete" || key === "backspace") && selected.size) {
      checkpoint(); const remove = (items) => { for (let i = items.length - 1; i >= 0; i--) { if (items[i].type !== "Form" && selected.has(items[i].name)) items.splice(i, 1); else remove(items[i].children || []); } };
      remove(documentModel.controls); selected.clear(); render(); scheduleSave();
    }
  }
  function normalizedParent(parent) { return !parent || parent === "this" ? "this" : parent; }
  function alignedPosition(position, length, peerPoints) {
    const points = [position, position + length / 2, position + length];
    let best = null;
    for (const point of points) for (const peer of peerPoints) {
      const distance = peer - point;
      if (Math.abs(distance) <= 5 && (!best || Math.abs(distance) < Math.abs(best.distance))) best = { position: position + distance, line: peer, distance };
    }
    return best;
  }
})();
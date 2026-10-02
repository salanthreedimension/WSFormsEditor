(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const grid = 8;
  const defaults = {
    Form: [800, 500], Panel: [240, 160], Button: [120, 36], Label: [120, 24], TextBox: [180, 28]
  };
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
      <button class="tool-action preview-toggle" id="preview" title="Alternar preview interativo">▶</button>
      <button class="tool-action" id="undo" title="Desfazer (Ctrl+Z)">↶</button>
      <button class="tool-action" id="redo" title="Refazer (Ctrl+Y)">↷</button>
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
    <footer class="status" id="status"><span class="status-message" id="status-message">Abrindo arquivo...</span><span class="status-actions" id="conflict-actions" hidden><button id="reload-file">Recarregar</button><button id="overwrite-file">Sobrescrever</button></span><span id="status-size"></span></footer>`;

  const surface = document.getElementById("form-surface");
  const toolbox = document.getElementById("toolbox");
  const tree = document.getElementById("tree");
  const properties = document.getElementById("properties");
  const status = document.getElementById("status");

  ["Form", "Panel", "Button", "Label", "TextBox"].forEach(type => {
    const button = document.createElement("button");
    button.className = "tool";
    button.textContent = type;
    button.addEventListener("click", () => {
      if (type === "Form") {
        const root = documentModel?.controls.find(item => item.type === "Form");
        if (root) { selected = new Set([root.name]); render(); }
      } else addControl(type);
    });
    toolbox.append(button);
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
      setStatus(diagnostics.length ? diagnostics.join(" | ") : "Designer carregado", diagnostics.length > 0);
    } else if (message.type === "conflict") {
      document.getElementById("conflict-actions").hidden = false;
      setStatus("O Designer.cs mudou no disco. Recarregue ou confirme a sobrescrita.", true);
    } else if (message.type === "build") {
      const errors = message.errors || [];
      setStatus(errors.length ? errors.join(" | ") : "Build do projeto concluído sem erros", errors.length > 0);
    } else if (message.type === "saved") {
      document.getElementById("conflict-actions").hidden = true;
      setStatus("Todas as alterações foram salvas", false);
    }
    else if (message.type === "error") setStatus(message.message, true);
  });

  document.getElementById("undo").addEventListener("click", undo);
  document.getElementById("redo").addEventListener("click", redo);
  document.getElementById("reload-file").addEventListener("click", () => vscode.postMessage({ type: "reload" }));
  document.getElementById("overwrite-file").addEventListener("click", () => {
    document.getElementById("conflict-actions").hidden = true;
    vscode.postMessage({ type: "save", document: documentModel, force: true });
  });
  document.getElementById("preview").addEventListener("click", event => {
    previewMode = !previewMode; selected.clear();
    event.currentTarget.classList.toggle("active", previewMode);
    event.currentTarget.title = previewMode ? "Voltar ao Designer" : "Alternar preview interativo";
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
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
  function snap(value) { return Math.max(0, Math.round(value / grid) * grid); }
  function checkpoint() { history.push(JSON.stringify(documentModel)); if (history.length > 100) history.shift(); future = []; }
  function scheduleSave() {
    setStatus("Salvando Designer.cs...", false);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => vscode.postMessage({ type: "save", document: documentModel }), 300);
  }
  function setStatus(message, error) { const item = document.getElementById("status-message"); item.textContent = message; item.title = message; status.classList.toggle("error", !!error); }
  function addControl(type, copy) {
    if (!documentModel) return;
    checkpoint();
    const used = new Set(allControls().map(item => item.name));
    let index = 1; while (used.has(`${type.toLowerCase()}${index}`)) index++;
    const name = `${type.toLowerCase()}${index}`;
    const dims = defaults[type] || defaults.Button;
    const control = copy ? JSON.parse(JSON.stringify(copy)) : {
      type, name,
      properties: { Name: name, Text: type === "Button" ? "button" : type === "Label" ? "label" : "", Enabled: true, Visible: true },
      managedProperties: ["Location", "Size", "Name", "Text", "Enabled", "Visible"],
      events: { Click: "" },
      children: [], parent: null, location: { x: 24, y: 24 }, size: { width: dims[0], height: dims[1] }
    };
    if (copy) control.name = name;
    const form = documentModel.controls.find(item => item.type === "Form");
    (form ? form.children : documentModel.controls).push(control);
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
    (form?.children || documentModel.controls.filter(item => item.type !== "Form")).forEach(control => renderControl(control, surface));
    renderTree(); renderProperties();
    document.getElementById("status-size").textContent = `${width} × ${height}px`;
  }
  function renderControl(control, parent) {
    const tag = previewMode ? ({ Button: "button", Label: "label", TextBox: "input", Panel: "div" }[control.type] || "div") : "div";
    const element = document.createElement(tag);
    element.className = `control ${control.type.toLowerCase()}${selected.has(control.name) ? " selected" : ""}${selected.has(control.name) && [...selected][0] === control.name ? " primary-selection" : ""}`;
    element.dataset.name = control.name;
    element.style.left = `${control.location?.x || 0}px`; element.style.top = `${control.location?.y || 0}px`;
    element.style.width = `${control.size?.width || 100}px`; element.style.height = `${control.size?.height || 28}px`;
    if (control.type === "TextBox" && previewMode) element.value = String(control.properties?.Text ?? "");
    else element.textContent = String(control.properties?.Text ?? control.name);
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
    } else if (control.events?.Click) {
      element.addEventListener("click", () => setStatus(`Evento Click: ${control.events.Click}`, false));
    }
    if (!previewMode && selected.has(control.name)) {
      ["nw", "n", "ne", "e", "se", "s", "sw", "w"].forEach(position => {
        const handle = document.createElement("span"); handle.className = `resize-handle ${position}`;
        handle.addEventListener("pointerdown", event => beginPointer(event, control, element, "resize", position)); element.append(handle);
      });
    }
    parent.append(element);
    (control.children || []).forEach(child => renderControl(child, element));
  }
  function renderTree() {
    tree.innerHTML = "";
    const form = documentModel.controls.find(item => item.type === "Form") || documentModel.controls[0];
    const items = [form, ...(form?.children || documentModel.controls.filter(item => item.type !== "Form"))].filter(Boolean);
    const addRow = (control, depth) => {
      const row = document.createElement("div"); row.className = `tree-row${selected.has(control.name) ? " selected" : ""}`; row.style.paddingLeft = `${8 + depth * 15}px`;
      row.innerHTML = `<span class="tree-icon">${control.type === "Form" ? "▱" : "▪"}</span><span>${escapeHtml(control.name)}</span>`;
      row.addEventListener("click", () => { selected = new Set([control.name]); render(); }); tree.append(row);
      (control.children || []).forEach(child => addRow(child, depth + 1));
    };
    items.forEach(item => addRow(item, 0));
  }
  function renderProperties() {
    properties.innerHTML = "";
    const control = find([...selected][0]);
    if (!control) { properties.innerHTML = '<div class="empty">Selecione um controle para editar suas propriedades.</div>'; return; }
    const addGroup = title => { const group = document.createElement("div"); group.className = "property-group"; group.textContent = title; properties.append(group); };
    const addField = (label, value, key, numeric = false) => {
      const row = document.createElement("div"); row.className = "property-row";
      const caption = document.createElement("label"); caption.textContent = label;
      const input = document.createElement("input"); input.value = String(value ?? ""); if (numeric) input.type = "number";
      input.addEventListener("change", () => { checkpoint(); updateProperty(control, key, numeric ? Math.max(0, Number(input.value) || 0) : input.value); render(); scheduleSave(); });
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
    if (control.type !== "Panel") addField("Text", control.properties?.Text ?? "", "Text");
    addGroup("Layout"); addField("Location.X", control.location.x, "X", true); addField("Location.Y", control.location.y, "Y", true);
    addField("Size.Width", control.size.width, "Width", true); addField("Size.Height", control.size.height, "Height", true);
    if (control.type !== "Form") {
      addSelect("Anchor", ["Top, Left", "Top, Left, Right", "Top, Bottom, Left, Right", "Bottom, Right", "Bottom, Left"], "Anchor", control.properties?.Anchor || "Top, Left");
      addSelect("Dock", ["None", "Top", "Bottom", "Left", "Right", "Fill"], "Dock", control.properties?.Dock || "None");
      addField("TabIndex", control.properties?.TabIndex ?? 0, "TabIndex", true);
    }
    addGroup("Appearance"); addColor("BackColor", "BackColor"); addColor("ForeColor", "ForeColor");
    addField("Font family", control.properties?.FontFamily ?? "Segoe UI", "FontFamily");
    addField("Font size", control.properties?.FontSize ?? 9, "FontSize", true);
    ["FontBold", "FontItalic", "FontUnderline", "FontStrikeout"].forEach(key => {
      const row = document.createElement("div"); row.className = "property-row";
      const label = document.createElement("label"); label.textContent = key.replace("Font", "");
      const input = document.createElement("input"); input.type = "checkbox"; input.checked = !!control.properties[key];
      input.addEventListener("change", () => { checkpoint(); control.properties[key] = input.checked; if (!control.properties.FontFamily) control.properties.FontFamily = "Segoe UI"; if (!control.properties.FontSize) control.properties.FontSize = 9; markManaged(control, "Font"); render(); scheduleSave(); });
      row.append(label, input); properties.append(row);
    });
    if (control.type !== "Form") { addGroup("Events"); addField("Click", control.events?.Click ?? "", "event:Click"); }
    addGroup("Behavior");
    ["Enabled", "Visible"].forEach(key => {
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
    } else if (key === "event:Click") {
      control.events.Click = String(value).trim();
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
    pointerAction = { action, handle, startX: event.clientX, startY: event.clientY, snapshots: [...selected].map(name => { const item = find(name); return { name, x: item.location.x, y: item.location.y, width: item.size.width, height: item.size.height }; }) };
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
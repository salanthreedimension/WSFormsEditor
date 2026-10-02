const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { appendFile, cp, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const helper = path.join(root, "roslyn", "WinFormsDesigner.Roslyn.csproj");

function runHelper(operation, sourcePath, input) {
  const result = spawnSync("dotnet", ["run", "--no-launch-profile", "--project", helper, "--", operation, sourcePath], {
    cwd: root,
    input,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("Roslyn updates visual properties and Click without damaging handlers", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "winforms-designer-test-"));
  try {
    const project = path.join(temporaryRoot, "WinFormsSample");
    await cp(path.join(root, "samples", "WinFormsSample"), project, { recursive: true });
    const designer = path.join(project, "Form1.Designer.cs");
    const designerSource = (await readFile(designer, "utf8")).replace(
      "this.label1.Location = new System.Drawing.Point(32, 24);",
      "this.label1.Location = new System.Drawing.Point(GetLabelX(), 24);"
    );
    await writeFile(designer, designerSource);
    const codeBehind = path.join(project, "Form1.cs");
    const codeBehindSource = (await readFile(codeBehind, "utf8")).replace(/\n}\s*$/, "\n    private int GetLabelX() => 32;\n}\n");
    await writeFile(codeBehind, codeBehindSource);
    const model = {
      formName: "Form1",
      diagnostics: [],
      controls: [{
        type: "Form", name: "Form1", properties: { Name: "Form1", Text: "Updated Form" }, managedProperties: ["Name", "Text", "Size", "Location"], events: {},
        parent: null, location: { x: 0, y: 0 }, size: { width: 620, height: 300 },
        children: [
          {
            type: "Button", name: "button1",
            properties: {
              Name: "button1", Text: "Updated", TabIndex: 5, Anchor: "Top, Left, Right", Dock: "None",
              BackColor: "#12AB34", ForeColor: "#FFFFFF", FontFamily: "Segoe UI", FontSize: 10,
              FontBold: true, FontItalic: false, FontUnderline: false, FontStrikeout: false, Enabled: true, Visible: true
            },
            managedProperties: ["Location", "Size", "Name", "Text", "TabIndex", "Anchor", "Dock", "BackColor", "ForeColor", "Font", "Enabled", "Visible"],
            events: { Click: "button1_Click", DoubleClick: "button1_Click" }, children: [], parent: "this",
            location: { x: 40, y: 120 }, size: { width: 132, height: 40 }
          },
          {
            type: "Label", name: "label1", properties: { Name: "label1", Text: "Nome", TabIndex: 1 }, managedProperties: ["Size", "Name", "Text", "TabIndex"],
            events: {}, children: [], parent: "this", location: { x: 32, y: 24 }, size: { width: 120, height: 24 }
          },
          {
            type: "TextBox", name: "textBox1", properties: { Name: "textBox1", TabIndex: 2 }, managedProperties: ["Location", "Size", "Name", "TabIndex"],
            events: {}, children: [], parent: "this", location: { x: 32, y: 64 }, size: { width: 180, height: 28 }
          },
          {
            type: "ComboBox", name: "comboBox1", properties: { Name: "comboBox1", Text: "Novo", Items: JSON.stringify(["Alpha", "Beta"]) }, managedProperties: ["Location", "Size", "Name", "Text", "Items"],
            events: { SelectedIndexChanged: "button1_Click" }, children: [], parent: "this", location: { x: 200, y: 200 }, size: { width: 160, height: 28 }
          },
          {
            type: "DataGridView", name: "dataGridView1", properties: { Name: "dataGridView1", TabIndex: 4 }, managedProperties: ["Location", "Size", "Name", "TabIndex"],
            events: {}, children: [], parent: "this", location: { x: 320, y: 200 }, size: { width: 360, height: 200 }
          },
          {
            type: "RichTextBox", name: "richTextBox1", properties: { Name: "richTextBox1", Text: "Rich" }, managedProperties: ["Location", "Size", "Name", "Text"],
            events: { TextChanged: "button1_Click" }, children: [], parent: "this", location: { x: 24, y: 260 }, size: { width: 220, height: 120 }
          },
          {
            type: "CheckBox", name: "checkBox1", properties: { Name: "checkBox1", Text: "Aceito", Checked: true }, managedProperties: ["Location", "Size", "Name", "Text", "Checked"],
            events: { CheckedChanged: "button1_Click" }, children: [], parent: "this", location: { x: 24, y: 400 }, size: { width: 120, height: 24 }
          },
          {
            type: "RadioButton", name: "radioButton1", properties: { Name: "radioButton1", Text: "Opção", Checked: false }, managedProperties: ["Location", "Size", "Name", "Text", "Checked"],
            events: {}, children: [], parent: "this", location: { x: 160, y: 400 }, size: { width: 120, height: 24 }
          },
          {
            type: "ListBox", name: "listBox1", properties: { Name: "listBox1", Items: JSON.stringify(["Um", "Dois"]) }, managedProperties: ["Location", "Size", "Name", "Items"],
            events: { SelectedIndexChanged: "button1_Click" }, children: [], parent: "this", location: { x: 700, y: 24 }, size: { width: 160, height: 120 }
          },
          {
            type: "PictureBox", name: "pictureBox1", properties: { Name: "pictureBox1", ImageLocation: "photo.png" }, managedProperties: ["Location", "Size", "Name", "ImageLocation"],
            events: {}, children: [], parent: "this", location: { x: 700, y: 160 }, size: { width: 160, height: 120 }
          },
          {
            type: "GroupBox", name: "groupBox1", properties: { Name: "groupBox1", Text: "Grupo" }, managedProperties: ["Location", "Size", "Name", "Text"],
            events: {}, children: [], parent: "this", location: { x: 900, y: 24 }, size: { width: 240, height: 160 }
          },
          {
            type: "TabControl", name: "tabControl1", properties: { Name: "tabControl1", Text: "Abas" }, managedProperties: ["Location", "Size", "Name", "Text"],
            events: {}, children: [], parent: "this", location: { x: 900, y: 200 }, size: { width: 300, height: 200 }
          }
        ]
      }]
    };

    runHelper("write", designer, JSON.stringify(model));
    const generated = await readFile(designer, "utf8");
    assert.match(generated, /this\.button1\.Click \+= this\.button1_Click;/);
    assert.match(generated, /this\.button1\.DoubleClick \+= this\.button1_Click;/);
    assert.match(generated, /this\.comboBox1\.SelectedIndexChanged \+= this\.button1_Click;/);
    assert.match(generated, /this\.comboBox1\.Items\.AddRange\(new object\[\] \{ "Alpha", "Beta" \}\);/);
    assert.match(generated, /this\.listBox1\.Items\.AddRange\(new object\[\] \{ "Um", "Dois" \}\);/);
    assert.match(generated, /this\.checkBox1\.Checked = true;/);
    assert.match(generated, /this\.pictureBox1\.ImageLocation = "photo.png";/);
    assert.match(generated, /AnchorStyles\.Top \| System\.Windows\.Forms\.AnchorStyles\.Left/);
    assert.match(generated, /DockStyle\.None/);
    assert.match(generated, /FontStyle\.Bold/);
    assert.match(generated, /this\.comboBox1\.Location = new System\.Drawing\.Point\(200, 200\);/);
    assert.match(generated, /this\.label1\.Location = new System\.Drawing\.Point\(GetLabelX\(\), 24\);/);
    assert.match(generated, /this\.button1\.UseVisualStyleBackColor = true;/);
    assert.doesNotMatch(generated, /panel1/);

    const build = spawnSync("dotnet", ["build", path.join(project, "WinFormsSample.csproj"), "--nologo", "--verbosity", "quiet"], {
      cwd: project,
      encoding: "utf8"
    });
    assert.equal(build.status, 0, build.stdout + build.stderr);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Roslyn expands expression-bodied InitializeComponent methods", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "winforms-expression-test-"));
  try {
    const designer = path.join(temporaryRoot, "Form1.Designer.cs");
    await writeFile(designer, `namespace ExpressionSample;\npartial class Form1 : System.Windows.Forms.Form\n{\n    private System.Windows.Forms.Button button1 = null!;\n    private void InitializeComponent() => this.button1 = new System.Windows.Forms.Button();\n}\n`);
    const model = JSON.parse(runHelper("read", designer));
    model.controls[0].children[0].location.x = 80;
    model.controls[0].children[0].managedProperties.push("Location");
    runHelper("write", designer, JSON.stringify(model));
    const generated = await readFile(designer, "utf8");
    assert.match(generated, /this\.button1\.Location = new System\.Drawing\.Point\(80, 0\);/);
    assert.doesNotMatch(generated, /InitializeComponent\(\)\s*=>/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Roslyn edits a layout stored in the Form.cs file", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "winforms-single-file-test-"));
  try {
    const form = path.join(temporaryRoot, "Form1.cs");
    await writeFile(form, `namespace SingleFileSample;\npartial class Form1 : System.Windows.Forms.Form\n{\n    private System.Windows.Forms.Button button1 = null!;\n\n    private void InitializeComponent()\n    {\n        this.button1 = new System.Windows.Forms.Button();\n        this.button1.Name = "button1";\n        this.Controls.Add(this.button1);\n    }\n}\n`);
    const model = JSON.parse(runHelper("read", form));
    model.controls[0].children[0].location.x = 80;
    model.controls[0].children[0].managedProperties.push("Location");
    runHelper("write", form, JSON.stringify(model));
    const generated = await readFile(form, "utf8");
    assert.match(generated, /this\.button1\.Location = new System\.Drawing\.Point\(80, 0\);/);
    assert.match(generated, /this\.Controls\.Add\(this\.button1\);/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
const assert = require("node:assert/strict");
const test = require("node:test");
const { defaultSizes } = require("../dist/model.js");

test("the MVP control catalog provides stable initial sizes", () => {
  assert.deepEqual(defaultSizes.Form, { width: 800, height: 500 });
  assert.deepEqual(defaultSizes.Button, { width: 120, height: 36 });
  assert.deepEqual(defaultSizes.Label, { width: 120, height: 24 });
  assert.deepEqual(defaultSizes.TextBox, { width: 180, height: 28 });
  assert.deepEqual(defaultSizes.Panel, { width: 240, height: 160 });
  assert.deepEqual(defaultSizes.RichTextBox, { width: 220, height: 120 });
  assert.deepEqual(defaultSizes.CheckBox, { width: 120, height: 24 });
  assert.deepEqual(defaultSizes.RadioButton, { width: 120, height: 24 });
  assert.deepEqual(defaultSizes.ComboBox, { width: 160, height: 28 });
  assert.deepEqual(defaultSizes.ListBox, { width: 160, height: 120 });
  assert.deepEqual(defaultSizes.PictureBox, { width: 160, height: 120 });
  assert.deepEqual(defaultSizes.GroupBox, { width: 240, height: 160 });
  assert.deepEqual(defaultSizes.TabControl, { width: 300, height: 200 });
  assert.deepEqual(defaultSizes.DataGridView, { width: 360, height: 200 });
});
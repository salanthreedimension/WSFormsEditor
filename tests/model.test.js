const assert = require("node:assert/strict");
const test = require("node:test");
const { defaultSizes } = require("../dist/model.js");

test("the MVP control catalog provides stable initial sizes", () => {
  assert.deepEqual(defaultSizes.Form, { width: 800, height: 500 });
  assert.deepEqual(defaultSizes.Button, { width: 120, height: 36 });
  assert.deepEqual(defaultSizes.Label, { width: 120, height: 24 });
  assert.deepEqual(defaultSizes.TextBox, { width: 180, height: 28 });
  assert.deepEqual(defaultSizes.Panel, { width: 240, height: 160 });
});
import { test } from "node:test";
import assert from "node:assert/strict";
import { getByPath, setByPath, deepVariableReplacer } from "../src/lib/functions/common.function.ts";

test("configurable paths cannot modify object prototypes", () => {
  for (const path of ["__proto__.polluted", "constructor.prototype.polluted", "safe.__proto__.polluted"]) {
    assert.throws(() => setByPath({}, path, true));
  }
  assert.equal({}.polluted, undefined);
  const value = {};
  setByPath(value, "items[0].text", "hello");
  assert.equal(getByPath(value, "items[0].text"), "hello");
});

test("response paths read only own properties", () => {
  assert.equal(getByPath({}, "constructor"), undefined);
  assert.equal(getByPath(Object.create({ text: "inherited" }), "text"), undefined);
});

test("template keys and substitution values are treated literally", () => {
  assert.equal(deepVariableReplacer("{{A.*}} {{KEY}}", { "A.*": "literal", KEY: "$&" }), "literal $&");
  const output = deepVariableReplacer(JSON.parse('{"__proto__":{"polluted":true},"text":"{{KEY}}"}'), { KEY: "safe" });
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.equal(output.text, "safe");
});

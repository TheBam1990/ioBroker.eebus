"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeSki, validatePower, bridgePath } = require("../lib/helpers");
test("SKI normalization accepts only 20-byte hex identifiers", () => {
  assert.equal(normalizeSki(`${"AA:".repeat(19)}AA`), "aa".repeat(20));
  for (const value of ["", "aa", "zz".repeat(20), "a!".repeat(20)]) {
    assert.throws(() => normalizeSki(value));
  }
});
test("power checks signs, nominal boundaries and rejects non-finite values", () => {
  assert.equal(validatePower(-10000, 11000, 10000), -10000);
  assert.equal(validatePower(11000, 11000, 10000), 11000);
  for (const value of [NaN, Infinity, "5", 11001, -10001]) {
    assert.throws(() => validatePower(value, 11000, 10000));
  }
});
test("binary selection maps ioBroker operating system and CPU", () => {
  assert.match(bridgePath("/tmp", "linux", "x64"), /linux-amd64$/);
  assert.match(bridgePath("/tmp", "win32", "arm64"), /windows-arm64.exe$/);
  assert.throws(() => bridgePath("/tmp", "linux", "mips"));
});

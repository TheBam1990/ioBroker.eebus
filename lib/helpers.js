"use strict";
const path = require("node:path");
/**
 * Validate and normalize a SHIP subject key identifier.
 *
 * @param {unknown} value Remote SKI.
 * @returns {string} Lowercase 40-character identifier.
 */
function normalizeSki(value) {
  const ski = String(value || "")
    .trim()
    .replace(/:/g, "")
    .toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(ski)) {
    throw new Error("SKI must contain exactly 40 hexadecimal characters");
  }
  return ski;
}
/**
 * Validate signed input power against the configured nominal bounds.
 *
 * @param {unknown} value Signed power in watts.
 * @param {number} consumption Maximum consumption in watts.
 * @param {number} production Maximum production magnitude in watts.
 * @returns {number} Valid input value.
 */
function validatePower(value, consumption, production) {
  if (typeof value !== "number" || !Number.isFinite(value) || value > consumption || value < -production) {
    throw new Error("Power must be a finite number within the configured nominal range");
  }
  return value;
}
/**
 * Locate the packaged native protocol process.
 *
 * @param {string} base Adapter directory.
 * @param {string} platform Node operating system name.
 * @param {string} arch Node CPU architecture.
 * @returns {string} Executable path.
 */
function bridgePath(base, platform, arch) {
  if (!["linux", "win32", "darwin"].includes(platform) || !["x64", "arm64", "arm"].includes(arch)) {
    throw new Error(`Unsupported EEBUS platform ${platform}/${arch}`);
  }
  return path.join(
    base,
    "bin",
    `eebus-bridge-${platform === "win32" ? "windows" : platform}-${arch === "x64" ? "amd64" : arch}${platform === "win32" ? ".exe" : ""}`,
  );
}
module.exports = { normalizeSki, validatePower, bridgePath };

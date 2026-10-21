"use strict";
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const root = path.resolve(__dirname, "..");
const all = process.argv.includes("--all");
const native = [
  process.platform === "win32" ? "windows" : process.platform,
  process.arch === "x64" ? "amd64" : process.arch,
];
const targets = all
  ? [
      ["linux", "amd64"],
      ["linux", "arm64"],
      ["linux", "arm"],
      ["windows", "amd64"],
      ["windows", "arm64"],
      ["darwin", "amd64"],
      ["darwin", "arm64"],
    ]
  : [native];
fs.mkdirSync(path.join(root, "bin"), { recursive: true });
for (const [goos, goarch] of targets) {
  const name = `eebus-bridge-${goos}-${goarch}${goos === "windows" ? ".exe" : ""}`;
  execFileSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", path.join(root, "bin", name), "."], {
    cwd: path.join(root, "bridge"),
    stdio: "inherit",
    env: { ...process.env, GOOS: goos, GOARCH: goarch, GOARM: "7", CGO_ENABLED: "0" },
  });
  console.log(`Built ${name}`);
}

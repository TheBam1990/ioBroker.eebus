"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const utils = require("@iobroker/adapter-core");
const { normalizeSki, validatePower, bridgePath } = require("./lib/helpers");

class EebusAdapter extends utils.Adapter {
  constructor(options = {}) {
    super({ ...options, name: "eebus" });
    this.child = null;
    this.stopping = false;
    this.pairingTimer = null;
    this.retryTimer = null;
    this.retryDelay = 5000;
    this.connectedPeers = new Set();
    this.eventQueue = Promise.resolve();
    this.pending = new Map();
    this.commandSequence = 0;
    this.on("ready", () => this.onReady().catch((error) => this.fail(error)));
    this.on("stateChange", (id, state) => this.onStateChange(id, state).catch((error) => this.fail(error)));
    this.on("unload", (callback) => this.onUnload(callback));
  }

  async onReady() {
    await this.createObjects();
    await this.subscribeStatesAsync("control.*");
    await this.subscribeStatesAsync("measurements.inputPowerW");
    await this.resetRuntime();
    if (this.config.enabled === false || this.config.shipEnabled === false) {
      await this.setStateAsync("diagnostics.status", "disabled", true);
      return;
    }
    this.dataDir = utils.getAbsoluteInstanceDataDir(this);
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const power = await this.getStateAsync("measurements.inputPowerW");
    if (!power) {
      await this.setStateAsync("measurements.inputPowerW", this.config.initialPowerW ?? 6000, true);
    }
    await this.startBridge();
  }

  async createObjects() {
    for (const channel of [
      "info",
      "diagnostics",
      "ship",
      "discovery",
      "pairing",
      "control",
      "spine",
      "lpc",
      "lpp",
      "measurements",
    ]) {
      await this.setObjectNotExistsAsync(channel, { type: "channel", common: { name: channel }, native: {} });
    }
    // eslint-disable-next-line jsdoc/check-tag-names
    const definitions = /** @type {Array<[string, string, ioBroker.CommonType, string, boolean?, string?]>} */ ([
      ["info.connection", "EEBUS SHIP connection established", "boolean", "indicator.connected"],
      ["info.localSki", "Local certificate Subject Key Identifier (SKI)", "string", "text"],
      ["info.deviceJson", "Local EEBUS device", "string", "json"],
      ["info.qrCode", "SHIP pairing QR code content", "string", "text"],
      ["diagnostics.status", "Status", "string", "text"],
      ["diagnostics.lastError", "Last error", "string", "text"],
      ["diagnostics.lastUpdate", "Last update", "string", "value.time"],
      ["ship.listenerActive", "SHIP WebSocket listener active", "boolean", "indicator"],
      ["ship.listenerAddress", "SHIP listener address", "string", "text"],
      ["ship.peerSki", "Last remote certificate SKI", "string", "text"],
      ["ship.connectedPeersJson", "Connected remote SKIs", "string", "json"],
      ["discovery.mdnsStatus", "mDNS discovery status", "string", "text"],
      ["discovery.serviceName", "mDNS service type", "string", "text"],
      ["discovery.peersJson", "Discovered EEBUS devices (select SKI for pairing)", "string", "json"],
      ["pairing.peerSki", "Remote SKI to pair or unpair", "string", "text", true],
      ["pairing.trusted", "An established connection is trusted", "boolean", "indicator"],
      ["pairing.trustedPeersJson", "Persistently trusted SKIs", "string", "json"],
      ["pairing.stateJson", "Last SHIP pairing state", "string", "json"],
      ["pairing.windowOpen", "Pairing window open (120 seconds)", "boolean", "indicator"],
      ["control.openPairing", "Open pairing window for 120 seconds", "boolean", "button", true],
      ["control.trustCurrentPeer", "Trust selected remote SKI and connect", "boolean", "button", true],
      ["control.untrustPeer", "Remove trust for selected remote SKI", "boolean", "button", true],
      ["control.checkPeer", "Refresh EEBUS data", "boolean", "button", true],
      ["spine.status", "SPINE status", "string", "text"],
      ["spine.useCasesJson", "Local use cases", "string", "json"],
      ["spine.lastMessageJson", "Last use case event", "string", "json"],
      [
        "measurements.inputPowerW",
        "Input power / simulation demand (+consumption, -production)",
        "number",
        "value.power",
        true,
        "W",
      ],
      ["measurements.powerW", "Power published via MPC", "number", "value.power", false, "W"],
      ["measurements.simulation", "Published power is simulated", "boolean", "indicator"],
    ]);
    for (const uc of ["lpc", "lpp"]) {
      definitions.push(
        [`${uc}.limitW`, "Last received active power limit (signed)", "number", "value.power", false, "W"],
        [`${uc}.active`, "Received limit active", "boolean", "indicator"],
        [`${uc}.durationSeconds`, "Received limit duration", "number", "value.interval", false, "s"],
        [`${uc}.effectiveMaxW`, "Effective maximum power (magnitude)", "number", "value.power", false, "W"],
        [`${uc}.failsafe`, "Failsafe restriction active", "boolean", "indicator"],
      );
    }
    for (const [id, name, type, role, write = false, unit] of definitions) {
      await this.extendObjectAsync(id, {
        type: "state",
        common: { name, type, role, read: true, write, ...(unit ? { unit } : {}) },
        native: {},
      });
    }
  }

  async resetRuntime() {
    this.connectedPeers.clear();
    for (const uc of ["lpc", "lpp"]) {
      await this.setStateAsync(`${uc}.active`, false, true);
      await this.setStateAsync(`${uc}.durationSeconds`, 0, true);
    }
    for (const id of ["info.connection", "ship.listenerActive", "pairing.trusted", "pairing.windowOpen"]) {
      await this.setStateAsync(id, false, true);
    }
    await this.setStateAsync("ship.connectedPeersJson", "[]", true);
    await this.setStateAsync("discovery.peersJson", "[]", true);
    await this.setStateAsync("discovery.mdnsStatus", "starting", true);
    await this.setStateAsync("discovery.serviceName", "_ship._tcp.local", true);
    await this.setStateAsync("diagnostics.status", "starting", true);
    await this.setStateAsync("diagnostics.lastError", "", true);
    await this.setStateAsync("spine.status", "starting", true);
    for (const id of ["control.openPairing", "control.trustCurrentPeer", "control.untrustPeer", "control.checkPeer"]) {
      await this.setStateAsync(id, false, true);
    }
    // Retire misleading TCP-only diagnostics from versions 0.1.x.
    for (const id of ["ship.peerReachable", "ship.peerHost", "pairing.expectedPeerSki", "ship.peerCertificateJson"]) {
      if (await this.getObjectAsync(id)) {
        await this.delObjectAsync(id);
      }
    }
  }

  async uploadedPem(selectedPath) {
    const normalized = String(selectedPath).replace(/^\/+/, "");
    const slash = normalized.indexOf("/");
    const storage = slash < 0 ? `${this.namespace}.certificates` : normalized.slice(0, slash);
    const file = slash < 0 ? normalized : normalized.slice(slash + 1);
    if (storage !== `${this.namespace}.certificates` || !file || file.split("/").includes("..")) {
      throw new Error("Invalid certificate file path");
    }
    const result = await this.readFileAsync(storage, file);
    return Buffer.isBuffer(result.file) ? result.file.toString("utf8") : String(result.file);
  }

  async startBridge() {
    if (this.stopping) {
      return;
    }
    const binary = bridgePath(__dirname, process.platform, process.arch);
    if (!fs.existsSync(binary)) {
      throw new Error(`EEBUS binary missing for ${process.platform}/${process.arch}: ${binary}`);
    }
    const current = await this.getStateAsync("measurements.inputPowerW");
    let interfaces = String(this.config.discoveryInterfaces || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!interfaces.length && this.config.shipBind && !["0.0.0.0", "::"].includes(this.config.shipBind)) {
      interfaces = Object.entries(os.networkInterfaces())
        .filter(([, addresses]) => addresses?.some((a) => a.address === this.config.shipBind))
        .map(([name]) => name);
      if (!interfaces.length) {
        throw new Error("Configured SHIP bind address is not a local network interface");
      }
    }
    const config = {
      port: Number(this.config.shipPort || 4712),
      brand: this.config.deviceBrand || "ioBroker",
      model: this.config.deviceModel || "ioBroker EEBUS",
      serial: this.config.deviceSerial || os.hostname(),
      dataDir: this.dataDir,
      generate: this.config.autoGenerateCertificate !== false,
      certPem: this.config.certificateFile
        ? await this.uploadedPem(this.config.certificateFile)
        : this.config.certificatePem || "",
      keyPem: this.config.privateKeyFile
        ? await this.uploadedPem(this.config.privateKeyFile)
        : this.config.privateKeyPem || "",
      interfaces,
      nominalConsumptionW: Number(this.config.nominalConsumptionW || 11000),
      nominalProductionW: Number(this.config.nominalProductionW || 10000),
      simulation: this.config.simulation !== false,
      powerW: Number(current?.val ?? this.config.initialPowerW ?? 6000),
    };
    validatePower(config.powerW, config.nominalConsumptionW, config.nominalProductionW);
    if (!this.dataDir) {
      throw new Error("Missing instance data directory");
    }
    const configPath = path.join(this.dataDir, "bridge-config.json");
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
    const child = spawn(binary, ["-config", configPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      this.eventQueue = this.eventQueue
        .then(async () => {
          if (this.child === child && !this.stopping) {
            await this.onBridgeEvent(JSON.parse(line));
          }
        })
        .catch((error) => this.fail(error));
    });
    child.stderr.on("data", (data) => this.log.debug(`EEBUS: ${String(data).trim()}`));
    child.on("error", (error) => void this.fail(error));
    child.on("close", (code) => {
      if (this.child === child) {
        this.child = null;
      }
      for (const pending of this.pending.values()) {
        this.clearTimeout(pending.timer);
        pending.reject(new Error("EEBUS process stopped"));
      }
      this.pending.clear();
      lines.close();
      if (!this.stopping) {
        void this.resetRuntime().then(() => this.fail(new Error(`EEBUS process exited (${code})`)));
        this.retryTimer = this.setTimeout(() => {
          void this.startBridge().catch((error) => this.fail(error));
        }, this.retryDelay);
        this.retryDelay = Math.min(60000, this.retryDelay * 2);
      }
    });
  }

  async onBridgeEvent(message) {
    const { event, data } = message;
    if (event === "log") {
      const level = ["silly", "debug", "info", "warn", "error"].includes(data.level) ? data.level : "debug";
      this.log[level](data.message);
      return;
    }
    if (event === "result") {
      const pending = this.pending.get(data.id);
      if (pending) {
        this.clearTimeout(pending.timer);
        this.pending.delete(data.id);
        if (data.ok) {
          pending.resolve();
        } else {
          pending.reject(new Error(data.error));
        }
      }
      return;
    }
    if (event === "ready") {
      this.retryDelay = 5000;
      await this.setStateAsync("info.localSki", data.ski.toUpperCase(), true);
      await this.setStateAsync("info.qrCode", data.qrCode || "", true);
      await this.setStateAsync(
        "info.deviceJson",
        JSON.stringify({
          brand: this.config.deviceBrand,
          model: this.config.deviceModel,
          serial: this.config.deviceSerial || os.hostname(),
          type: "EnergyManagementSystem",
          ski: data.ski,
        }),
        true,
      );
      await this.setStateAsync("ship.listenerActive", true, true);
      await this.setStateAsync("ship.listenerAddress", `0.0.0.0:${data.port}/ship/`, true);
      await this.setStateAsync("discovery.mdnsStatus", "advertising-and-browsing", true);
      await this.setStateAsync("spine.status", "ready", true);
      await this.setStateAsync("spine.useCasesJson", JSON.stringify(data.useCases), true);
      await this.setStateAsync("measurements.simulation", data.simulation, true);
      await this.setStateAsync("diagnostics.status", "ready-awaiting-pairing", true);
      await this.setStateAsync("diagnostics.lastError", "", true);
      this.log.info(`EEBUS ready: SKI ${data.ski}, port ${data.port}, LPC/LPP/MPC, simulation=${data.simulation}`);
    } else if (event === "discovery") {
      await this.setStateAsync("discovery.peersJson", JSON.stringify(data || []), true);
    } else if (event === "pairing") {
      await this.setStateAsync("pairing.stateJson", JSON.stringify(data), true);
      await this.setStateAsync("ship.peerSki", data.ski.toUpperCase(), true);
      if (data.state === 3) {
        await this.setStateAsync("pairing.peerSki", data.ski.toUpperCase(), true);
      }
      if (data.error) {
        await this.fail(new Error(data.error));
      }
    } else if (event === "connected") {
      if (data.connected) {
        this.connectedPeers.add(data.ski);
      } else {
        this.connectedPeers.delete(data.ski);
      }
      const connected = this.connectedPeers.size > 0;
      await this.setStateAsync("info.connection", connected, true);
      await this.setStateAsync("pairing.trusted", connected, true);
      await this.setStateAsync("ship.connectedPeersJson", JSON.stringify([...this.connectedPeers]), true);
      await this.setStateAsync("diagnostics.status", connected ? "ship-connected" : "ready-awaiting-pairing", true);
      await this.setStateAsync("spine.status", connected ? "connected" : "ready", true);
    } else if (event === "trustedPeers") {
      await this.setStateAsync(
        "pairing.trustedPeersJson",
        JSON.stringify(Object.keys(data).filter((k) => data[k])),
        true,
      );
    } else if (event === "pairingWindow") {
      await this.setStateAsync("pairing.windowOpen", data, true);
    } else if (event === "useCaseEvent") {
      await this.setStateAsync("spine.lastMessageJson", JSON.stringify(data), true);
    } else if (event === "limit") {
      const uc = data.useCase;
      if (!["lpc", "lpp"].includes(uc)) {
        throw new Error("Unknown use case in bridge event");
      }
      await this.setStateAsync(`${uc}.limitW`, data.limit.Value, true);
      await this.setStateAsync(`${uc}.active`, data.limit.IsActive, true);
      await this.setStateAsync(`${uc}.durationSeconds`, data.limit.Duration / 1e9, true);
    } else if (event === "limitsStatus") {
      await this.setStateAsync("lpc.active", data.lpcActive, true);
      await this.setStateAsync("lpp.active", data.lppActive, true);
    } else if (event === "measurement") {
      await this.setStateAsync("measurements.powerW", data.powerW, true);
      await this.setStateAsync("lpc.effectiveMaxW", data.consumptionMaxW, true);
      await this.setStateAsync("lpp.effectiveMaxW", data.productionMaxW, true);
      await this.setStateAsync("lpc.failsafe", data.lpcFailsafe, true);
      await this.setStateAsync("lpp.failsafe", data.lppFailsafe, true);
    } else if (event === "fatal" || event === "error") {
      await this.fail(new Error(String(data)));
    }
    await this.setStateAsync("diagnostics.lastUpdate", new Date().toISOString(), true);
  }

  sendCommand(op, extra = {}) {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.reject(new Error("EEBUS process is not running"));
    }
    const id = String(++this.commandSequence);
    return new Promise((resolve, reject) => {
      const timer = this.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`EEBUS command timed out: ${op}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, op, ...extra })}\n`, (error) => {
        if (error) {
          this.clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }
    if (id === `${this.namespace}.measurements.inputPowerW`) {
      const value = validatePower(
        state.val,
        Number(this.config.nominalConsumptionW || 11000),
        Number(this.config.nominalProductionW || 10000),
      );
      await this.sendCommand("power", { value });
      await this.setStateAsync("measurements.inputPowerW", value, true);
      return;
    }
    if (id === `${this.namespace}.pairing.peerSki`) {
      return;
    }
    if (!state.val) {
      return;
    }
    const control = id.slice(this.namespace.length + 1);
    if (control === "control.openPairing") {
      await this.sendCommand("pairing", { value: 1 });
      if (this.pairingTimer) {
        this.clearTimeout(this.pairingTimer);
      }
      this.pairingTimer = this.setTimeout(() => {
        void this.sendCommand("pairing", { value: 0 }).catch((error) => this.fail(error));
      }, 120000);
    } else if (["control.trustCurrentPeer", "control.untrustPeer"].includes(control)) {
      const selected = await this.getStateAsync("pairing.peerSki");
      const ski = normalizeSki(selected?.val);
      const local = await this.getStateAsync("info.localSki");
      if (ski === normalizeSki(local?.val)) {
        throw new Error("Cannot pair adapter with its own SKI");
      }
      await this.sendCommand(control === "control.untrustPeer" ? "untrust" : "trust", { ski });
    } else if (control === "control.checkPeer") {
      await this.sendCommand("status");
    }
    await this.setStateAsync(control, false, true);
  }

  async fail(error) {
    const text = error instanceof Error ? error.message : String(error);
    this.log.warn(text);
    await this.setStateAsync("diagnostics.lastError", text, true);
    await this.setStateAsync("diagnostics.status", "error", true);
  }

  onUnload(callback) {
    this.stopping = true;
    if (this.pairingTimer) {
      this.clearTimeout(this.pairingTimer);
    }
    if (this.retryTimer) {
      this.clearTimeout(this.retryTimer);
    }
    for (const pending of this.pending.values()) {
      this.clearTimeout(pending.timer);
      pending.reject(new Error("Adapter stopping"));
    }
    this.pending.clear();
    const child = this.child;
    if (!child) {
      callback();
      return;
    }
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        callback();
      }
    };
    const force = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, 4000);
    child.once("close", () => {
      clearTimeout(force);
      finish();
    });
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

if (require.main !== module) {
  module.exports = (options) => new EebusAdapter(options);
} else {
  new EebusAdapter();
}

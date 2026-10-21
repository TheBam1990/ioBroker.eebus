# ioBroker.eebus

EEBUS SHIP/SPINE participant for ioBroker, built on the enbility EEBUS stack.

Supports **LPC / LPP** as a Controllable System and **MPC** as a Monitored Unit, including TLS/WebSocket SHIP, mDNS discovery, persistent ECDSA identity, explicit persistent SKI trust, limit handling, heartbeat/failsafe restrictions and measurement publication.

This implements these three use cases for integration and testing. It is not a claim of EEBUS certification or support for every EEBUS use case.

## Electrician tool test

1. Start the adapter on TCP 4712. Use the same multicast-capable LAN as the test tool; discovery uses UDP 5353.
2. Find the local SKI in the first **Pairing / SKI** settings tab or in `eebus.0.info.localSki`. It remains stable after restarts. `info.qrCode` contains the standard SHIP QR-code payload.
3. Press `control.openPairing` (120-second window). Select the adapter in the tool and confirm its SKI.
4. Copy the tool's SKI from `discovery.peersJson` or `ship.peerSki` into `pairing.peerSki`, then press `control.trustCurrentPeer`. Confirm trust on both sides. No arbitrary peer is automatically trusted.
5. `info.connection` becomes true only after a real SHIP connection. Inspect `lpc`, `lpp` and `measurements` for use-case data.
6. To revoke persistent trust, select the peer SKI and press `control.untrustPeer`.

## Test power and physical devices

Simulation is enabled by default. `measurements.inputPowerW` supplies the requested simulated power (+consumption, -production), and the adapter publishes the limited result via MPC as a calculated measurement. For example, 6000 W input with LPC 2500 W produces 2500 W. Production uses negative signs, e.g. -7000 W input with LPP -3000 W produces -3000 W.

The adapter does **not** automatically control a physical device. For real integration, disable simulation, supply actual measured power to `measurements.inputPowerW` and implement the equipment-specific control using the received limits in `lpc` / `lpp`. In that mode MPC publishes the actual unmodified input measurement.

Input and limit units are watts. The instance settings define nominal consumption and production power. Invalid out-of-range limit writes are rejected. Init, expired limits and heartbeat loss apply failsafe restrictions; minimum failsafe durations and values are exposed through SPINE.

## Identity and diagnostics

A SHIP-compatible ECDSA certificate is generated once and stored in the instance data directory with its private key. Preserve this directory in backups along with persistent trusted SKIs. A corrupt identity is rejected rather than silently replaced. Certificate/key uploads remain supported, but must contain a matching SHIP-compatible certificate with a valid Subject Key Identifier.

`discovery.peersJson` lists discovered devices; `pairing.stateJson` shows pairing state; `ship.connectedPeersJson` lists established peers. `diagnostics.lastError` and the adapter log provide diagnostics. Select network interface names such as `eth0` in the SHIP settings if automatic selection chooses an unsuitable interface. The TLS-only peer-IP probe from 0.1.x is retired.

[Ausführliche deutsche Anleitung](README.de.md)

## Development

Node >=22; Go >=1.24.4 for building the native protocol process. Users do not need Go when installing a package with a matching binary.

```
npm ci
npm run build:bridge
npm run check
npm run lint
npm test
cd bridge && go test ./...
```

`test/network.py` uses `bridge/cmd/test-peer` for real SHIP/SPINE networking, limit writes and MPC feedback. The EEBUS stack is pinned in `bridge/go.mod` / `go.sum`. See `NOTICE` and `licenses/` for third-party licensing.

## Changelog

### 0.2.1

- Added a dedicated Pairing / SKI settings tab with the persistent local SKI and pairing controls.
- Included native protocol executables for supported Linux, Windows and macOS platforms.

### 0.2.0

- Added SHIP/SPINE, mDNS, persistent SKI identity and explicit trusted pairing.
- Added LPC, LPP and MPC use cases with simulated power response for testing.

## License

MIT, copyright (c) TheBam. Bundled third-party components retain their own licenses.

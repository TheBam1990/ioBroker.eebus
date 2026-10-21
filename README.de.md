# ioBroker.eebus

EEBUS-Teilnehmer mit SHIP (TLS/WebSocket), mDNS/DNS-SD und SPINE auf Basis des enbility-Stacks.
Unterstützt werden LPC und LPP als **Controllable System** sowie MPC als **Monitored Unit**.
Das ist eine Implementierung für Integration und Tests; eine EEBUS-Zertifizierung oder die Unterstützung aller EEBUS-Anwendungsfälle wird nicht behauptet.

## Test mit dem EEBUS-Handwerkertool

1. Adapter starten. Standardport: TCP **4712**. PC und ioBroker müssen sich im gleichen Multicast-fähigen LAN befinden. Für Discovery wird UDP 5353 benötigt.
2. Im ersten Reiter **Pairing / SKI** der Adaptereinstellungen und unter **Objekte → eebus.0.info.localSki** steht der dauerhafte lokale SKI. Er stammt aus dem X.509 Subject Key Identifier, nicht aus dem Zertifikat-Fingerprint. `info.qrCode` enthält die SHIP-QR-Code-Zeichenfolge.
3. `control.openPairing` betätigen. Das öffnet das Fenster für eingehende Kopplungsanfragen für 120 Sekunden. Es vertraut keinem fremden Gerät automatisch.
4. Im Handwerkertool den ioBroker auswählen und dessen SKI vergleichen/bestätigen.
5. Der SKI des Tools steht in `discovery.peersJson` bzw. nach einer Anfrage in `ship.peerSki`. Diesen in `pairing.peerSki` eintragen und `control.trustCurrentPeer` betätigen. Damit wird genau dieser Teilnehmer dauerhaft freigegeben. Die Freigabe auf beiden Seiten abschließen.
6. Erst ein vollständiger SHIP-Verbindungsaufbau setzt `info.connection` auf true. Der eigene TCP-Listener zählt nicht als Verbindung.
7. Im Tool LPC/LPP prüfen: `lpc.limitW`, `lpp.limitW`, `active`, `durationSeconds`, `effectiveMaxW` und `failsafe` zeigen den Zustand. LPP verwendet negative Leistungswerte; effektive Obergrenzen werden als positive Beträge angezeigt.
8. MPC liefert `measurements.powerW`. `measurements.inputPowerW` ist der Eingang: positive Werte = Verbrauch, negative Werte = Erzeugung; Einheit immer **W**.

## Simulation und reale Anlage

Standardmäßig ist die Simulation eingeschaltet. Eine Eingangsleistung von 6000 W wird anhand empfangener Limits begrenzt und als berechneter MPC-Wert veröffentlicht. Beispiel: Eingang 6000 W, LPC 2500 W → MPC 2500 W. Für LPP z.B. Eingang -7000 W und Limit -3000 W → MPC -3000 W.
Im Init-/Failsafe-Zustand gelten die konfigurierten Failsafe-Grenzen (initial 4200 W).

**Das schaltet oder regelt keine reale Anlage.** Für reale Integration Simulation ausschalten und echte Messwerte nach `measurements.inputPowerW` schreiben. Die über `lpc` und `lpp` ausgegebenen Grenzen müssen durch eine geeignete Anlagensteuerung umgesetzt werden. Im Realmodus wird der tatsächliche Messwert unverändert über MPC übertragen, auch wenn er ein Limit überschreitet.

Nennleistungsgrenzen werden in der Instanz konfiguriert. Ungültige oder außerhalb der Nennleistung liegende LPC/LPP-Schreibbefehle werden abgelehnt. Ablaufzeiten und fehlende Heartbeats führen zur Failsafe-Begrenzung; die Mindestdauer und Failsafe-Werte werden über SPINE bereitgestellt.

## Zertifikat und Vertrauen

Ohne hochgeladenes Zertifikat wird einmal ein SHIP-kompatibles ECDSA-P256-Zertifikat erstellt und im Instanzdatenverzeichnis gespeichert. Ein Neustart ändert den SKI nicht. Zertifikat/Schlüssel und bestätigte SKIs müssen in Backups erhalten bleiben. Ein beschädigtes Zertifikat wird nicht stillschweigend neu erzeugt.
Vorhandene Zertifikats-Uploads sind weiterhin möglich; der Schlüssel muss passen und das Zertifikat einen gültigen SHIP-SKI enthalten. Ungeeignete Zertifikate führen zu einem sichtbaren Startfehler.
`control.untrustPeer` entfernt den ausgewählten SKI aus der dauerhaften Freigabe und trennt die Verbindung.

## Netzwerk und Diagnose

- In **SHIP → Network interfaces** können Betriebssystem-Schnittstellen wie `eth0` ausgewählt werden (kommagetrennt). Leer = automatische Auswahl.
- `discovery.peersJson`: tatsächlich per mDNS gefundene Teilnehmer.
- `pairing.stateJson`: SHIP-Pairing-Zustand und Fehler.
- `ship.connectedPeersJson`: tatsächlich verbundene Teilnehmer.
- `pairing.trustedPeersJson`: dauerhaft freigegebene SKIs.
- `diagnostics.lastError`: letzter Fehler; das ioBroker-Log enthält weitere Details.
- Die alten Peer-IP-/TLS-Probeeinstellungen aus 0.1.x werden nicht mehr verwendet. EEBUS-Partner werden über Discovery und SKI ausgewählt.

## Entwicklung

Node.js >=22; zum Bauen des Protokollprozesses Go >=1.24.4. Installierte Anwender benötigen kein Go.

```
npm ci
npm run build:bridge
npm run check
npm run lint
npm test
cd bridge && go test ./...
```

`test/network.py` zusammen mit `bridge/cmd/test-peer` testet echte SHIP/SPINE-Verbindungen, Limits und MPC-Rückmeldungen, nicht nur einen TCP-Port.
Abhängigkeiten sind in `bridge/go.mod` und `go.sum` festgelegt. Lizenzhinweise stehen in `NOTICE` und `licenses/`.

### 0.2.1

- Eigener Einstellungsreiter Pairing / SKI mit dauerhaftem lokalem SKI und Kopplungsfunktionen.
- Native Protokollprogramme für die unterstützten Linux-, Windows- und macOS-Plattformen enthalten.

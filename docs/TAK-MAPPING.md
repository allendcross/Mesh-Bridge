# Mesh → TAK Mapping (semantics, channels, AI)

How Meshtastic data is represented in TAK. The goal: move mesh data into the
*right* TAK areas with the *right* semantics — a repeater shouldn't look like a
soldier, a private channel shouldn't be confused with public traffic.

All of this is **bridge-side** translation; the TAK Server is just a relay.

## 1. Node classification ✅ DONE

A mesh node is a **device, not a person**. Previously every node was emitted as
`a-f-G-U-C` (friendly ground *combat unit*), so repeaters and sensors showed up
as infantry. Now the bridge classifies each node and emits an appropriate CoT
symbol.

**Classification** (`bridge-server/services/nodeClassification.mjs`), driven by
the Meshtastic device **role** (captured from NodeInfo) with telemetry fallback:

| Category | Triggered by | Default CoT type |
|----------|-------------|------------------|
| `unit` | role TAK / TAK_TRACKER / TRACKER | `a-f-G-U-C` |
| `sensor` | role SENSOR, or reports temp/humidity/pressure | `a-f-G-E-S` |
| `infrastructure` | role ROUTER / ROUTER_CLIENT / REPEATER / ROUTER_LATE | `a-f-G-E-X-N` |
| `radio` | plain CLIENT / unknown (the default) | `a-f-G-E-X-C` |

- The category→type map is **configurable** (`cot.nodeTypes`); the table above is
  the default. Exact deep CoT sub-codes can be tuned per deployment (some ATAK
  builds fall back to a generic affiliation shape for uncommon sub-types — so the
  category is also written into the marker **remarks** for human readability:
  `Radio · DIY_V1_JP_RX · role CLIENT · batt 99%`).
- Toggle: **Integrations → TAK Feed → "Classify nodes by role"** (`cot.classifyNodes`,
  default on). Off = legacy behavior (everything `a-f-G-U-C`).
- Verified: live mesh now emits a mix of `a-f-G-E-X-C` (radios), `a-f-G-E-X-N`
  (relays), and `a-f-G-U-C` (TAK-role units) instead of all units.

Captured per node: `role` (NodeInfo `User.role`), shown in the Tactical node popup.

### Bridge home location ✅ DONE

The bridge's **own** radio(s) are stationary at a known spot, but their GPS is
often missing/wrong, so they'd appear far off in TAK. Set a **home location**
(`cot.homeLat`/`cot.homeLon`) and the bridge overrides its own radios' position
with it when emitting CoT — `index.mjs` `applyCotHome()` / `isOwnRadioNode()`
(matches `radio.nodeNum`). Set it in **TAK Feed settings → Bridge Home Location**
(address geocode via Nominatim, or manual lat/lon; blank = use radio GPS). Only
affects the outbound CoT, not the radio's reported position elsewhere.

## 2. Channel → TAK area (PLANNED)

The Meshtastic **channel is the trust/segmentation boundary** and should map to
TAK's affiliation + group:

- **Private team channel** → friendly (`a-f-…`) + a team color/group.
- **Public (LongFast) channel** → neutral/unknown (`a-n-…` / `a-u-…`), a "PUBLIC"
  tag, or not forwarded at all — you can't verify those nodes.
- We already capture each node's `channelIndex` + `channels[]`, so the affiliation
  digit and team color can be chosen per channel. Deeper segmentation (a distinct
  TAK Server *group* per channel) needs per-group feeds (more involved).

## 3. GeoChat ↔ mesh text bridge (PLANNED)

Relay text between a mesh channel and a TAK GeoChat room (both directions). Lets
mesh users *without* smartphones converse with ATAK/WinTAK operators. Inbound
GeoChat already arrives via `CotIngestService` (`tak-chat`); outbound would send a
`b-t-f` CoT and a mesh text packet.

## 4. AI SITREPs + SOS alerts (PLANNED)

- **AI SITREPs:** the bridge posts AI summaries as GeoChat into a TAK room (timer
  or on command) — e.g. "3 new nodes, 1 low battery, NWS severe alert."
- **SOS → emergency CoT:** the existing SOS detector emits an *emergency* CoT
  (alerting event) so it alarms in ATAK rather than appearing as a normal marker.

---

See [TAK-INGEST.md](TAK-INGEST.md) for the inbound CoT pipeline and
[TAKSERVER.md](TAKSERVER.md) for the server deployment.

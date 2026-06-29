# TAK Ingest — Inbound CoT for a Common Operating Picture

**Status:** ✅ COMPLETE — all 5 phases shipped.

## Phases 3–5 — done

- **Phase 3 (drawings):** `TacticalView` renders `kind:'drawing'` tracks from their
  `<link>` geometry — freeform/rectangles (`u-d-f`/`u-d-r`) as filled Leaflet
  `Polygon`s, routes/lines as `Polyline`s, team-colored, with popups.
- **Phase 4 (GeoChat):** collapsible GeoChat panel (bottom-right of the map) showing
  inbound `b-t-f` messages (sender → room, text, time) from the `takChat` store list.
- **Phase 5 (settings):** "TAK Ingest (Monitor)" card in `CotSettings.tsx` — enable
  toggle, host/port, cert name, GeoChat + drawings checkboxes. Wired through
  `webSocketManager` (`get/set-tak-ingest-config`) + store (`getTakIngestConfig`/
  `setTakIngestConfig`), requested on connect. Verified config round-trip over WS.

## Phase 2 — done (frontend contacts + markers)

Verified: ChopsTrop/ChopsWinTAK appear as TAK contacts on `TacticalView`.
- `types.ts` — `TakContact` / `TakChatMessage`.
- `webSocketManager.ts` — handle `tak-update`/`tak-remove`/`tak-chat`, emit events.
- `useStore.ts` — uid-keyed `takContacts` map (upsert/remove) + `takChat`, swept
  every 15s by CoT `stale` time (fallback 10 min). `App.tsx` passes `takContacts`
  to the tactical tab.
- `TacticalView.tsx` — TAK markers on the map (team-colored circle for contacts,
  amber diamond for markers) + popups + the sidebar **TAK** source bucket/filter.
- **Op note:** only ONE connection may use the `meshbridge-monitor` cert at a time
  — duplicate identities make TAK Server deliver to just one (don't run a manual
  `openssl` capture with that cert while the bridge ingest is live).

Phases 3–5 remaining: drawings/shapes geometry, GeoChat panel, settings card.

## Phase 1 — done (backend ingest)

Implemented & verified end-to-end (bridge ingests ChopsWinTAK's position and
broadcasts it over WS):
- `meshbridge-monitor` client cert minted + registered in `__ANON__`.
- `bridge-server/services/CotIngestService.mjs` — mutual-TLS to `:8089`, identity
  CoT, frame reassembly on `</event>`, regex parse + classify, drops `t-x-*`
  control events and own `meshtastic-*`/`adsb-*` echoes, reconnect-with-backoff.
- `index.mjs` — `takIngest` config (load/save), `startTakIngestService()` on boot,
  `get/set-tak-ingest-config` WS handlers, broadcasts ingest payloads to clients.

### WebSocket message contract (what Phase 2 consumes)

```jsonc
// contact (other TAK client) or marker (dropped point) or drawing
{ "type": "tak-update", "contact": {
    "uid": "...", "source": "tak",
    "kind": "contact" | "marker" | "drawing",
    "cotType": "a-f-G-U-C-I", "callsign": "ChopsWinTAK",
    "lat": 36.27, "lon": -115.23,
    "team": "Maroon", "role": "Team Member",
    "course": 0, "speed": 0,          // contacts w/ <track>
    "platform": "WinTAK-CIV",          // contacts w/ <takv>
    "remarks": "...", "stale": "2026-…Z",
    "points": [[lat,lon], …]           // drawings only
} }
// GeoChat
{ "type": "tak-chat", "chat": { "uid","room","sender","text","time" } }
// removal (CoT delete t-x-d-d)
{ "type": "tak-remove", "uid": "..." }
```

Frontend (Phase 2): handle these in `webSocketManager.ts`, store
`takContacts`/`takMarkers`/`takDrawings` (keyed by uid, expire on `stale`) +
`takChat`, render under the existing **TAK** source filter in `TacticalView`.

---

**Original design below.**



## Quick start for the implementation session

Start at **Phase 1** below. Concrete first steps:

1. **Mint the monitor cert** (one-time, on the host — same pattern that worked for
   ChopsTrop / ChopsWinTAK):
   ```bash
   sudo docker run --rm --entrypoint bash \
     -e STATE=Nevada -e CITY=LasVegas -e ORGANIZATIONAL_UNIT=MeshBridge -e CAPASS=atakatak -e PASS=atakatak \
     -v /opt/takserver/tak:/opt/tak -w /opt/tak/certs takserver:5.7 \
     -c "./makeCert.sh client meshbridge-monitor"
   sudo docker exec takserver bash -c 'cd /opt/tak && java -jar utils/UserManager.jar certmod certs/files/meshbridge-monitor.pem'
   ```
   Cert lands at `/opt/takserver/tak/certs/files/meshbridge-monitor.{pem,key}` in `__ANON__`.
2. **Build `CotIngestService.mjs`** (Node `tls.connect` to `127.0.0.1:8089`, send an
   identity CoT, buffer + split on `</event>`, parse/classify, drop `meshtastic-*`/
   `adsb-*`). Reference: `CotService.mjs` for the reconnect/queue patterns.
3. **Live test data already exists** — these clients are connected and broadcasting,
   so the ingest can be verified immediately against real traffic:
   - `ChopsTrop` (iPhone/TROP, team Magenta) — position updates
   - `ChopsWinTAK` (Windows/WinTAK, team Maroon) — position updates
   - `WebTAK` (team Cyan)
   - A dropped **marker "Walmart Evil HQ"** (`b-m-p-*`) to confirm marker parsing
   - Drop a **GeoChat** from any client to confirm `b-t-f` parsing
4. Sanity-check the raw stream first with the admin cert (proves what XML to parse):
   `( printf '<identity cot>\n'; sleep 10 ) | sudo openssl s_client -connect 127.0.0.1:8089 -cert /opt/takserver/tak/certs/files/admin.pem -key …/admin.key -pass pass:atakatak -quiet`

---

**Goal:** Make the bridge a *bidirectional* TAK client. Today it only **feeds** CoT
to the TAK Server (mesh nodes + ADS-B aircraft, via the 8087 anonymous input). This
feature adds the **inbound** half: the bridge **subscribes** to the TAK Server's CoT
stream and displays what TAK users broadcast — positions, markers, drawings, and
**GeoChat** — on the bridge's own TAK monitoring map (`TacticalView`).

Result: one screen showing mesh + ADS-B (outbound) *and* the full TAK situational
picture (inbound) — a true common operating picture.

## Current state (why this is needed)

- `bridge-server/services/CotService.mjs` is **send-only** (no receive handler).
- No code subscribes to the server's CoT stream.
- The frontend already has a **TAK** source filter in `TacticalView`'s sidebar, but
  nothing feeds it real data.

See [TAKSERVER.md](TAKSERVER.md) for the server deployment this connects to.

## Architecture

```
TAK clients (ChopsTrop, ATAK, WebTAK)
        │  CoT (positions, markers, drawings, GeoChat)
        ▼
   TAK Server :8089  (mutual-TLS, __ANON__ group)
        │  subscribe (NEW)                ▲ feed (existing, :8087)
        ▼                                 │
   CotIngestService  ─── tak-update ──▶  Bridge WS  ──▶  Frontend (TacticalView + GeoChat panel)
   (new)                                  CotService (existing)
```

### New: `bridge-server/services/CotIngestService.mjs`

- **Connect** to `:8089` over **mutual-TLS** (Node `tls.connect`) using a dedicated
  **`meshbridge-monitor`** client cert (NOT `admin`), registered in `__ANON__`.
- On connect, send an **identity CoT** so the server adds us to the group and streams
  group traffic. Do **not** announce TAK protobuf support → the server sends **XML CoT**
  (verified: a plain TLS client receives XML), which we parse directly.
- **Frame reassembly:** TCP delivers partial events; buffer and split on `</event>`.
- **Parse & classify** each `<event>` by `type`:
  | Class | CoT type prefix | Notes |
  |-------|-----------------|-------|
  | `tak-contact` | `a-f/a-h/a-n/a-u-…` **with** `<takv>` | other TAK clients (callsign, team/role, course/speed) |
  | `tak-marker`  | `a-…-G`, `b-m-p-*`, `u-d-p` (no `<takv>`) | dropped points (e.g. "Walmart Evil HQ") |
  | `tak-drawing` | `u-d-f` / `u-d-r` / `u-d-c-c` / route | shapes, circles, routes (carry `<link>` geometry) |
  | `tak-chat`    | `b-t-f` | GeoChat — parse `<__chat>` (room, sender) + `<remarks>` (text) |
  | *(delete)*    | `t-x-d-d` | remove referenced uid from the map |
- **Loop prevention:** drop uids starting `meshtastic-` or `adsb-` (our own feed
  relayed back to the group).
- **Stale handling:** carry each event's `stale` time; the frontend expires markers/
  contacts when stale passes (mesh/ADS-B already do this).
- **Emit** normalized objects: `tak-update` (contact/marker/drawing), `tak-chat`,
  `tak-remove`.

### `bridge-server/index.mjs`

- Instantiate `CotIngestService` alongside `CotService`; share `cot.certsPath`.
- New config block (`bridge-config.json`):
  ```json
  "takIngest": {
    "enabled": false,
    "host": "192.168.0.198",
    "port": 8089,
    "certName": "meshbridge-monitor",
    "includeGeoChat": true,
    "includeDrawings": true
  }
  ```
- WebSocket: broadcast `tak-update` / `tak-chat` / `tak-remove` to all clients; accept
  `set-tak-ingest-config` and `get-tak-ingest-config` like the existing cot config.

### Cert (one-time)

```bash
cd /opt/takserver/tak/certs
./makeCert.sh client meshbridge-monitor
java -jar /opt/tak/utils/UserManager.jar certmod certs/files/meshbridge-monitor.pem
```
Lands in `__ANON__`, so it receives the same group traffic ChopsTrop does.

### Frontend

- `src/renderer/lib/webSocketManager.ts`: handle `tak-update` / `tak-chat` /
  `tak-remove`; emit events; expire stale entries.
- `src/renderer/store/useStore.ts`: `takContacts` / `takMarkers` / `takDrawings` maps
  (keyed by uid, stale-expired) + `takChat` message list. Persist chat briefly.
- `src/renderer/components/TacticalView.tsx`: render TAK contacts (person icon w/ team
  color), markers (pin + label), drawings (Leaflet polylines/polygons/circles) under
  the existing **TAK** source filter; add a collapsible **GeoChat** panel.
- `src/renderer/components/CotSettings.tsx` (TAK Feed page): add an **"Ingest / Monitor"**
  card — enable toggle, host/port, cert name, GeoChat + drawings toggles.

## Implementation phases

1. **Backend ingest** — `CotIngestService` (TLS connect, identity, frame split, parse,
   classify, loop filter), cert, config, WS broadcast. *Verify with `tcpdump`/logs.*
2. **Frontend contacts + markers** — store maps + `TacticalView` rendering under the TAK
   filter; stale expiry. *Verify ChopsTrop + "Walmart Evil HQ" appear on the bridge map.*
3. **Drawings/shapes** — parse `<link>` geometry → Leaflet shapes.
4. **GeoChat** — panel showing inbound `b-t-f` messages (room, sender, text, time).
   *(Optional follow-up: send GeoChat from the bridge.)*
5. **Settings UI** — the Ingest/Monitor card in CotSettings.

## Risks / notes

- **Protobuf vs XML:** TAK Server speaks XML CoT unless the client negotiates the TAK
  protobuf protocol. Our ingest client stays XML-only (simpler, already verified).
- **Volume / echo:** we filter our own `meshtastic-*` / `adsb-*` uids so the 122 nodes +
  aircraft we publish don't bounce back onto the map. Genuine TAK traffic is low volume.
- **Reconnect:** mirror `CotService`'s reconnect-with-backoff for the ingest socket.
- **Security:** the monitor cert is a real credential; keep it on the host with the other
  certs, not in git.

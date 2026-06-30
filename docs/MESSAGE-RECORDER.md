# Message Recorder

A durable, **server-side** log of every message the bridge hears. The bridge is an
always-on station at a fixed location, so this builds a complete record of the
public channel (and any private channel like `chopstak`) that **survives restarts**
and isn't tied to a browser's localStorage — so a fixed station's full history can
be compared against a mobile node's partial view.

## How it works

- `bridge-server/services/MessageRecorderService.mjs` appends every text message to
  a daily JSONL file: `bridge-server/data/messages/messages-YYYY-MM-DD.jsonl`
  (one JSON object per line).
- Hooked in `index.mjs` at the message-creation path (`recordMessage()`), so it
  captures **all** channels — including messages on a public channel that's been
  disabled for forwarding (those are tagged `blocked`).
- Each record: `ts, id, channel, channelName, from, fromId, fromName, to, text,
  radioId, blocked, forwarded`.
- Retention: day-files older than `retentionDays` (default **365**) are pruned every
  6 hours. Config persists in `bridge-config.json` under `messageRecorder`.

## Viewing / exporting

**Recorder** tab in the web UI (under Network):
- Overview: total recorded, days on record, date range, count in current view.
- Filter by **channel**, **day**, and **text/sender search**.
- Export the current view as **CSV** or **JSONL**.

## WebSocket API

- `get-message-log` `{ date?, channelIndex?, search?, limit?, sinceMs? }` →
  `message-log` `{ records, days, query }`
- `get-message-recorder-stats` → `message-recorder-stats`
  `{ enabled, retentionDays, total, days, byChannel, oldest, newest }`
- `set-message-recorder-config` `{ enabled?, retentionDays? }`

## Notes

- Only text messages are recorded (not position/telemetry/nodeinfo packets).
- The in-memory `messageHistory` (last 1000) and the browser localStorage copy are
  unchanged; this adds a durable on-disk record alongside them.

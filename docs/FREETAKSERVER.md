# FreeTAKServer (TAK Server) Setup

This bridge can feed mesh nodes and ADS-B aircraft into a TAK server so ATAK/WinTAK
clients see them. We run **FreeTAKServer (FTS)** in Docker alongside the bridge.

## What's running

- **FreeTAKServer** in Docker (`ghcr.io/freetakteam/freetakserver:latest`, bundles Python 3.11).
- Deployment lives on the host at **`/opt/freetakserver/`** (`docker-compose.yml` + `data/`).
- The bridge streams **CoT over TCP** to FTS on port **8087**; FTS serves ATAK clients.

### Ports

| Port | Purpose | Published on host? |
|------|---------|--------------------|
| 8087 | CoT streaming (TCP) — bridge feeds here; ATAK connects here | ✅ |
| 8089 | CoT streaming (TLS) | ✅ |
| 19023 | FTS REST API | ✅ |
| 8443 | Data package / HTTPS | ✅ |
| 8080 | FTS data-package HTTP (inside container only) | ❌ — host 8080 is the mesh bridge |

> The mesh bridge owns host port 8080, so FTS's internal 8080 is **not** published to avoid a conflict.

## Managing FTS

```bash
cd /opt/freetakserver
sudo docker compose ps                 # status
sudo docker compose logs -f            # live logs
sudo docker compose restart            # restart
sudo docker compose down               # stop
sudo docker compose up -d              # start
```

Config is at `/opt/freetakserver/data/FTSConfig.yaml` (owned by uid 999, the container's
`freetak` user). `FTS_DP_ADDRESS` / `FTS_USER_ADDRESS` are set to the host's reachable IP.

## How the bridge feeds it

The bridge's CoT output (see `bridge-server/services/CotService.mjs`) has two outputs:

- **UDP multicast** to `239.2.3.1:6969` — LAN ATAK auto-discovery (no server needed).
- **TCP feed** to a TAK server — set `cot.tcpHost` / `cot.tcpPort` in `bridge-config.json`
  (here `127.0.0.1:8087`). Events are **paced through a queue** (one per ~30 ms) because
  FreeTAKServer mis-parses multiple CoT events coalesced in one TCP read.

Enable/configure via the **TAK Feed** card on the Tactical page, or `set-cot-config`.

## Connecting ATAK

Add a TAK Server in ATAK pointing at this host on **8087** (TCP, streaming). On the LAN use
the host IP; remotely, use the **Tailscale IP/hostname** (FTS is reachable over the tailnet
since it's a TCP connection — unlike the multicast path, which stays on the LAN).

For TLS (8089) you'd generate/enroll client certs in FTS — not configured yet.

## Notes / TODO

- Set `FTS_DP_ADDRESS`/`FTS_USER_ADDRESS` to the **Tailscale IP** once Tailscale is installed,
  so data packages resolve for remote clients.
- TLS CoT (8089) + client cert enrollment is not set up (plain TCP 8087 works today).
- FTS web UI (FreeTAKServer-UI) is a separate container, not deployed here yet.

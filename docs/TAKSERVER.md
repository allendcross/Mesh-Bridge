# Official TAK Server (5.7) — Deployment & Integration

This bridge feeds Meshtastic nodes + ADS-B aircraft into an **official TAK Server**
(from tak.gov) so ATAK/iTAK/TROP clients see them. The server runs in Docker
**on the same host**, alongside the bridge. (It replaced an earlier FreeTAKServer
trial, which could not do certificate enrollment.)

> The TAK Server itself is **not** in this repo (it's the licensed tak.gov package).
> It's deployed on the host at **`/opt/takserver/`**. This doc records how it was
> built and how the bridge connects to it, so it's reproducible.

## What's running

- Source: `takserver-docker-5.7-RELEASE-43.zip` from tak.gov, extracted to `/opt/takserver`.
- Two images built from the package's Dockerfiles:
  - `takserver:5.7` (Java 17 / eclipse-temurin) — runs config/messaging/api/retention/plugin JVMs
  - `takserver-db:5.7` (postgres:15 + PostGIS) — the `cot` database
- Orchestrated by a hand-written `/opt/takserver/docker-compose.yml` (the package ships no compose):
  services `takserver` + `tak-database` on network `taknet`, DB volume `tak-db-data`,
  JVM heaps capped for an 8 GB box.

### Ports

| Port | Purpose | Published |
|------|---------|-----------|
| 8089 | CoT streaming (TLS, mutual-auth) — TAK clients connect here | ✅ |
| 8087 | anonymous TCP input — **the mesh bridge's CoT feed** | ✅ |
| 8443 | Marti API / admin web UI (requires admin client cert) | ✅ |
| 8446 | certificate enrollment (username/password) | ✅ |
| 8444 | federation | ✅ |

## Build / setup outline (reference)

1. **Build images** (package has Dockerfiles only):
   `docker build -t takserver-db:5.7 -f docker/Dockerfile.takserver-db docker/`
   `docker build -t takserver:5.7 -f docker/Dockerfile.takserver docker/`
2. **Certs** (run in a throwaway `takserver:5.7` container, `--entrypoint bash`, with
   `STATE/CITY/ORGANIZATIONAL_UNIT` env + `CAPASS=atakatak`):
   `./makeRootCa.sh --ca-name MeshBridge-CA`, `./makeCert.sh server takserver`,
   `./makeCert.sh client admin`. The server cert SAN was patched to include the LAN IP
   (`192.168.0.198`) so IP clients validate. A CA signing keystore `ca-signing.jks`
   (CA cert + key) was created for enrollment.
3. **CoreConfig.xml** — from `CoreConfig.example.xml`: set the DB `<connection password>`,
   enable `<certificateSigning CA="TAKServer">` pointing at `ca-signing.jks`, and add the
   `stdtcp` 8087 anonymous input for the bridge feed.
4. **DB init gotchas (cost real time — documented so they don't recur):**
   - The DB volume is root-owned but `initdb` runs as `postgres` → must
     `chown postgres /var/lib/postgresql/15/data` **before** initdb.
   - Add `-c listen_addresses=*` to the `pg_ctl` start opts (else only localhost).
   - Guard `initdb` (`[ ! -f .../PG_VERSION ]`) so restarts don't corrupt the cluster.
   - These are patched into `tak/db-utils/configureInDocker.sh`.
5. **Start:** DB first (`docker compose up -d tak-database`, wait for schema), then
   `docker compose up -d takserver`.
6. **Users:** `java -jar utils/UserManager.jar certmod -A certs/files/admin.pem` (admin),
   and `usermod -p '<pass>' <name>` for enrollment/password users (password rules: ≥15
   chars, upper+lower+number+special). All users default into the `__ANON__` group.

## Managing it

```bash
cd /opt/takserver
sudo docker compose ps
sudo docker compose logs -f takserver        # note: retention service logs harmless DB "refused" — ignore
sudo docker compose restart takserver
```
- Admin UI: import `certs/files/admin.p12` (pass `atakatak`) into a browser → `https://192.168.0.198:8443`.
- Enrollment/user credentials are stored on the host at `/opt/takserver/ENROLLMENT-CREDENTIALS.txt` (not in git).

## How the bridge connects to it

The bridge's CoT output (`bridge-server/services/CotService.mjs`) streams over **TCP to
`127.0.0.1:8087`** (the anonymous input). Configure via **Integrations → TAK Feed** or
`bridge-config.json` `cot.tcpHost`/`tcpPort`. LAN **multicast is disabled** (`cot.multicastEnabled=false`)
so clients get a single clean feed via the server (multicast would also duplicate, since
TAK clients auto-listen on 239.2.3.1:6969).

The bridge also builds **client connection packages** for the data-package path:
`GET /api/tak-datapackage?host=&port=8089` reads the TAK Server CA at
`cot.certsPath` (= `/opt/takserver/tak/certs/files`) and bundles CA + a client cert + a
`…:8089:ssl` profile.

## Connecting a phone (what actually worked)

Per-device certs: `./makeCert.sh client <callsign>` then
`UserManager.jar certmod certs/files/<callsign>.pem` (registers it in `__ANON__`).

- **iTAK / TROP (iOS):** the reliable method is **"Upload Certificate (.p12)"** — load the
  client `.p12` (pass `atakatak`), then **Retry**. (Data-package import on TROP reported
  "no user certificate found"; enrollment is also offered but see the known issue below.)
- **ATAK (Android):** enrollment QR / "Enroll from Server" — **once the issue below is fixed.**

## Known issues / TODO

- **Enrollment signing is broken:** `POST /Marti/api/tls/signClient/v2` (port 8446) returns
  "TAK Server resource unavailable or not allowed" even though `ca-signing.jks` holds the CA
  key and `certificateSigning` is configured. So username/password enrollment + the enroll
  **QR** don't issue certs yet. Cert **upload** works around it. Needs debugging.
- **Tailscale not installed:** the server cert covers the LAN IP only. When Tailscale is
  added, regenerate the server cert with the tailnet name in the SAN and rebuild client
  packages with the tailnet host.

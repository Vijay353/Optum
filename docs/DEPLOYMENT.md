# Deployment: one small VPS (V3 CH-22)

Status: **CONFIGURED** for a live server, **TESTED_LOCALLY** for the container (CH-22A). Nothing has been deployed. No server, DNS name, PIN or analytics ID was provided, and deploying or pushing needs the owner's authorization.

EvidenceBridge runs as **one Node process in one container**: the built React UI, the API and the four simulators share one origin. SQLite lives on a mounted volume. This is a stateful single-instance service: one writer container, never replicas sharing the same SQLite file, never a database that lives only inside the container.

All data is synthetic. The access gate (CH-20) is a convenience gate for a portfolio demo, not strong authentication.

## What is in the repository

| File | Purpose |
|---|---|
| `Dockerfile` | Two-stage build. `npm ci` from the lockfile, `npm run build`, `npm run check:bundle`, `npm prune --omit=dev`. Runtime runs as user `node`, binds `0.0.0.0:${PORT}`, database at `/data/evidencebridge.sqlite`. Base image pinned by the `NODE_IMAGE` build argument (default `node:22.22.0-bookworm-slim`). |
| `.dockerignore` | Keeps `.env`, `.git`, `node_modules`, `data/runtime` and every `*.sqlite` file out of the build context. |
| `GET /healthz` | Read-only readiness check (`{"ok":true}`, runs `SELECT 1`). No details. Not behind the access gate. |
| `scripts/bootstrap.ts` | First install only: loads the sample scenario if the database is empty. Safe to rerun; it never changes a database that has records. |
| `scripts/backupDb.ts` | Consistent backup with the SQLite online backup API, then opens the copy and compares row counts, integrity and both audit chains with the source. Keeps the newest `EB_BACKUP_KEEP` (default 14). |

`tsx` is a production dependency because the server runs from TypeScript source (`node --import tsx server/index.ts`). `cross-env` is not in the image, so inside the container call scripts with `node --import tsx scripts/<name>.ts`, not `npm run <name>`.

## Startup rules (enforced in code)

1. The database directory must be writable. If not, the process logs `Database directory /data is not writable ... Refusing to start.` and exits with code 1.
2. A database that holds records is **never** reseeded or reset on restart or redeploy (`Existing database. No reseed on restart.`).
3. An empty database is seeded once with the sample scenario, unless `EB_BOOTSTRAP=never`. Then run the bootstrap script by hand.
4. Simulator calls inside the process always go over `127.0.0.1`, whatever the public bind address.

## Environment variables (set in the panel, never in the image)

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Set by the image. |
| `PORT` | `8787` | Set by the image. `EB_PORT` wins if both are set. |
| `EB_HOST` | `0.0.0.0` | Set by the image. Local default is `127.0.0.1`. |
| `EB_DB_PATH` | `/data/evidencebridge.sqlite` | Set by the image. `DATABASE_PATH` is accepted as an alias. |
| `EB_MODE` / `EB_EXTRACTOR` | `SIMULATED` / `fixture` | Set by the image. |
| `EB_BOOTSTRAP` | `seed-if-empty` (default) or `never` | Use `never` if you want to seed by hand. |
| `EB_ACCESS_PIN` | exactly 4 digits | CH-20. Secret. Required when the server binds a non-loopback address. |
| `EB_SESSION_SECRET` | 32+ random characters | CH-20. Secret. Generate with `openssl rand -hex 32`. |
| `EB_SESSION_TTL_MINUTES` | `120` | CH-20. |
| `EB_TRUST_PROXY` | `1` behind Coolify's single proxy | CH-20. Leave unset when nothing sits in front. Never higher than the real number of proxies. |
| `EB_CLARITY_PROJECT_ID` | from your Clarity dashboard | CH-21. Public identifier, not a secret, read at runtime (no rebuild). Sent to the browser only after gate entry. Absent means no analytics. Never invent one. |

## Local container test (done, CH-22A)

Docker Hub was blocked by this environment's network allowlist, so the base image could not be pulled. The test used a stand-in base image assembled from this machine's own Node 22.22.0 runtime, passed with `--build-arg NODE_IMAGE=eb-standin-node:22.22.0`. The Dockerfile itself was unchanged. Re-run this check with the official image before any live deploy:

```bash
docker build -t evidencebridge:local .
mkdir -p ./ebdata && sudo chown 1000:1000 ./ebdata
docker run -d --name eb -p 127.0.0.1:8787:8787 -v "$PWD/ebdata:/data" \
  -e EB_ACCESS_PIN=1234 -e EB_SESSION_SECRET="$(openssl rand -hex 32)" evidencebridge:local
curl -s http://127.0.0.1:8787/healthz
docker restart eb && docker logs eb | grep "No reseed"
docker exec eb node --disable-warning=ExperimentalWarning --import tsx scripts/backupDb.ts
```

Recorded results are in `docs/V3-CHANGE-REPORT.md` (deployment evidence).

## Live deployment steps (manual, not done)

Do these yourself, in this order. Nothing here runs automatically.

1. **Server.** One small VPS (for example a Hetzner CX-class machine with Ubuntu 24.04 LTS). Check current sizing, price and region when you create it. Coolify's own documented minimum is 2 CPU cores, 2 GB RAM and 10 GB free disk ([Coolify installation](https://coolify.io/docs/get-started/installation)). Check memory before adding swap; swap does not replace enough RAM.
2. **Coolify.** Install with the official command from that page, as root on a fresh server: `curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash`. Open `http://<server-ip>:8000` and create the admin account immediately (the first visitor to that page becomes admin). Back up `/data/coolify/source/.env` somewhere safe; it is separate from the app database backups.
3. **Firewall.** Allow SSH only from your own address where practical, allow 80 and 443 from anywhere, and restrict port 8000 to your address until the panel is behind its own domain. Follow [Coolify's firewall guide](https://coolify.io/docs/core/infrastructure/servers/firewall). Note that ports published by Docker can bypass `ufw` rules; this app needs no published host port because the panel's proxy reaches it on the internal network. Confirm the rules before you enforce them so you do not lock yourself out.
4. **App.** In Coolify, create an application from this Git repository using the Dockerfile build pack. Internal port `8787`. No host port mapping. One instance only.
5. **Volume.** Add a persistent storage mount at `/data` backed by a dedicated host directory owned by uid 1000 (`chown 1000:1000 <dir>`). Never share it with another container.
6. **Variables.** Add `EB_ACCESS_PIN`, `EB_SESSION_SECRET` and `EB_TRUST_PROXY=1` as secrets. Add `EB_CLARITY_PROJECT_ID` only if you want analytics (CH-21); copy it from your existing Clarity project (Settings, Overview). Then check in Clarity that the tracking code the dashboard shows matches `https://www.clarity.ms/tag/<id>`, which is what `src/ui/analytics.ts` loads.
7. **Domain and TLS.** Point a DNS A record at the server. Set the domain in Coolify; its proxy issues the certificate. Turn on the HTTP to HTTPS redirect after DNS resolves.
8. **Health check.** Path `/healthz`, expected 200.
9. **Deploy, then verify** (this is what moves the status to LIVE_VERIFIED, and only after it is actually done):
   - `/healthz` is 200; `/` shows the access gate; `/api/workspace` without a session is 401.
   - Enter the PIN; the app loads; a deep link such as `/anything` loads the app after entry.
   - Run the primary scenario: check, stage, see Task `TASK-EVID-1042` verified.
   - Inspector: Verify audit chain shows OK for both tables.
   - Restart the container. The task is still there, the log says `No reseed on restart`, audit chain still OK.
   - Redeploy the same image with the same mount and check again.
   - If analytics is configured: with the browser's network panel open, the passcode screen makes no request to `clarity.ms`; after entry nothing loads until you choose Allow; after Allow, one `clarity.ms/tag/<id>` request. Sessions then appear in your Clarity dashboard, with the review screen masked.
   - Record the Git SHA and image digest.

## Backups

A persistent volume is not a backup.

- Schedule on the host, for example daily with cron:
  `docker exec <container> node --disable-warning=ExperimentalWarning --import tsx scripts/backupDb.ts`
  This writes `/data/backups/evidencebridge-<UTC time>.sqlite` (mode 600), checks the copy, and exits non-zero if it does not match.
- Copy the newest file **off the server** (object storage or another machine). A copy on the same disk does not survive losing the server.
- Never copy the live `evidencebridge.sqlite` file by hand while the app runs. The `-wal` file holds recent writes.

**Restore test (do it once after setup, then periodically):** copy a backup to a throwaway directory, start a second container on it with a different port and no domain, and check that `/api/audit/verify` is OK and the task list matches. Then remove that container.

**Restore for real:** stop the app, move the current database files aside (do not delete them), copy the chosen backup to `/data/evidencebridge.sqlite`, `chown 1000:1000` it, start the app, verify as above.

## Rollback

Redeploy the previous image with the same `/data` mount. The database is not touched. The V3 schema changes are additive (new nullable columns and new `app_meta` keys), so an older V3 image can read a newer database. Going back to a pre-V3 image is not supported automatically; restore a backup taken before the upgrade instead. There is no automatic reverse migration.

## Cleanup

Use Coolify's own cleanup setting if it has one. Otherwise run `docker image prune --filter "until=168h"` with a dry look first (`docker image ls`). Never prune volumes, and keep the image you would roll back to.

## Reset (throwaway demo instances only)

Never part of normal startup. To start over on a throwaway instance: stop the container, delete `/data/evidencebridge.sqlite*`, start it again (it seeds once because the database is empty). On a database you care about, take a backup first.

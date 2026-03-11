# OpenCode VPS Deployment Notes

This document records the working deployment on the Hetzner VPS as of 2026-03-11.

## Goal

Serve OpenCode from this fork on the VPS so that:

- the iPhone app talks to the VPS backend
- the Mac Web UI also talks to the same VPS backend
- the Web UI is served from this fork's local build, not from `app.opencode.ai`

## Server paths

- Repo: `/home/clawd/clawd/projects/opencode`
- Branch: `dev`
- Service file: `/etc/systemd/system/opencode.service`
- Service env: `/home/clawd/.config/opencode/server.env`

## Current service

The service runs as user `clawd` and does two important things:

1. builds the local web app before start
2. starts the OpenCode server on `127.0.0.1:4096`

Current unit contents:

```ini
[Unit]
Description=OpenCode Server (fork source, run as clawd)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=clawd
Group=clawd
WorkingDirectory=/home/clawd/clawd/projects/opencode
Environment=HOME=/home/clawd
Environment=OPENCODE_DEFAULT_DIRECTORY=/home/clawd/clawd/projects
EnvironmentFile=/home/clawd/.config/opencode/server.env
ExecStartPre=/home/clawd/.bun/bin/bun run --cwd packages/app build
ExecStart=/home/clawd/.bun/bin/bun run --cwd packages/opencode --conditions=browser src/index.ts serve --hostname 127.0.0.1 --port 4096
Restart=always
RestartSec=3
KillSignal=SIGINT
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

## Code changes that must exist

These files are part of the working setup:

- `packages/opencode/src/server/server.ts`
  - prefer serving local `packages/app/dist`
  - only fall back to `https://app.opencode.ai` if the local asset is missing
- `packages/app/src/context/sync.tsx`
  - `sync(..., { refresh: true })` must bypass the hydrated cache and re-fetch messages
- `packages/app/src/pages/session.tsx`
  - the session page periodically re-syncs while visible to recover from missed SSE updates over the SSH tunnel

## Scripts

Scripts checked into the repo:

- `infra/scripts/check-vps-web-build.sh`
  - verifies that `server.ts` still contains local-web logic
  - checks that the HTML asset name returned by `http://127.0.0.1:4096/` exists in local `packages/app/dist/assets`
- `infra/scripts/update-vps-opencode.sh`
  - manual human-oriented update script kept in the repo
- `infra/scripts/opencode-vps-update-wrapper.sh`
  - source-of-truth template for the privileged VPS update wrapper
- `infra/scripts/install-vps-update-wrapper.sh`
  - installs the root-owned wrapper and sudoers rule on a VPS
- `infra/scripts/merge-upstream-dev.sh`
  - fetches `origin/dev` and `upstream/dev`, merges upstream into your local `dev`, pushes to `origin/dev`, then deploys through the fixed wrapper
Recommended human usage on the VPS:

```bash
cd /home/clawd/clawd/projects/opencode
sudo ./infra/scripts/update-vps-opencode.sh
```

Validation only:

```bash
cd /home/clawd/clawd/projects/opencode
./infra/scripts/check-vps-web-build.sh
```

## Autonomous update path for opencode itself

The portable setup is now:

1. repo contains the wrapper template and installer
2. each VPS installs the wrapper once from the repo
3. opencode can then run the repo-local command

One-time install on a new VPS:

```bash
cd /home/clawd/clawd/projects/opencode
sudo ./infra/scripts/install-vps-update-wrapper.sh
```

After that, opencode running as `clawd` can safely execute upstream-merge and deployment flows that end by calling the fixed root wrapper.

Primary repo command for autonomous upstream sync:

```bash
cd /home/clawd/clawd/projects/opencode
./infra/scripts/merge-upstream-dev.sh
```

Why this is safer than sudoing a repo script directly:

- the repo is writable by `clawd`
- the installed `/usr/local/sbin/opencode-vps-update` is root-owned and not writable by `clawd`
- `./infra/scripts/merge-upstream-dev.sh` keeps all Git logic in the repo, but final privileged deployment still goes through the fixed wrapper
- so opencode gets one narrow privileged entrypoint instead of root over a user-writable script

For a no-pull restart-and-check run:

```bash
cd /home/clawd/clawd/projects/opencode
sudo /usr/local/sbin/opencode-vps-update --skip-pull
```

## Upstream merge workflow

To merge the latest official changes into your fork branch and then deploy safely:

```bash
cd /home/clawd/clawd/projects/opencode
./infra/scripts/merge-upstream-dev.sh
```

What it does:

1. refuses to run if the repo is dirty
2. checks out `dev` if needed
3. fetches `origin/dev` and `upstream/dev`
4. fast-forwards local `dev` to `origin/dev`
5. verifies the Mac Web UI source fixes are still present
6. merges `upstream/dev` into local `dev`
7. verifies the critical fixes again after the merge
8. pushes the merged result to `origin/dev`
9. deploys with `/usr/local/sbin/opencode-vps-update --skip-pull`

Useful flags:

- `--dry-run`: fetch and report what would happen, without merging
- `--no-deploy`: merge and push, but do not restart the service
- `--skip-push`: merge locally but do not push to `origin`

If upstream removes one of the known Mac Web UI fixes, the script fails before deployment so the old working server stays in place.

## How to update after pulling new code on the VPS

Run one of these instead:

Autonomous upstream merge path:

```bash
cd /home/clawd/clawd/projects/opencode
./infra/scripts/merge-upstream-dev.sh
```

Direct installed wrapper path:

```bash
sudo /usr/local/sbin/opencode-vps-update
```

If you really need the manual path:

```bash
git pull origin dev
sudo systemctl daemon-reload
sudo systemctl restart opencode.service
```

Because `ExecStartPre` builds the web app, a restart is enough to pick up both backend and frontend code from the VPS repo.

## How to verify the Web UI is using this fork

On the VPS:

```bash
curl -u opencode:$OPENCODE_SERVER_PASSWORD http://127.0.0.1:4096/ | head -20
```

Expected result:

- the HTML references `/assets/index-*.js`
- that asset name must exist inside `packages/app/dist/assets`

Example working asset during this repair:

- HTML: `/assets/index-D2-uoTha.js`
- Local file: `packages/app/dist/assets/index-D2-uoTha.js`

If the HTML points to an asset name that does not exist in local `dist`, then the server is not serving the local build.

## Mac tunnel

Typical local tunnel command from the Mac:

```bash
ssh -N -L 18080:127.0.0.1:4096 -i ~/.ssh/hetzner_ed25519 root@46.224.24.52
```

Open:

- `http://127.0.0.1:18080/`

If the browser is sticky on old JS, force refresh:

- `Cmd+Shift+R`
- or add a cache buster like `?_ts=20260311`

## Why the Web UI broke before

The Mac issue was caused by two regressions after pulling newer upstream code:

1. `packages/opencode/src/server/server.ts` went back to proxying the web frontend to `app.opencode.ai`
2. the Web sync fallback in `packages/app` was no longer present in the local source used on the VPS

The iPhone app kept working because it talks to the backend API directly and does not depend on the same browser frontend path.

## Failure modes to watch for

### 1. Service restart fails in `ExecStartPre`

Symptom:

- `systemctl status opencode.service` shows `EACCES` while deleting files under `packages/app/dist`

Cause:

- the `dist` folder contains files owned by `root`

Fix:

```bash
sudo systemctl stop opencode.service
sudo chown -R clawd:clawd /home/clawd/clawd/projects/opencode/packages/app/dist
sudo systemctl start opencode.service
```

### 2. Mac can send messages but replies do not render

Checks:

```bash
curl -u opencode:$OPENCODE_SERVER_PASSWORD http://127.0.0.1:4096/ | head -20
find /home/clawd/clawd/projects/opencode/packages/app/dist/assets -maxdepth 1 -type f | grep '/index-'
```

If the asset names do not match, restore the local-web changes in `server.ts` and restart the service.

## Safe future workflow

When pulling upstream again:

1. merge upstream into your fork branch first
2. push the result to `origin/dev`
3. on the VPS run `sudo ./infra/scripts/update-vps-opencode.sh`
4. if the script fails, inspect these files first:
   - `packages/opencode/src/server/server.ts`
   - `packages/app/src/context/sync.tsx`
   - `packages/app/src/pages/session.tsx`

If upstream changes those same files, expect conflicts or behavior changes. Treat those three files as the browser-critical surface area for this VPS deployment.

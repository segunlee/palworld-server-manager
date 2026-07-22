# Web deployment (self-hosted, LinuxGSM-integrated)

Upstream ships this project as a desktop app: an Electron window wrapping a Next.js
server that binds to `127.0.0.1` and trusts every caller. This fork keeps that Next.js
server and drops Electron, so it can be hosted as a normal web service.

Three things had to change for that to be safe and useful:

| Problem in the desktop build | What was added |
|---|---|
| No authentication anywhere — every route trusted its caller | `middleware.js` + `lib/webauth.js`: signed session cookie on every page and API route |
| File/folder pickers were Electron IPC calls (`window.desktop.*`) | `components/filepick.jsx` + `/api/fs/upload` and `/api/fs/browse` |
| The supervisor spawned `PalServer.sh` itself, fighting LinuxGSM | `lib/lgsm.js` + delegation in `lib/supervisor.js` |

---

## 1. Runtime

Next 14 and `node:sqlite` need Node ≥ 22.5. This install uses a user-local Node so the
system Node (10.x on Ubuntu 20.04) is untouched:

```
/home/pwserver/.local/opt/node22/bin/node
```

`~/.bashrc` puts it first on `PATH`.

> Do **not** set `PALWORLD_SQLITE_BACKEND=wasm` for a web build. The desktop build pins
> it because Electron's bundled Node may lack `node:sqlite`, but `next build` runs
> prerender workers in parallel and the WASM backend throws
> `Could not reset statement prior to binding new values` when several open the same
> file at once.

## 2. Setup

```bash
cd /home/pwserver/psm
node scripts/psm-setup.js --init            # writes psm.env (signing secret, port, data dir)
printf 'your-password' | node scripts/psm-setup.js --password
node scripts/psm-setup.js --adopt           # register an existing LinuxGSM install
node scripts/psm-setup.js --status          # show what is configured
npm run build:web                           # next build + assemble dist-standalone/
```

`psm.env` (mode 0600) holds:

| Variable | Meaning |
|---|---|
| `PSM_AUTH_SECRET` | HMAC key for session cookies. Rotating it logs everyone out. |
| `HOSTNAME` / `PORT` | Listen address. Defaults to `127.0.0.1:4317` on purpose. |
| `PALWORLD_MANAGER_DATA_DIR` | Registry DB, logs, backups, staging (`~/.psm-data`). |
| `PSM_COOKIE_SECURE` | Set to `1` when HTTPS terminates in front of the app. |

## 3. Service

`~/.config/systemd/user/psm.service` runs `dist-standalone/server.js`.

```bash
systemctl --user restart psm
systemctl --user status psm
journalctl --user -u psm -f
```

`KillMode=process` matters: the game server belongs to LinuxGSM's tmux session, and
must not be torn down when this unit stops.

**To survive a reboot**, user services need lingering enabled — this needs root, once:

```bash
sudo loginctl enable-linger pwserver
```

Without it the service only runs while a login session for `pwserver` exists.

## 4. Authentication

- Every request passes through `middleware.js`. Pages redirect to `/login`; API routes
  answer `401 {"ok":false,"error":"Not authenticated"}` so the UI's `fetch` calls fail
  cleanly instead of parsing a login page as JSON.
- Passwords are scrypt-hashed in the registry DB. Login is rate-limited per IP
  (8 attempts, then a 5-minute lockout).
- Change it from the UI (`POST /api/auth/password`, requires the current password) or
  with `scripts/psm-setup.js --password`.

**Known limitation.** The middleware runs in the Edge runtime and cannot read the
database, so it validates a cookie's signature and expiry but not the session epoch that
a password change bumps. Existing cookies therefore stay valid until they expire (14
days). To cut every session immediately:

```bash
node scripts/psm-setup.js --rotate-secret && systemctl --user restart psm
```

**Exposure.** The default bind is loopback. Anyone who can reach the port and log in can
start processes and read/write server configs as the `pwserver` user — treat a session
as equivalent to shell access. Prefer a reverse proxy with TLS (and set
`PSM_COOKIE_SECURE=1`) over binding `0.0.0.0` directly.

## 5. LinuxGSM integration

A world with a non-empty `lgsm_script` column is **LinuxGSM-managed**. Set it from the
world's Admin tab, or during `--adopt`.

What changes for such a world (`lib/supervisor.js`):

- **Start** runs `<script> start`, then polls `/proc` until the real
  `PalServer-Linux-Shipping` binary under the install dir appears — LinuxGSM returns as
  soon as tmux is up, well before the server has claimed its ports.
- **Stop** asks the game to shut down over REST first (LinuxGSM's stop is a tmux quit
  with no in-game countdown), then runs `<script> stop`. Going through the script is
  what clears `lgsm/lock/<selfname>-started.lock`; killing the PID directly would leave
  that lock in place and LinuxGSM's `monitor` cron would relaunch the server.
- **Liveness** is read from `/proc` rather than from a child handle, so a server started
  by cron, by a shell, or before this app booted is still detected correctly.
- **Logs** come from tailing `log/console/<selfname>-console.log` instead of a stdout
  pipe, and reattach automatically after the web service restarts.
- **The crash guard is disabled.** LinuxGSM's `monitor` already restarts a dead server;
  two guards would race and put two servers on the same ports.

Launch flags stay in LinuxGSM's `startparameters`
(`lgsm/config-lgsm/<selfname>/<selfname>.cfg`) — this app does not pass its own.

- **Updates** run `<script> update` instead of driving SteamCMD directly. LinuxGSM
  records the result in `lgsm/lock/last-updated.lock`, which its `check-update` cron
  reads — update behind its back and that cron still thinks an update is pending, so it
  would run a second one (with its own stop/start, potentially mid-session). The app
  still does the player warning, the safety backup and the restart around it, and it
  verifies the install on disk afterwards rather than trusting LinuxGSM's exit code.

### SteamCMD is shared, not duplicated

`lib/steamcmd.js` resolves a binary instead of assuming its own. Order: the
`PSM_STEAMCMD` env var or the `steamcmdPath` app setting → this app's own copy →
`~/.steam/steamcmd/steamcmd.sh` (where LinuxGSM puts it) → `~/steamcmd/steamcmd.sh` →
a distro package on the PATH. Upstream hardcoded its own data dir, so on a LinuxGSM
host it downloaded a second ~300 MB copy and then ran a *different* SteamCMD than
LinuxGSM against the same server files. Settings → SteamCMD shows the resolved path and
says when it is a reused one.

### Backups are deliberately separate

The two tools back up different things and neither can restore the other's format:

| | LinuxGSM `backup` | This app |
|---|---|---|
| Contents | the whole `serverfiles/` tree | `Pal/Saved/` only (world + player saves) |
| Format | `.tar.gz` | `.zip`, indexed in the registry DB |
| Retention | `maxbackups` / `maxbackupdays` in its config | `backupRetention` app setting |
| Default location | `lgsm/backup/` | `<data dir>/backups/` |

Pointing both at one folder is safe if you prefer it — set it in Settings → Backups.
Neither prunes the other's files: this app only deletes backups it has a DB row for,
and LinuxGSM only matches its own `<selfname>-*.tar.gz` names.

### What still needs LinuxGSM directly

`monitor`, `check-update` and LinuxGSM's own `backup` remain shell/cron commands.
LinuxGSM's cron entries are the source of truth for scheduling.

## 6. Desktop features that do not exist on the web

| Feature | Web behaviour |
|---|---|
| Zip picker (mods, UE4SS, PalSchema, save import) | Browser file chooser → uploaded to `~/.psm-data/staging/uploads` → the existing import APIs get that path. Uploads over 24h old are pruned. |
| Folder picker | A server-side directory browser modal (`/api/fs/browse`). |
| "Open folder" buttons | Not possible from a browser; still shows the desktop-only notice. |
| Tray icon, auto-launch, close-to-tray | Not applicable; use the systemd unit. |

## 7. Files changed from upstream

```
lib/lgsm.js                    new — LinuxGSM delegation
lib/webauth.js                 new — password hashing, session tokens
middleware.js                  new — the auth gate
app/login/page.jsx             new
app/api/auth/{login,logout,state,password}/route.js   new
app/api/fs/{upload,browse}/route.js                   new
components/filepick.jsx        new — web replacements for the Electron dialogs
scripts/psm-setup.js           new — headless setup CLI

lib/supervisor.js              LinuxGSM start/stop/liveness/log-tail branches
lib/db.js                      worlds.lgsm_script column
lib/bootstrap.js               stale-status check asks isRunning() first
app/api/worlds/[id]/route.js   lgsm_script accepted + validated on PATCH
components/Shell.jsx           no nav chrome on /login
components/{Mods,Ue4ss,PalSchema,Backups,Admin}Panel.jsx, CreateWorldModal.jsx
                               use components/filepick instead of window.desktop
public/locales/en.json         admin.lgsm* strings
package.json                   build:web / start:web / setup scripts
```

`electron/` is left untouched, so the desktop build still works.

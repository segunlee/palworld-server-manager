#!/usr/bin/env node
// scripts/psm-setup.js
// Setup CLI for the self-hosted web deployment. The upstream desktop app configures
// itself through Electron dialogs and a first-run wizard; a headless server has
// neither, and some of what it needs (a signing secret, a login password, a filesystem
// path to adopt) must exist BEFORE the web UI is reachable at all. That bootstrap is
// what this script covers.
//
//   node scripts/psm-setup.js --init            create psm.env (signing secret, port, data dir)
//   node scripts/psm-setup.js --password        set or change the web login password
//   node scripts/psm-setup.js --rotate-secret   new signing secret; invalidates all sessions
//   node scripts/psm-setup.js --adopt           register an existing LinuxGSM install
//   node scripts/psm-setup.js --status          show current configuration
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(ROOT, "psm.env");

// --- env file -------------------------------------------------------------------
// A flat KEY=VALUE file, readable both by systemd's EnvironmentFile= and by this
// script. Values are not quoted: systemd would keep the quotes as part of the value.
function readEnvFile() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return out;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function writeEnvFile(vars) {
  const body = [
    "# Palworld Server Manager — web deployment settings.",
    "# Loaded by systemd (EnvironmentFile=) and by scripts/psm-*.sh.",
    "# Contains the session signing secret: keep it readable only by this user.",
    "",
    ...Object.entries(vars).map(([k, v]) => `${k}=${v}`),
    "",
  ].join("\n");
  fs.writeFileSync(ENV_FILE, body, { mode: 0o600 });
  // Re-assert the mode: writeFileSync's mode only applies when creating the file, so
  // rewriting an existing world-readable file would silently keep it world-readable.
  fs.chmodSync(ENV_FILE, 0o600);
}

// Loading the env before requiring lib/* matters: lib/paths.js reads
// PALWORLD_MANAGER_DATA_DIR at require time to decide where the registry lives, so a
// later assignment would open the wrong database.
function loadEnv() {
  const vars = readEnvFile();
  for (const [k, v] of Object.entries(vars)) if (!(k in process.env)) process.env[k] = v;
  return vars;
}

// --- prompts --------------------------------------------------------------------
// Prompting splits by input type, because readline does not survive a pipe across
// several sequential questions: it closes the moment piped input is exhausted, and
// every prompt after that either hangs or throws ERR_USE_AFTER_CLOSE. So piped runs
// read stdin once, up front, and answer each prompt from the queued lines — a missing
// line simply means "accept the default".
let _rl = null;
let _piped = null; // string[] of remaining lines, non-TTY only

function ask(question) {
  if (!process.stdin.isTTY) {
    if (!_piped) {
      const raw = (() => {
        try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
      })();
      _piped = raw.split(/\r?\n/);
    }
    const answer = (_piped.shift() ?? "").trim();
    process.stdout.write(`${question}${answer}\n`);
    return Promise.resolve(answer);
  }
  if (!_rl) _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => _rl.question(question, (a) => res(a.trim())));
}
function closeAsk() { if (_rl) { _rl.close(); _rl = null; } }

// Read the whole of a piped stdin as a single value. Used for the non-interactive
// password path: passing a password as argv would expose it in `ps` output and shell
// history, whereas a pipe (or `< file`) does not.
function readPipedInput() {
  return new Promise((res, rej) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { buf += d; });
    process.stdin.on("end", () => res(buf.replace(/\r?\n$/, "")));
    process.stdin.on("error", rej);
  });
}

// Read without echoing. TTY only — callers handle the piped case via readPipedInput(),
// because opening a second readline interface on a pipe reads EOF: the first one has
// already consumed the whole buffer, so a confirm prompt would always come back empty.
function askSecret(question) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      // Stop masking once the line is submitted, otherwise the newline is swallowed.
      if (["\n", "\r", ""].includes(String(char))) process.stdin.removeListener("data", onData);
      else rl.output.write("\x1b[2K\x1b[200D" + question + "*".repeat(rl.line.length));
    };
    process.stdin.on("data", onData);
    rl.question(question, (a) => { rl.close(); process.stdout.write("\n"); res(a.trim()); });
  });
}

// --- commands -------------------------------------------------------------------
function cmdInit() {
  const cur = readEnvFile();
  const vars = {
    // 32 random bytes, hex-encoded. lib/webauth.js refuses anything under 32 chars.
    PSM_AUTH_SECRET: cur.PSM_AUTH_SECRET || crypto.randomBytes(32).toString("hex"),
    // 0.0.0.0 would expose the app on every interface. Default to loopback and make
    // widening it a deliberate edit, so an install is never accidentally public before
    // a password has even been set.
    HOSTNAME: cur.HOSTNAME || "127.0.0.1",
    PORT: cur.PORT || "4317",
    PALWORLD_MANAGER_DATA_DIR: cur.PALWORLD_MANAGER_DATA_DIR || path.join(os.homedir(), ".psm-data"),
    // Left unset on purpose so lib/sqlite.js picks node:sqlite (built in on Node 22.5+)
    // and only falls back to the WASM backend if that is unavailable. The desktop build
    // pins "wasm" because Electron's bundled Node may lack node:sqlite — but here that
    // pin actively breaks `next build`, whose parallel prerender workers open the same
    // file at once and make the WASM backend throw "Could not reset statement".
    ...(cur.PALWORLD_SQLITE_BACKEND ? { PALWORLD_SQLITE_BACKEND: cur.PALWORLD_SQLITE_BACKEND } : {}),
    // Set to 1 when a reverse proxy terminates HTTPS, so session cookies get Secure.
    PSM_COOKIE_SECURE: cur.PSM_COOKIE_SECURE || "0",
    NODE_ENV: "production",
  };
  writeEnvFile(vars);
  console.log(`Wrote ${ENV_FILE}`);
  console.log(`  data dir : ${vars.PALWORLD_MANAGER_DATA_DIR}`);
  console.log(`  listen   : ${vars.HOSTNAME}:${vars.PORT}`);
  if (cur.PSM_AUTH_SECRET) console.log("  secret   : kept existing (use --rotate-secret to replace)");
  else console.log("  secret   : generated");
}

function cmdRotateSecret() {
  const vars = readEnvFile();
  if (!vars.PSM_AUTH_SECRET) return console.error("No psm.env yet — run --init first.");
  vars.PSM_AUTH_SECRET = crypto.randomBytes(32).toString("hex");
  writeEnvFile(vars);
  console.log("Signing secret rotated. Restart the service; everyone must log in again.");
}

async function cmdPassword() {
  loadEnv();
  const auth = require("../lib/webauth");
  let pw;
  if (process.stdin.isTTY) {
    pw = await askSecret("New web login password: ");
    const again = await askSecret("Repeat password: ");
    if (pw !== again) return console.error("Passwords do not match. Nothing changed.");
  } else {
    // Non-interactive: `echo -n 'secret' | node scripts/psm-setup.js --password`.
    // No confirmation prompt — there is nothing to mistype in a pipe.
    pw = await readPipedInput();
    if (!pw) return console.error("No password on stdin. Nothing changed.");
  }
  try {
    auth.setPassword(pw);
  } catch (e) {
    return console.error(e.message);
  }
  console.log("Password set. Existing sessions were invalidated.");
}

async function cmdAdopt() {
  loadEnv();
  const dbm = require("../lib/db");
  const detect = require("../lib/detect");
  const prov = require("../lib/provision");
  const lgsm = require("../lib/lgsm");
  const ini = require("../lib/ini");

  const installDir = await ask("Palworld install dir (contains PalServer.sh): ");
  const info = detect.inspect(installDir);
  if (!info.valid) return console.error(`Not a valid Palworld install: ${info.reason}`);
  console.log(`  detected: ${info.installDir} (${info.platform}, build ${info.buildId || "unknown"})`);

  if (dbm.listWorlds().some((w) => path.resolve(w.install_dir) === path.resolve(info.installDir))) {
    return console.error("That install is already registered as a world.");
  }

  const guess = lgsm.detectScript(info.installDir);
  const script = (await ask(`LinuxGSM script${guess ? ` [${guess}]` : " (blank = manage directly)"}: `)) || guess || "";
  if (script && !lgsm.enabled({ lgsm_script: script })) {
    return console.error(`Not an executable file: ${script}`);
  }

  // Read the ports the server is ALREADY using out of its ini. Letting the app pick
  // defaults instead would rewrite that ini and silently move a live server's ports.
  let ports = null;
  try {
    const s = ini.readSettings(info.installDir, info.platform);
    const num = (v, d) => { const n = parseInt(String(v ?? "").replace(/"/g, ""), 10); return Number.isInteger(n) ? n : d; };
    ports = {
      game_port: num(s.options.PublicPort, 8211),
      query_port: num(s.options.PublicPort, 8211) === 8211 ? 27015 : 27015,
      rest_api_port: num(s.options.RESTAPIPort, 8212),
      rcon_port: num(s.options.RCONPort, 25575),
    };
  } catch {}
  const name = (await ask(`Display name [${info.serverName || "Palworld"}]: `)) || info.serverName || "Palworld";

  const { world } = prov.adoptExistingInstall({
    display_name: name,
    install_dir: info.installDir,
    ports,
    keepExistingPassword: true,
  });
  if (script) {
    dbm.updateWorld(world.world_id, { lgsm_script: script });
    dbm.logEvent(world.world_id, "settings", `Process management delegated to LinuxGSM (${script})`);
  }
  // PSM's crash guard must stay off for a LinuxGSM world: LinuxGSM's own `monitor`
  // cron already restarts a dead server, and two guards would fight over the ports.
  dbm.updateWorld(world.world_id, { crash_guard: 0, autostart: 0 });

  const w = dbm.getWorld(world.world_id);
  console.log(`\nAdopted "${w.display_name}" (${w.world_id})`);
  console.log(`  ports    : game ${w.game_port}, query ${w.query_port}, REST ${w.rest_api_port}`);
  console.log(`  managed  : ${script ? `LinuxGSM (${script})` : "directly by this app"}`);
  console.log(`  running  : ${lgsm.findServerPid(w.install_dir) ? "yes" : "no"}`);
  console.log("\nNOTE: PalWorldSettings.ini was updated (REST API + admin password).");
  console.log("      Restart the server for those to take effect.");
}

function cmdStatus() {
  const vars = loadEnv();
  const auth = require("../lib/webauth");
  const dbm = require("../lib/db");
  const lgsm = require("../lib/lgsm");
  console.log(`env file : ${fs.existsSync(ENV_FILE) ? ENV_FILE : "(missing — run --init)"}`);
  console.log(`listen   : ${vars.HOSTNAME || "127.0.0.1"}:${vars.PORT || "4317"}`);
  console.log(`data dir : ${process.env.PALWORLD_MANAGER_DATA_DIR || "(default ./.data)"}`);
  console.log(`secret   : ${(vars.PSM_AUTH_SECRET || "").length >= 32 ? "ok" : "MISSING/too short"}`);
  console.log(`password : ${auth.isConfigured() ? "set" : "NOT SET — run --password"}`);
  console.log("worlds   :");
  const worlds = dbm.listWorlds();
  if (!worlds.length) console.log("  (none — run --adopt)");
  for (const w of worlds) {
    const via = lgsm.enabled(w) ? `LinuxGSM ${w.lgsm_script}` : "direct";
    const pid = lgsm.findServerPid(w.install_dir);
    console.log(`  ${w.display_name} [${w.world_id}] ${via} — ${pid ? `running (pid ${pid})` : "stopped"}`);
  }
}

async function main() {
  const arg = process.argv[2];
  switch (arg) {
    case "--init": return cmdInit();
    case "--password": return cmdPassword();
    case "--rotate-secret": return cmdRotateSecret();
    case "--adopt": return cmdAdopt();
    case "--status": return cmdStatus();
    default:
      console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 14).join("\n").replace(/^\/\/ ?/gm, ""));
      process.exit(arg ? 1 : 0);
  }
}

main()
  .then(() => { closeAsk(); process.exit(0); })
  .catch((e) => { closeAsk(); console.error(e); process.exit(1); });

// lib/lgsm.js
// LinuxGSM delegation. When a world records an `lgsm_script` path, this app stops
// being the process owner: start/stop/restart shell out to that script instead of
// spawning PalServer.sh directly, and liveness is read off the OS rather than off a
// child handle we hold.
//
// Why: LinuxGSM keeps its own state (lgsm/lock/<selfname>-started.lock) and runs a
// `monitor` cron that relaunches the server whenever that lock says it should be up.
// If we spawned the binary ourselves, LinuxGSM would see no tmux session, declare the
// server dead and start a *second* one; and anything we killed directly would be
// resurrected within a minute. Routing every lifecycle action through the script keeps
// exactly one owner and leaves LinuxGSM's update/monitor/backup workflow intact.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function scriptPath(world) {
  return String((world && world.lgsm_script) || "").trim();
}

// A world is LinuxGSM-managed only when the recorded script actually exists — a stale
// path must degrade to normal direct-spawn behaviour rather than break every action.
function enabled(world) {
  const s = scriptPath(world);
  if (!s) return false;
  try { return fs.statSync(s).isFile(); } catch { return false; }
}

// LinuxGSM derives every path from the script's own name and location:
//   <root>/pwserver            -> selfname "pwserver", root is the script's dir
//   <root>/log/console/pwserver-console.log
//   <root>/lgsm/lock/pwserver-started.lock
function layout(world) {
  const script = scriptPath(world);
  const root = path.dirname(script);
  const selfname = path.basename(script);
  return {
    script,
    root,
    selfname,
    consoleLog: path.join(root, "log", "console", `${selfname}-console.log`),
    startedLock: path.join(root, "lgsm", "lock", `${selfname}-started.lock`),
  };
}

// Find the running Palworld binary belonging to this install, by walking /proc and
// resolving each process's exe symlink. This is deliberately independent of who
// started the server: it sees a server LinuxGSM launched from cron, one launched from
// a user's shell, and one launched by this app, which a PID we recorded would not.
// Returns the pid, or null when nothing under installDir is running.
function findServerPid(installDir) {
  if (!installDir) return null;
  let root;
  try { root = fs.realpathSync(path.resolve(installDir)); } catch { root = path.resolve(installDir); }
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  let entries = [];
  try { entries = fs.readdirSync("/proc"); } catch { return null; }
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) continue;
    let exe;
    // A process we don't own, or one that exits mid-scan, throws here. Skip it.
    try { exe = fs.readlinkSync(`/proc/${ent}/exe`); } catch { continue; }
    if (!exe || !exe.startsWith(prefix)) continue;
    if (!/PalServer.*Shipping/i.test(path.basename(exe))) continue;
    return Number(ent);
  }
  return null;
}

function isRunning(world) {
  return findServerPid(world && world.install_dir) != null;
}

// Run a LinuxGSM command (start/stop/restart/update/...) and resolve with its output.
// Never rejects on a non-zero exit: LinuxGSM uses exit codes loosely, so the caller
// decides success by re-checking liveness instead.
function run(world, command, { timeout = 300000, onLine = null } = {}) {
  const { script, root } = layout(world);
  return new Promise((resolve) => {
    const child = spawn(script, [command], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // LinuxGSM colourizes and redraws when it thinks it has a terminal; the escape
        // codes would end up verbatim in our log ring buffer.
        TERM: "dumb",
      },
    });
    const out = [];
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, output: out.join("\n") });
    };
    const feed = (buf) => {
      for (const raw of String(buf).split(/\r?\n/)) {
        const line = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trimEnd();
        if (!line.trim()) continue;
        out.push(line);
        if (onLine) { try { onLine(line); } catch {} }
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (e) => { feed(`lgsm: ${e.message}`); finish(-1); });
    child.on("close", finish);
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      feed(`lgsm: "${command}" timed out after ${Math.round(timeout / 1000)}s`);
      finish(-1);
    }, timeout);
  });
}

// Poll until the server is up (or gone), so callers can report a real outcome instead
// of whatever LinuxGSM printed. LinuxGSM returns as soon as it has spawned tmux, well
// before the binary has actually claimed its ports.
async function waitFor(world, wantRunning, { timeout = 90000, interval = 1000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const pid = findServerPid(world.install_dir);
    if (wantRunning && pid) return pid;
    if (!wantRunning && !pid) return null;
    if (Date.now() >= deadline) return wantRunning ? null : findServerPid(world.install_dir);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Best-effort autodetect: a LinuxGSM install is a game script sitting next to the
// lgsm/ directory it created. Used to pre-fill the field when adopting an install.
function detectScript(installDir) {
  if (!installDir) return null;
  // serverfiles/ lives one level below the LinuxGSM root in a default install.
  const candidates = [path.dirname(path.resolve(installDir)), path.resolve(installDir)];
  for (const root of candidates) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    if (!names.includes("lgsm")) continue;
    for (const name of names) {
      const p = path.join(root, name);
      if (name === "linuxgsm.sh" || name.startsWith(".")) continue;
      try {
        const st = fs.statSync(p);
        if (!st.isFile() || !(st.mode & 0o111)) continue;
      } catch { continue; }
      // The game script and the installer share a body; only the game script has a
      // matching config dir under lgsm/config-lgsm/<selfname>/.
      if (fs.existsSync(path.join(root, "lgsm", "config-lgsm", name))) return p;
    }
  }
  return null;
}

module.exports = { enabled, scriptPath, layout, findServerPid, isRunning, run, waitFor, detectScript };

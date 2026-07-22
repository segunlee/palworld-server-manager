import { NextResponse } from "next/server";
const fs = require("fs");
const os = require("os");
const path = require("path");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Server-side directory listing, standing in for Electron's native folder dialog.
// The desktop build asks the OS to pick a folder on the same machine the server runs
// on; in a web deployment the browser is on a different machine entirely, so the only
// way to choose a server path is to browse the server's filesystem here.
//
// Access is already gated by middleware.js — reaching this route means holding a valid
// session, which in this app is equivalent to full control of the host anyway (it can
// start processes and edit configs). So this deliberately does not sandbox to a subtree:
// a Palworld install can legitimately live anywhere.
export async function GET(req) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("path");
  const target = raw && raw.trim() ? path.resolve(raw.trim()) : os.homedir();

  let stat;
  try { stat = fs.statSync(target); }
  catch (e) { return NextResponse.json({ ok: false, error: `Cannot open ${target}: ${e.code || e.message}` }, { status: 400 }); }

  const dir = stat.isDirectory() ? target : path.dirname(target);

  let names;
  try { names = fs.readdirSync(dir); }
  catch (e) { return NextResponse.json({ ok: false, error: `Cannot read ${dir}: ${e.code || e.message}` }, { status: 400 }); }

  const entries = [];
  for (const name of names) {
    if (name.startsWith(".")) continue; // dotfiles are noise when picking an install dir
    let st;
    // A broken symlink or a permission-denied entry must not abort the whole listing.
    try { st = fs.statSync(path.join(dir, name)); } catch { continue; }
    if (!st.isDirectory()) continue;
    entries.push({ name, path: path.join(dir, name) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(dir);
  return NextResponse.json({
    ok: true,
    path: dir,
    parent: parent === dir ? null : parent, // null at the filesystem root
    home: os.homedir(),
    // Flags the UI uses to show "this is a Palworld install" next to the current folder.
    isPalworldInstall: fs.existsSync(path.join(dir, "PalServer.sh")) || fs.existsSync(path.join(dir, "PalServer.exe")),
    entries,
  });
}

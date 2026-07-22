import { NextResponse } from "next/server";
const dbm = require("@/lib/db");
const ini = require("@/lib/ini");
const sup = require("@/lib/supervisor");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET: the raw PalWorldSettings.ini text for the in-app editor.
export async function GET(_req, { params }) {
  const w = dbm.getWorld(params.id);
  if (!w) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  const r = ini.readRawSettings(w.install_dir, w.platform);
  return NextResponse.json({
    ok: true, path: r.path, exists: r.exists, content: r.content,
    running: sup.isRunning(w.world_id),
  });
}

// POST { content }: snapshot the current file into history, then overwrite it.
export async function POST(req, { params }) {
  const w = dbm.getWorld(params.id);
  if (!w) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  const { content } = await req.json();
  if (typeof content !== "string") {
    return NextResponse.json({ ok: false, error: "content required" }, { status: 400 });
  }
  // Snapshot what's currently on disk so this save can always be undone.
  const cur = ini.readRawSettings(w.install_dir, w.platform);
  if (cur.exists && cur.content) dbm.insertIniVersion(w.world_id, cur.content, "before edit");
  const path = ini.writeRawSettings(w.install_dir, content, w.platform);
  // Also snapshot the newly-saved content so it appears in history as a restorable point.
  dbm.insertIniVersion(w.world_id, content, "saved");
  dbm.logEvent(w.world_id, "settings", "Edited PalWorldSettings.ini in the in-app editor (restart to apply)");
  // This editor writes the raw file, but a few of its keys (the passwords, the REST /
  // RCON settings) are also owned by the registry and rewritten from it on every
  // start. Without this, editing ServerPassword here would be undone by the next
  // start — silently reopening a password-protected server. Adopt the edit instead.
  let synced = null;
  try { synced = ini.syncManagedFromIni(w.world_id, w.install_dir, w.platform); } catch {}
  return NextResponse.json({ ok: true, path, running: sup.isRunning(w.world_id), synced: !!synced });
}

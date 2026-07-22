import { NextResponse } from "next/server";
const fs = require("fs");
const path = require("path");
const { P } = require("@/lib/paths");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Upload a .zip and return the path it was written to on the server.
//
// Why this exists: every import endpoint in this app (mods, UE4SS, PalSchema, save
// import) takes a server-side filesystem path, because in the desktop build the
// Electron file dialog hands back a real path on the same machine. A browser has no
// such path — it has a File object — so the web UI uploads first and then passes the
// returned staging path to the unchanged import API.
//
// Files land in the staging dir, which is already the app's scratch area for
// half-processed archives, and are named unpredictably so two concurrent uploads of
// "mod.zip" can't clobber each other.
const MAX_BYTES = 512 * 1024 * 1024;

export async function POST(req) {
  let form;
  try { form = await req.formData(); }
  catch (e) { return NextResponse.json({ ok: false, error: `Malformed upload: ${e.message}` }, { status: 400 }); }

  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    return NextResponse.json({ ok: false, error: "No file in request." }, { status: 400 });
  }
  if (typeof file.size === "number" && file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: `File is larger than ${MAX_BYTES / 1024 / 1024} MB.` }, { status: 413 });
  }

  // Keep only the basename's safe characters. The client-supplied name is otherwise
  // untrusted input being turned into a path — "../../PalServer.sh" must not escape
  // the staging dir, and it can't once every separator is stripped.
  const raw = String(file.name || "upload.zip");
  const safe = path.basename(raw).replace(/[^A-Za-z0-9._-]/g, "_").slice(-120) || "upload.zip";
  if (!/\.zip$/i.test(safe)) {
    return NextResponse.json({ ok: false, error: "Only .zip files can be uploaded." }, { status: 400 });
  }

  const dir = path.join(P.staging(), "uploads");
  fs.mkdirSync(dir, { recursive: true });
  pruneOldUploads(dir);

  const dest = path.join(dir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: "File too large." }, { status: 413 });
  }
  fs.writeFileSync(dest, buf);

  return NextResponse.json({ ok: true, path: dest, name: safe, size: buf.length });
}

// Uploads are consumed immediately by the import that follows, so anything still here
// after a day is the residue of a failed or abandoned one. Without this the staging
// dir would grow by the size of every mod ever installed and never shrink.
function pruneOldUploads(dir) {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch {}
  }
}

import { NextResponse } from "next/server";
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const dbm = require("@/lib/db");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET — send a backup zip to the browser. The path is never taken from the URL:
// the backup id is looked up in this world's own rows and the stored file_path is
// used, so there is nothing here to traverse out of the backup folder with.
// Backups run to hundreds of MB, so the file is streamed rather than buffered.
export async function GET(_req, { params }) {
  const world = dbm.getWorld(params.id);
  if (!world) return NextResponse.json({ ok: false, error: "World not found" }, { status: 404 });

  const row = dbm.listBackups(params.id).find((b) => b.id === params.bid);
  if (!row) return NextResponse.json({ ok: false, error: "Backup not found" }, { status: 404 });

  let size;
  try { size = fs.statSync(row.file_path).size; }
  catch { return NextResponse.json({ ok: false, error: "Backup file is missing on disk" }, { status: 404 }); }

  // The world name can be anything the user typed, including non-ASCII, which a bare
  // filename= would mangle. Send an ASCII-safe fallback plus RFC 5987 filename* so
  // browsers that understand it get the real name.
  const stamp = path.basename(row.file_path, ".zip");
  const name = `${world.display_name || "world"}_${stamp}.zip`;
  const ascii = name.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");

  const stream = Readable.toWeb(fs.createReadStream(row.file_path));
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
    },
  });
}

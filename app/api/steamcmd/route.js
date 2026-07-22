import { NextResponse } from "next/server";
const steam = require("@/lib/steamcmd");
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  const resolved = steam.resolveSteamCmd();
  return NextResponse.json({
    ok: true,
    installed: !!resolved,
    path: resolved || steam.steamcmdBinary(),
    // True when we reuse a SteamCMD something else installed (LinuxGSM, a distro
    // package). Worth surfacing: it means no second copy was downloaded, and it
    // explains a path that sits outside this app's data dir.
    shared: !!resolved && resolved !== steam.ownSteamcmdBinary(),
  });
}

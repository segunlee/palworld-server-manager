import { NextResponse } from "next/server";
const auth = require("@/lib/webauth");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Change the web login password. Reaching this route already required a valid session
// (middleware), but the current password is still required: a session cookie left open
// on an unattended browser must not be enough to lock the real owner out.
export async function POST(req) {
  let current = "", next = "";
  try { ({ current, next } = await req.json()); } catch {}

  if (auth.isConfigured() && !auth.checkPassword(current)) {
    return NextResponse.json({ ok: false, error: "Current password is incorrect." }, { status: 401 });
  }
  try {
    auth.setPassword(next);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
  }

  // setPassword() bumped the session epoch, invalidating every previously issued
  // token — including this caller's. Hand back a fresh one so changing the password
  // doesn't log you out of the tab you changed it in.
  const res = NextResponse.json({ ok: true });
  res.cookies.set(auth.COOKIE, auth.issueToken(), auth.cookieOptions());
  return res;
}

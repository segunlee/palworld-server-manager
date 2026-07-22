import { NextResponse } from "next/server";
const auth = require("@/lib/webauth");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Public (see middleware's PUBLIC list) and deliberately says nothing sensitive: just
// whether a password has been set, so the login page can tell a fresh install ("run
// the setup script") apart from a wrong password.
export async function GET() {
  let configured = false, secretOk = true;
  try { configured = auth.isConfigured(); } catch {}
  try { auth.issueToken(); } catch { secretOk = false; }
  return NextResponse.json({ ok: true, configured, secretOk });
}

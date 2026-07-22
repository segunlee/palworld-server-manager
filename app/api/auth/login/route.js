import { NextResponse } from "next/server";
const auth = require("@/lib/webauth");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Rate limiting is in-process and per-IP. It exists to make an online guessing attack
// against a single password impractical, not to survive a restart — the scrypt hash is
// what actually protects the credential.
const g = globalThis;
if (!g.__PSM_LOGIN_TRIES) g.__PSM_LOGIN_TRIES = new Map(); // ip -> { n, until }
const TRIES = g.__PSM_LOGIN_TRIES;
const MAX_TRIES = 8;
const LOCKOUT_MS = 5 * 60 * 1000;

function clientIp(req) {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

export async function POST(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = TRIES.get(ip);
  if (rec && rec.until > now) {
    const secs = Math.ceil((rec.until - now) / 1000);
    return NextResponse.json({ ok: false, error: `Too many attempts. Try again in ${secs}s.` }, { status: 429 });
  }

  let password = "";
  try { ({ password } = await req.json()); } catch {}

  if (!auth.isConfigured()) {
    return NextResponse.json(
      { ok: false, error: "No password is set yet. Run: node scripts/psm-setup.js --password" },
      { status: 503 }
    );
  }

  if (!auth.checkPassword(password)) {
    const n = (rec && rec.until <= now ? 0 : rec?.n || 0) + 1;
    TRIES.set(ip, { n, until: n >= MAX_TRIES ? now + LOCKOUT_MS : 0 });
    // Deliberately vague: distinguishing "wrong password" from anything else would
    // confirm guesses about how the instance is configured.
    return NextResponse.json({ ok: false, error: "Incorrect password." }, { status: 401 });
  }

  TRIES.delete(ip);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(auth.COOKIE, auth.issueToken(), auth.cookieOptions());
  return res;
}

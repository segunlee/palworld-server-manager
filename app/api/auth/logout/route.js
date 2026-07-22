import { NextResponse } from "next/server";
const auth = require("@/lib/webauth");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(auth.COOKIE, "", { ...auth.cookieOptions(), maxAge: 0 });
  return res;
}

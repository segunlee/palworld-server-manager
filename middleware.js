// middleware.js
// The single choke point that makes this app safe to expose on a network. Every
// request — pages, all 62 API routes, and the SSE log/chat streams — passes through
// here before reaching a handler, so there is no route that can be forgotten.
//
// This runs in the Edge runtime, which has no `require`, no filesystem and no SQLite.
// So it does the one check it can do statelessly: verify the session cookie's HMAC
// signature and expiry with Web Crypto. Password checking and token minting live in
// lib/webauth.js on the Node side.
//
// Known limitation of that split: changing the password bumps an epoch stored in the
// DB, which only the Node-side verifyToken() can read. Already-issued cookies therefore
// keep working here until they expire. To cut every session off immediately, rotate the
// signing secret (`node scripts/psm-setup.js --rotate-secret`) and restart.
import { NextResponse } from "next/server";

const COOKIE = "psm_session";

// Paths that must stay reachable without a session, or login itself is impossible.
const PUBLIC = ["/login", "/api/auth/login", "/api/auth/state"];

function isPublic(pathname) {
  if (PUBLIC.includes(pathname)) return true;
  // Next's own build output and the app icon are served before any UI can be shown.
  if (pathname.startsWith("/_next/")) return true;
  if (pathname === "/favicon.ico" || pathname === "/icon.png" || pathname === "/icon.ico") return true;
  return false;
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function validSession(token, secret) {
  if (!token || !secret || secret.length < 32) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(sig), new TextEncoder().encode(body));
  } catch { return false; }
  if (!ok) return false;

  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    return typeof payload.exp === "number" && payload.exp > Date.now();
  } catch { return false; }
}

export async function middleware(req) {
  const { pathname, search } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const token = req.cookies.get(COOKIE)?.value;
  if (await validSession(token, process.env.PSM_AUTH_SECRET || "")) return NextResponse.next();

  // An unauthenticated API call gets JSON, not a redirect: the UI's fetch() calls would
  // otherwise silently receive the login page's HTML and fail to parse it, showing a
  // confusing error instead of sending the user to log in.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  // Preserve where they were headed so login can return them there.
  if (pathname !== "/") url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next's static output. Note this deliberately still covers
  // /api/** — those routes are the sensitive ones.
  matcher: ["/((?!_next/static|_next/image).*)"],
};

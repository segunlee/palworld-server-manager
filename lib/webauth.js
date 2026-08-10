// lib/webauth.js
// Authentication for the self-hosted web deployment. The upstream project is a desktop
// app whose server binds to 127.0.0.1 and trusts every caller — there is no login
// anywhere in it. Hosting the same server on a network makes every route (start/stop a
// server, read the admin password, browse the filesystem) reachable by anyone who can
// open the port, so this module adds the missing gate.
//
// Split of responsibility, forced by where the checks run:
//   - This module (Node runtime) hashes/verifies the password and MINTS session tokens.
//     It touches the SQLite registry, so it can only be imported by route handlers.
//   - middleware.js (Edge runtime) only VERIFIES a token's signature and expiry using
//     Web Crypto. It cannot open the DB, which is why tokens are self-contained and
//     signed with a secret read from the environment rather than looked up per request.
const crypto = require("crypto");
const dbm = require("./db");

const COOKIE = "psm_session";
const SESSION_DAYS = 14;

// The signing secret must be identical in both runtimes, so it comes from the
// environment (set by scripts/psm-env.sh) rather than the DB. Without it every session
// would be invalidated on restart — and worse, an empty secret would let anyone forge
// a token, so refuse to mint anything instead of falling back to a default.
function secret() {
  const s = process.env.PSM_AUTH_SECRET || "";
  if (s.length < 32) {
    throw new Error("PSM_AUTH_SECRET is missing or too short (need >= 32 chars). Run scripts/psm-setup.js.");
  }
  return s;
}

// scrypt with a per-password salt. Chosen over a bare SHA because this hash sits in a
// file on disk next to the world data; a fast hash would make it trivially brute-forced
// if the registry ever leaks.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString("base64")}$${dk.toString("base64")}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const [scheme, saltB64, dkB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !dkB64) return false;
  const expected = Buffer.from(dkB64, "base64");
  let actual;
  try { actual = crypto.scryptSync(String(password), Buffer.from(saltB64, "base64"), expected.length); }
  catch { return false; }
  // Constant-time: a length-varying or early-exit compare leaks the hash a byte at a
  // time to anyone who can measure response latency.
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function isConfigured() {
  return !!dbm.getSetting("webAuthHash", "");
}

// The floor is 4 rather than 8 so short passphrases are allowed. Length alone is not
// what holds the door here — the login route rate-limits to 8 tries before a 5-minute
// lockout — but a short password only makes sense on a trusted LAN, so keep HOSTNAME
// off any wider network unless the password is a long one.
function setPassword(password) {
  const pw = String(password || "");
  if (pw.length < 4) throw new Error("Password must be at least 4 characters.");
  dbm.setSetting("webAuthHash", hashPassword(pw));
  // Existing sessions were issued to whoever knew the old password. Bumping the epoch
  // invalidates all of them, which is the whole point of changing a password.
  dbm.setSetting("webAuthEpoch", Date.now());
}

function checkPassword(password) {
  const stored = dbm.getSetting("webAuthHash", "");
  return verifyPassword(password, stored);
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Token layout: <base64url(payload JSON)>.<base64url(HMAC-SHA256)>. Self-contained so
// the Edge middleware can validate it without a database round-trip.
function issueToken(user = "admin") {
  const payload = {
    u: user,
    // Issued-at epoch marker; a password change moves the epoch forward and every
    // token minted before it stops validating.
    e: dbm.getSetting("webAuthEpoch", 0),
    exp: Date.now() + SESSION_DAYS * 86400000,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", secret()).update(body).digest());
  return `${body}.${sig}`;
}

// Node-side verification, used by route handlers that need the session identity.
// The middleware has its own Web Crypto implementation of the same check.
function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expect = b64url(crypto.createHmac("sha256", secret()).update(body).digest());
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); }
  catch { return null; }
  if (!payload || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  if ((payload.e || 0) !== (dbm.getSetting("webAuthEpoch", 0) || 0)) return null;
  return payload;
}

// secure:true would make the cookie undeliverable over plain HTTP, locking out a LAN
// deployment that has no TLS. It is opt-in via PSM_COOKIE_SECURE=1, which anyone
// terminating HTTPS in front of this app should set.
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.PSM_COOKIE_SECURE === "1",
    maxAge: SESSION_DAYS * 86400,
  };
}

module.exports = {
  COOKIE, SESSION_DAYS,
  hashPassword, verifyPassword, isConfigured, setPassword, checkPassword,
  issueToken, verifyToken, cookieOptions,
};

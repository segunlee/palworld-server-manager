"use client";
import { useEffect, useRef, useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [state, setState] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    fetch("/api/auth/state").then((r) => r.json()).then(setState).catch(() => {});
    inputRef.current?.focus();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setError(j.error || "Login failed.");
        setPassword("");
        inputRef.current?.focus();
        return;
      }
      // A full navigation rather than a router push: the session cookie was just set,
      // and every page below needs a fresh server render that can see it.
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.href = next && next.startsWith("/") ? next : "/";
    } catch (err) {
      setError(err.message || "Network error.");
    } finally {
      setBusy(false);
    }
  };

  const blocked = state && (!state.configured || !state.secretOk);

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      padding: 24, background: "var(--bg)",
    }}>
      <form onSubmit={submit} style={{
        width: "100%", maxWidth: 380, background: "var(--card)",
        border: "1px solid var(--line-strong)", borderRadius: 14, padding: 28,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.png" alt="" width={36} height={36} style={{ borderRadius: 8 }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 17, color: "var(--ink)" }}>Palworld Server Manager</div>
            <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>Sign in to continue</div>
          </div>
        </div>

        {blocked ? (
          <div style={{
            marginTop: 18, fontSize: 13, lineHeight: 1.6, color: "var(--ink-soft)",
            background: "var(--card-2)", border: "1px solid var(--line)", borderRadius: 10, padding: 14,
          }}>
            {!state.secretOk
              ? <>The signing secret <code>PSM_AUTH_SECRET</code> is missing or too short. Set it, then restart the service.</>
              : <>No password has been set yet. On the server, run:<br /><code>node scripts/psm-setup.js --password</code></>}
          </div>
        ) : (
          <>
            <label htmlFor="psm-password" style={{
              display: "block", marginTop: 20, marginBottom: 6, fontSize: 12,
              fontWeight: 600, color: "var(--ink-soft)",
            }}>
              Password
            </label>
            <input
              id="psm-password"
              ref={inputRef}
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ width: "100%" }}
            />
            {error && (
              <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--red)" }} role="alert">{error}</div>
            )}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !password}
              style={{ width: "100%", marginTop: 16, justifyContent: "center" }}
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}

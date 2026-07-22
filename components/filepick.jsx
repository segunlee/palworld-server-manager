"use client";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";

// Web replacements for the two Electron dialogs this app was built around
// (window.desktop.pickZip / pickDirectory). Both keep the original promise-returning
// shape — `const p = await pickZip()` — so call sites read the same in either build,
// and both still hand back a path on the SERVER, which is what every import API wants.
//
// When running inside Electron these delegate to the native dialogs unchanged; the web
// implementations only take over when window.desktop is absent.

export function isDesktop() {
  return typeof window !== "undefined" && !!window.desktop?.isElectron;
}

// Pick a .zip and get back the path it now occupies on the server.
// In the browser that means two steps — choose a local file, upload it to staging —
// because the browser's File object has no server-side path of its own.
// Resolves null when the user cancels, matching the Electron dialog's contract.
export function pickZip({ onProgress } = {}) {
  if (isDesktop()) return window.desktop.pickZip();

  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.style.display = "none";
    document.body.appendChild(input);

    // There is no cancel event for a file input. Cleanup is therefore driven by the
    // change handler alone; the element is display:none and removed as soon as one
    // fires, and a cancelled dialog just leaves an inert hidden input to be GC'd with
    // the page. (Tracking window focus to detect cancel is unreliable across browsers.)
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return resolve(null);
      try {
        onProgress?.({ phase: "uploading", name: file.name, size: file.size });
        const body = new FormData();
        body.append("file", file);
        const r = await fetch("/api/fs/upload", { method: "POST", body });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || `Upload failed (${r.status})`);
        onProgress?.({ phase: "done", name: file.name });
        resolve(j.path);
      } catch (e) {
        onProgress?.({ phase: "error", error: e.message });
        reject(e);
      }
    });
    input.click();
  });
}

// Pick a directory on the server. Resolves the chosen absolute path, or null on cancel.
export function pickDirectory(startPath) {
  if (isDesktop()) return window.desktop.pickDirectory();
  return openBrowserModal(startPath);
}

// Imperative mount so the promise-based API above works from any call site without
// each panel having to own modal state.
function openBrowserModal(startPath) {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const close = (value) => {
      root.unmount();
      host.remove();
      resolve(value ?? null);
    };
    root.render(<DirectoryBrowser startPath={startPath} onClose={close} />);
  });
}

function DirectoryBrowser({ startPath, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [manual, setManual] = useState("");
  const [loading, setLoading] = useState(true);

  const load = async (p) => {
    setLoading(true);
    setError("");
    try {
      const r = await fetch(`/api/fs/browse?path=${encodeURIComponent(p || "")}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Cannot read that folder.");
      setData(j);
      setManual(j.path);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(startPath); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape closes, like the native dialog it replaces.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(null); }}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
    >
      <div style={{
        width: "100%", maxWidth: 620, maxHeight: "80vh", display: "flex", flexDirection: "column",
        background: "var(--card)", border: "1px solid var(--line-strong)", borderRadius: 14, padding: 18,
      }}>
        <div style={{ fontWeight: 700, color: "var(--ink)", marginBottom: 10 }}>Choose a folder on the server</div>

        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input
            className="input"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") load(manual); }}
            placeholder="/home/pwserver/serverfiles"
            style={{ flex: 1, fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}
          />
          <button type="button" className="btn btn-subtle" onClick={() => load(manual)}>Go</button>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <button type="button" className="btn btn-ghost" disabled={!data?.parent} onClick={() => load(data.parent)}>
            ↑ Up
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => load(data?.home || "")}>Home</button>
          {data?.isPalworldInstall && (
            <span style={{ alignSelf: "center", fontSize: 12, color: "var(--green, #4ade80)" }}>
              ✓ Palworld install detected here
            </span>
          )}
        </div>

        {error && <div style={{ color: "var(--red)", fontSize: 12.5, marginBottom: 8 }}>{error}</div>}

        <div style={{
          flex: 1, overflowY: "auto", minHeight: 180,
          border: "1px solid var(--line)", borderRadius: 10, background: "var(--card-2)",
        }}>
          {loading && <div style={{ padding: 14, fontSize: 13, color: "var(--ink-soft)" }}>Loading…</div>}
          {!loading && data && data.entries.length === 0 && (
            <div style={{ padding: 14, fontSize: 13, color: "var(--ink-soft)" }}>No subfolders here.</div>
          )}
          {!loading && data?.entries.map((e) => (
            <button
              key={e.path}
              type="button"
              onClick={() => load(e.path)}
              style={{
                display: "block", width: "100%", textAlign: "left", padding: "8px 12px",
                background: "transparent", border: 0, color: "var(--ink)", cursor: "pointer",
                fontSize: 13.5, fontFamily: "ui-monospace, monospace",
              }}
            >
              📁 {e.name}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button type="button" className="btn btn-ghost" onClick={() => onClose(null)}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!data} onClick={() => onClose(data.path)}>
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}

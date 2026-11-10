import { useEffect, useRef } from "react";

export const API_ROOT = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "") || window.location.origin;
const BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "") + "/api";

/* Fire-and-forget backup request when the window is being closed */
export function beaconBackup() {
  const t = getToken();
  if (!t || !navigator.sendBeacon) return;
  try { navigator.sendBeacon(BASE + "/gdrive/backup-beacon", new Blob([JSON.stringify({ token: t })], { type: "text/plain" })); } catch (e) { /* ignore */ }
}

export function getToken() {
  return localStorage.getItem("paragon_token") || "";
}
export function setToken(t) {
  if (t) localStorage.setItem("paragon_token", t);
  else localStorage.removeItem("paragon_token");
}

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    cache: "no-store",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + getToken() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== "/login") {
    setToken("");
    window.location.reload();
    throw new Error("Session expired");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data.detail;
    throw new Error(typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => x.msg).join(", ") : "Request failed");
  }
  return data;
}

export const inr = (n) => {
  const v = Number(n || 0);
  const d = Number.isInteger(v) ? 0 : 2;
  return "₹" + v.toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
};

export const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export const fmtDate = (iso) =>
  iso ? new Date(iso.slice(0, 10) + "T00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "";

export const monthLabel = (m) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleString("en-IN", { month: "long", year: "numeric" });
};

/* ---- Android app bridge (window.ParagonApp exists only inside the Paragon .apk) ---- */
export const isApp = () => typeof window !== "undefined" && !!window.ParagonApp;

export function downloadFile(name, mime, text) {
  if (isApp()) {
    try {
      window.ParagonApp.saveFile(name, mime, btoa(unescape(encodeURIComponent(text))));
      return;
    } catch (e) { /* fall back to browser download */ }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function printPage(title) {
  if (isApp()) {
    try { window.ParagonApp.print(title || document.title); return; } catch (e) { /* fall back */ }
  }
  window.print();
}

export function changeServer() {
  if (isApp()) window.ParagonApp.changeServer();
}

/* ---- Live sync ----
   Every saved change on any phone or computer bumps a counter on the server.
   Open screens check it every few seconds (and the moment the app comes back to the
   front) and reload their data when it changed. It waits while someone is typing. */
const typing = () => {
  const el = document.activeElement;
  if (!el) return false;
  const t = (el.getAttribute("type") || "").toLowerCase();
  return el.tagName === "TEXTAREA" || el.tagName === "SELECT" ||
    (el.tagName === "INPUT" && !["button", "submit", "checkbox", "radio"].includes(t));
};

export function useLiveSync(reload, ms = 5000) {
  const ref = useRef(reload);
  ref.current = reload;
  useEffect(() => {
    let last = null, busy = false, stopped = false;
    const tick = async () => {
      if (busy || stopped || document.hidden || !getToken()) return;
      busy = true;
      try {
        const r = await fetch(BASE + "/sync", { cache: "no-store", headers: { Authorization: "Bearer " + getToken() } });
        if (r.ok) {
          const { v } = await r.json();
          if (last !== null && v !== last) {
            if (typing()) { busy = false; return; } // try again on the next tick
            await Promise.resolve(ref.current()).catch(() => {});
          }
          last = v;
        }
      } catch (e) { /* offline: try again later */ }
      busy = false;
    };
    tick();
    const t = setInterval(tick, ms);
    const wake = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    return () => {
      stopped = true; clearInterval(t);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [ms]);
}

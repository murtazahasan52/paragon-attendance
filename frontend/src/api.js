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

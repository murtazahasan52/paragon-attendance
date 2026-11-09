import React, { useEffect, useRef, useState } from "react";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/barlow-semi-condensed/600.css";
import "@fontsource/barlow-semi-condensed/700.css";
import { api, beaconBackup, getToken, setToken, thisMonth, monthLabel } from "./api";
import Icon from "./icons";
import Today from "./pages/Today";
import Attendance from "./pages/Attendance";
import Salary from "./pages/Salary";
import Advances from "./pages/Advances";
import Employees from "./pages/Employees";
import Holidays from "./pages/Holidays";
import WhatsApp from "./pages/WhatsApp";
import ThisPC from "./pages/ThisPC";
import Backup from "./pages/Backup";
import Users, { ChangePassword } from "./pages/Users";

/* ------------------------------------------------------------------ Logo + Login */
export function Logo({ size = 44 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logo-mark">
      <rect width="64" height="64" rx="14" fill="#123A5E" />
      <path d="M0 46h64v4a14 14 0 0 1-14 14H14A14 14 0 0 1 0 50z" fill="#C8312B" />
      <text x="32" y="38" textAnchor="middle" fontFamily="Barlow Semi Condensed, sans-serif" fontWeight="700" fontSize="36" fill="#fff">P</text>
      <path d="M21 55l7 4 15-8" stroke="#fff" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Login({ onDone }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const r = await api("/login", { method: "POST", body: { username: u, password: p } });
      setToken(r.token);
      onDone();
    } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  return (
    <div className="login-wrap">
      <section className="login-brand">
        <Logo size={64} />
        <div className="login-word">Paragon</div>
        <p>Attendance and payroll for the Paragon team. Mark the day, pay on the 5th.</p>
      </section>
      <form className="login-form" onSubmit={submit}>
        <div className="login-mobile-head"><Logo size={48} /><span>Paragon</span></div>
        <h1>Sign in</h1>
        <p className="login-hint">Admin and accountant both sign in here with their own username and password.</p>
        <label>Username<input value={u} autoCapitalize="none" autoCorrect="off" onChange={(e) => setU(e.target.value)} autoFocus /></label>
        <label>Password<input type="password" value={p} onChange={(e) => setP(e.target.value)} /></label>
        {err && <div className="error">{err}</div>}
        <button className="btn primary block" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ Month switcher */
function MonthSwitch({ month, setMonth }) {
  const ref = useRef(null);
  const shift = (d) => {
    const [y, m] = month.split("-").map(Number);
    const t = new Date(y, m - 1 + d, 1);
    setMonth(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}`);
  };
  const open = () => {
    const el = ref.current;
    if (!el) return;
    try { el.showPicker(); } catch (e) { el.focus(); }
  };
  return (
    <div className="month-switch">
      <button className="icon-btn" onClick={() => shift(-1)} aria-label="Previous month"><Icon name="left" size={18} /></button>
      <button className="month-label" onClick={open}>{monthLabel(month)}</button>
      <input ref={ref} type="month" className="month-hidden" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} tabIndex={-1} aria-hidden="true" />
      <button className="icon-btn" onClick={() => shift(1)} aria-label="Next month"><Icon name="right" size={18} /></button>
    </div>
  );
}

/* ------------------------------------------------------------------ Navigation model */
// key, label, icon, group, uses month
const PAGES = [
  ["today", "Today", "today", "Daily", false],
  ["att", "Attendance", "attendance", "Daily", true],
  ["pay", "Salary", "salary", "Payroll", true],
  ["adv", "Advances", "advances", "Payroll", false],
  ["emp", "Employees", "employees", "Payroll", false],
  ["hol", "Holidays & year", "holidays", "Setup", true],
  ["wa", "WhatsApp", "whatsapp", "Setup", false],
  ["bak", "Backup", "backup", "Setup", false],
  ["users", "Logins", "users", "Setup", false],
  ["pc", "This PC", "pc", "Setup", false],
];
const BOTTOM = ["today", "att", "pay"];

const GDRIVE_NOTICE = {
  connected: "Google Drive connected ✓ Backups will now be saved automatically.",
  cancelled: "Google Drive connection was cancelled.",
  failed: "Google Drive connection failed. Check the Client ID, Client Secret and redirect URI, then try again.",
  expired: "The connect link expired. Please click Connect Google Drive again.",
  norefresh: "Google did not give long-term access. Remove the app's access at myaccount.google.com/permissions and connect again.",
};

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const gdParam = new URLSearchParams(window.location.search).get("gdrive");
  const [tab, setTab] = useState(gdParam ? "bak" : "today");
  const [gdNotice] = useState(gdParam ? GDRIVE_NOTICE[gdParam] || "" : "");
  const [gd, setGd] = useState(null);
  const [exiting, setExiting] = useState("");
  const [month, setMonth] = useState(thisMonth());
  const [pc, setPc] = useState(null); // only on the Windows / LAN edition
  const [me, setMe] = useState(null); // logged-in user {name, role}
  const [pwOpen, setPwOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!authed) { setMe(null); return; }
    api("/me").then(setMe).catch((e) => setMe(/not found/i.test(e.message) ? { role: "admin", name: "Admin", legacy: true } : null));
  }, [authed]);
  const isAdmin = !!me && me.role === "admin";
  useEffect(() => {
    if (authed && isAdmin) api("/server-info").then((r) => setPc(r && r.edition === "desktop" ? r : null)).catch(() => setPc(null));
  }, [authed, isAdmin]);
  useEffect(() => { if (gdParam) window.history.replaceState(null, "", window.location.pathname); }, [gdParam]);
  useEffect(() => { if (authed) api("/gdrive/status").then(setGd).catch(() => setGd(null)); }, [authed]);
  useEffect(() => {
    if (!authed || !gd || !gd.connected || !gd.backup_on_exit) return undefined;
    const h = () => beaconBackup();
    window.addEventListener("pagehide", h);
    return () => window.removeEventListener("pagehide", h);
  }, [authed, gd]);
  useEffect(() => { window.scrollTo(0, 0); setMoreOpen(false); setMenuOpen(false); }, [tab]);

  const exitApp = async () => {
    setMenuOpen(false);
    if (gd && gd.connected && gd.backup_on_exit) {
      setExiting("Backing up to Google Drive…");
      try {
        const r = await api("/gdrive/backup", { method: "POST", body: { reason: "exit" } });
        setExiting(r.status === "ok" ? "Backup saved to Google Drive ✓" : r.status === "unchanged" ? "No changes since the last backup ✓" : "Backup failed: " + r.message);
        await new Promise((res) => setTimeout(res, r.status === "failed" ? 3500 : 1200));
      } catch (e) { setExiting("Backup failed: " + e.message); await new Promise((res) => setTimeout(res, 3500)); }
    }
    setExiting("");
    setToken("");
    setAuthed(false);
  };

  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  if (!me) return <div className="boot"><Logo size={48} /></div>;

  const pages = PAGES.filter(([k]) => {
    if (!isAdmin) return k === "today" || k === "att";
    if (k === "users") return !me.legacy;
    if (k === "pc") return !!pc;
    return true;
  });
  const cur = pages.find((p) => p[0] === tab) || pages[0];
  const key = cur[0];
  const year = Number(month.slice(0, 4));
  const groups = [...new Set(pages.map((p) => p[3]))];
  const exitLabel = gd && gd.connected && gd.backup_on_exit ? "Back up & exit" : "Log out";
  const initials = (me.name || "?").replace(/\(.*?\)/g, "").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const bottom = isAdmin ? pages.filter((p) => BOTTOM.includes(p[0])) : pages;
  const morePages = isAdmin ? pages.filter((p) => !BOTTOM.includes(p[0])) : [];

  return (
    <div className="shell">
      <aside className="side no-print">
        <div className="side-brand"><Logo size={36} /><div><b>Paragon</b><span>Attendance & payroll</span></div></div>
        <nav>
          {groups.map((g) => (
            <div key={g} className="side-group">
              {isAdmin && <div className="side-group-name">{g}</div>}
              {pages.filter((p) => p[3] === g).map(([k, label, ic]) => (
                <button key={k} title={label} className={"side-link" + (key === k ? " on" : "")} onClick={() => setTab(k)} aria-current={key === k ? "page" : undefined}>
                  <Icon name={ic} size={19} /><span>{label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <div className="side-user"><span className="avatar">{initials}</span><div><b>{me.name}</b><span>{isAdmin ? "Admin" : "Accountant"}</span></div></div>
          <div className="side-actions">
            {!me.legacy && <button className="icon-btn light" title="Change my password" onClick={() => setPwOpen(true)}><Icon name="key" size={18} /></button>}
            <button className="side-exit" onClick={exitApp}><Icon name="logout" size={17} /> {exitLabel}</button>
          </div>
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar no-print">
          <h1>{cur[1]}</h1>
          <div className="topbar-right">
            {cur[4] && <MonthSwitch month={month} setMonth={setMonth} />}
            <button className="avatar-btn" onClick={() => setMenuOpen((v) => !v)} aria-label="Account menu" aria-expanded={menuOpen}><span className="avatar">{initials}</span></button>
          </div>
          {menuOpen && (
            <>
              <div className="menu-scrim" onClick={() => setMenuOpen(false)} />
              <div className="menu-pop" role="menu">
                <div className="menu-who"><b>{me.name}</b><span>{isAdmin ? "Admin: full access" : "Accountant: attendance only"}</span></div>
                {!me.legacy && <button role="menuitem" onClick={() => { setMenuOpen(false); setPwOpen(true); }}><Icon name="key" size={18} /> Change my password</button>}
                <button role="menuitem" onClick={exitApp}><Icon name="logout" size={18} /> {exitLabel}</button>
              </div>
            </>
          )}
        </header>
        <main className={"page page-" + key}>
          {key === "today" && <Today isAdmin={isAdmin} />}
          {key === "att" && <Attendance month={month} isAdmin={isAdmin} />}
          {isAdmin && key === "pay" && <Salary month={month} />}
          {isAdmin && key === "adv" && <Advances />}
          {isAdmin && key === "emp" && <Employees />}
          {isAdmin && key === "hol" && <Holidays year={year} />}
          {isAdmin && key === "wa" && <WhatsApp />}
          {isAdmin && key === "bak" && <Backup notice={gdNotice} onStatus={setGd} />}
          {isAdmin && key === "users" && <Users me={me} />}
          {isAdmin && key === "pc" && pc && <ThisPC info={pc} />}
        </main>
      </div>

      <nav className="bottombar no-print" aria-label="Main">
        {bottom.map(([k, label, ic]) => (
          <button key={k} className={key === k && !moreOpen ? "on" : ""} onClick={() => setTab(k)}><Icon name={ic} size={22} /><span>{label}</span></button>
        ))}
        {morePages.length > 0 && (
          <button className={moreOpen || morePages.some((p) => p[0] === key) ? "on" : ""} onClick={() => setMoreOpen((v) => !v)}><Icon name="more" size={22} /><span>More</span></button>
        )}
      </nav>
      {moreOpen && (
        <div className="sheet-bg no-print" onClick={() => setMoreOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grip" />
            <div className="sheet-grid">
              {morePages.map(([k, label, ic]) => (
                <button key={k} className={key === k ? "on" : ""} onClick={() => setTab(k)}><Icon name={ic} size={24} /><span>{label}</span></button>
              ))}
            </div>
          </div>
        </div>
      )}
      {pwOpen && <ChangePassword onClose={() => setPwOpen(false)} />}
      {exiting && <div className="exit-overlay"><div className="exit-box">{exiting.endsWith("…") && <div className="spinner" />}{exiting}</div></div>}
    </div>
  );
}

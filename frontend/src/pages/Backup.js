import React, { useCallback, useEffect, useState } from "react";
import { api, API_ROOT, todayISO, downloadFile } from "../api";

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const fmtSize = (b) => (b ? (Number(b) / 1024).toFixed(Number(b) > 102400 ? 0 : 1) + " KB" : "");

export default function Backup({ notice, onStatus }) {
  const [st, setSt] = useState(null);
  const [form, setForm] = useState(null);
  const [files, setFiles] = useState(null);
  const [msg, setMsg] = useState(notice || "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const redirectUri = API_ROOT + "/api/gdrive/callback";
  const host = window.location.hostname;
  const googleOk = window.location.protocol === "https:" || host === "localhost" || host === "127.0.0.1";

  const load = useCallback(async () => {
    try {
      const s = await api("/gdrive/status");
      setSt(s); onStatus && onStatus(s);
      setForm({ client_id: s.client_id, client_secret: s.client_secret, backup_on_exit: s.backup_on_exit, daily_backup: s.daily_backup,
        daily_backup_time: s.daily_backup_time, keep_backups: s.keep_backups });
      if (s.connected) api("/gdrive/backups").then(setFiles).catch((x) => { setFiles([]); setErr(x.message); });
      else setFiles(null);
    } catch (x) { setErr(x.message); }
  }, [onStatus]);
  useEffect(() => { load(); }, [load]);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(""), 6000); };
  const save = async (e) => {
    e && e.preventDefault(); setErr("");
    try { await api("/gdrive/settings", { method: "PUT", body: { ...form, keep_backups: Number(form.keep_backups) } }); flash("Backup settings saved ✓"); load(); }
    catch (x) { setErr(x.message); }
  };
  const connect = async () => {
    setErr("");
    try {
      await api("/gdrive/settings", { method: "PUT", body: { ...form, keep_backups: Number(form.keep_backups) } });
      const r = await api(`/gdrive/auth-url?api_base=${encodeURIComponent(API_ROOT)}&return_to=${encodeURIComponent(window.location.origin)}`);
      window.location.href = r.url;
    } catch (x) { setErr(x.message); }
  };
  const disconnect = async () => {
    if (!window.confirm("Disconnect Google Drive? Backups already on Drive stay there.")) return;
    await api("/gdrive/disconnect", { method: "POST" }); load();
  };
  const backupNow = async () => {
    setBusy("backup"); setErr("");
    try { const r = await api("/gdrive/backup", { method: "POST", body: { reason: "manual", force: true } }); r.status === "ok" ? flash(r.message) : setErr(r.message); }
    catch (x) { setErr(x.message); }
    setBusy(""); load();
  };
  const restore = async (f) => {
    if (!window.confirm(`Restore ${f.name}?\n\nALL current data (employees, attendance, advances, salary slips, settings) will be replaced by this backup.\nA backup of the current data is saved to Drive first.`)) return;
    if (window.prompt('Type RESTORE to confirm') !== "RESTORE") return;
    setBusy("restore"); setErr("");
    try { await api("/gdrive/restore", { method: "POST", body: { file_id: f.id } }); flash(`Restored from ${f.name} ✓`); }
    catch (x) { setErr(x.message); }
    setBusy(""); load();
  };
  const restoreFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setErr("");
    try {
      let text;
      if (file.name.endsWith(".gz")) {
        if (!window.DecompressionStream) throw new Error("This browser cannot open .gz files. Use the .json file instead.");
        text = await new Response(file.stream().pipeThrough(new window.DecompressionStream("gzip"))).text();
      } else text = await file.text();
      const data = JSON.parse(text);
      if (data.app !== "paragon-attendance") throw new Error("This is not a Paragon Attendance backup file");
      const n = (k) => (Array.isArray(data[k]) ? data[k].length : 0);
      if (!window.confirm(`Restore ${file.name}?\n\nIt has ${n("employees")} employees, ${n("attendance")} attendance marks and ${n("slips")} salary slips.\nALL current data will be replaced.`)) return;
      if (window.prompt("Type RESTORE to confirm") !== "RESTORE") return;
      setBusy("restore");
      const r = await api("/restore-file", { method: "POST", body: { data } });
      flash(`Restored ✓ ${r.counts.employees} employees, ${r.counts.attendance} attendance marks, ${r.counts.slips} slips.`);
    } catch (x) { setErr(x.message); }
    setBusy(""); load();
  };
  const download = async () => {
    const data = await api("/backup");
    downloadFile(`Paragon-Attendance-Backup-${todayISO()}.json`, "application/json", JSON.stringify(data));
  };

  if (!st || !form) return <div className="muted pad">{err || "Loading…"}</div>;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  return (
    <div>
      {msg && <div className="okmsg">{msg}</div>}
      {err && <div className="error" onClick={() => setErr("")}>{err}</div>}
      <div className="two-col">
        <div className="card">
          <h3>Google Drive</h3>
          {st.connected ? (
            <>
              <div className="gd-connected">✓ Connected to <b>{st.email || "Google Drive"}</b></div>
              <p className="muted small">Backups are saved in the folder <b>Paragon Attendance Backups</b> in this Google Drive. The app can only see the files it creates there.</p>
              <table className="kv"><tbody>
                <tr><td>Last backup</td><td>{fmtTime(st.last_backup_at)} {st.last_status && <span className={"tag " + (st.last_status === "ok" ? "ok" : "bad")}>{st.last_status === "ok" ? "OK" : "Failed"}</span>}</td></tr>
                <tr><td>Details</td><td className="small">{st.last_message || "—"}{st.last_file ? ` · ${st.last_file}` : ""}</td></tr>
              </tbody></table>
              <div className="actions">
                <button className="btn danger" onClick={disconnect}>Disconnect</button>
                <button className="btn primary" disabled={!!busy} onClick={backupNow}>{busy === "backup" ? "Backing up…" : "Back up now"}</button>
              </div>
            </>
          ) : (
            <>
              <p className="muted small">Connect a Google account once. The app then saves a backup to Google Drive when you exit, and once every day.</p>
              {!googleOk && <div className="warn">Google only allows connecting from <b>http://localhost</b> or an <b>https://</b> address. Open the app on the server PC at <b>http://localhost:{window.location.port || 80}</b> and connect from there. After that, every laptop backs up automatically.</div>}
              <label>Google OAuth Client ID<input value={form.client_id} onChange={set("client_id")} placeholder="xxxx.apps.googleusercontent.com" /></label>
              <label>Google OAuth Client Secret<input value={form.client_secret} onChange={set("client_secret")} placeholder="GOCSPX-…" /></label>
              <div className="actions"><button className="btn primary gd-btn" onClick={connect} disabled={!googleOk || !form.client_id || !form.client_secret}>Connect Google Drive</button></div>
              <details className="setup">
                <summary>One-time setup: get a Client ID and Secret (5 minutes)</summary>
                <ol>
                  <li>Open <b>console.cloud.google.com</b> and create a project, for example "Paragon Attendance".</li>
                  <li><b>APIs & Services → Library</b> → search <b>Google Drive API</b> → Enable.</li>
                  <li><b>OAuth consent screen</b> (Google Auth Platform) → User type <b>External</b> → app name "Paragon Attendance", your email → Save. Then under <b>Audience</b> click <b>Publish app</b> (In production). If you skip this, Google disconnects you every 7 days.</li>
                  <li><b>Credentials → Create credentials → OAuth client ID</b> → type <b>Web application</b>.</li>
                  <li>Under <b>Authorized redirect URIs</b> add exactly:<div className="lan-url small-url">{redirectUri}</div>{API_ROOT.startsWith("http://") && !API_ROOT.includes("localhost") && <span className="muted small">(For the Windows edition, add <code>http://localhost:8001/api/gdrive/callback</code>.)</span>}</li>
                  <li>Copy the <b>Client ID</b> and <b>Client Secret</b> into the boxes above → Connect Google Drive → choose the Google account → Allow. If Google shows "app not verified", click <b>Advanced → Go to Paragon Attendance</b>. This is safe because it's your own app.</li>
                </ol>
                <p className="muted small">You can reuse the same Client ID for every PC or customer. Just add each one's redirect URI in step 5.</p>
              </details>
            </>
          )}
        </div>
        <form className="card" onSubmit={save}>
          <h3>When to back up</h3>
          <label className="check"><input type="checkbox" checked={form.backup_on_exit} onChange={set("backup_on_exit")} /> Back up to Google Drive when someone clicks Exit or closes the app</label>
          <div className="row">
            <label className="check"><input type="checkbox" checked={form.daily_backup} onChange={set("daily_backup")} /> Also back up every day at</label>
            <label>Time (IST)<input type="time" value={form.daily_backup_time} onChange={set("daily_backup_time")} /></label>
          </div>
          <label>Keep the last … backups on Drive (older ones are deleted)<input type="number" min="1" max="365" value={form.keep_backups} onChange={set("keep_backups")} /></label>
          <p className="muted small">If nothing has changed since the last backup, no new file is made, so Drive doesn't fill up with copies.</p>
          <div className="actions"><button className="btn primary">Save</button></div>
          <h4>Local copy</h4>
          <p className="muted small">Downloads all the data as one file to this computer.</p>
          <div className="actions"><button type="button" className="btn" onClick={download}>Download backup file</button></div>
          <h4>Restore from a backup file</h4>
          <p className="muted small">Use this to move data from the office PC version to the online version, or to restore a downloaded file (Paragon-Attendance-Backup-….json, or a .json.gz from Drive).</p>
          <label className="file-pick">Choose backup file…<input type="file" accept=".json,.gz,application/json,application/gzip" onChange={restoreFile} hidden /></label>
        </form>
      </div>

      {st.connected && (
        <div className="card flush scroll">
          <div className="toolbar pad-sm"><h3>Backups on Google Drive</h3><button className="btn sm" onClick={load}>Refresh</button></div>
          <table className="grid-table cards">
            <thead><tr><th>File</th><th>Date</th><th className="r">Size</th><th></th></tr></thead>
            <tbody>
              {(files || []).map((f) => (
                <tr key={f.id}>
                  <td className="card-title">{f.name}</td>
                  <td data-label="Date">{fmtTime(f.createdTime)}</td>
                  <td data-label="Size" className="r">{fmtSize(f.size)}</td>
                  <td className="r nowrap card-actions">
                    {f.webViewLink && <a className="btn sm" href={f.webViewLink} target="_blank" rel="noreferrer">Open in Drive</a>}{" "}
                    <button className="btn sm danger" disabled={!!busy} onClick={() => restore(f)}>{busy === "restore" ? "Restoring…" : "Restore"}</button>
                  </td>
                </tr>
              ))}
              {files && !files.length && <tr><td colSpan="4" className="muted pad">No backups yet. Click “Back up now”.</td></tr>}
              {!files && <tr><td colSpan="4" className="muted pad">Loading…</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

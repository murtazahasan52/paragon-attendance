import React, { useEffect, useState } from "react";
import { api, todayISO, downloadFile } from "../api";

/* Only shown in the Windows / LAN edition (the server answers /api/server-info) */
export default function ThisPC({ info }) {
  const [pw, setPw] = useState({ old_password: "", new_password: "", confirm: "" });
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [live, setLive] = useState(info);
  useEffect(() => { api("/server-info").then(setLive).catch(() => {}); }, []);

  const change = async (e) => {
    e.preventDefault(); setErr(""); setMsg("");
    if (pw.new_password !== pw.confirm) { setErr("New passwords do not match"); return; }
    try { await api("/change-password", { method: "POST", body: pw }); setMsg("Password changed ✓"); setPw({ old_password: "", new_password: "", confirm: "" }); }
    catch (x) { setErr(x.message); }
  };
  const backup = async () => {
    const data = await api("/backup");
    downloadFile(`Paragon-Attendance-Backup-${todayISO()}.json`, "application/json", JSON.stringify(data));
  };

  return (
    <div className="two-col">
      <div className="card">
        <h3>Open on other laptops and phones</h3>
        <p className="muted small">Any laptop or phone on the same Wi-Fi or LAN as this PC can open the app in a browser with:</p>
        {(live.lan_urls || []).map((u) => <div key={u} className="lan-url">{u}</div>)}
        {!(live.lan_urls || []).length && <div className="warn">This PC is not connected to a network right now.</div>}
        <p className="muted small">The address uses this PC's IP address. If the router gives the PC a new IP, the address changes, so ask your network person to fix (reserve) the PC's IP in the router. The server PC must stay on for others to use the app and for WhatsApp messages to go out on time.</p>
        <table className="kv"><tbody>
          <tr><td>PC name</td><td>{live.hostname}</td></tr>
          <tr><td>Port</td><td>{live.port}</td></tr>
          <tr><td>Data folder</td><td className="small">{live.data_dir}</td></tr>
        </tbody></table>
      </div>
      <div>
        <form className="card" onSubmit={change}>
          <h3>Change admin password</h3>
          <label>Current password<input type="password" value={pw.old_password} onChange={(e) => setPw({ ...pw, old_password: e.target.value })} /></label>
          <label>New password<input type="password" value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} /></label>
          <label>Confirm new password<input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></label>
          {msg && <div className="okmsg">{msg}</div>}
          {err && <div className="error">{err}</div>}
          <div className="actions"><button className="btn primary">Change password</button></div>
        </form>
        <div className="card">
          <h3>Backup</h3>
          <p className="muted small">Google Drive backup and restore are on the <b>Backup</b> tab. You can also download a copy here.</p>
          <div className="actions"><button className="btn" onClick={backup}>Download backup</button></div>
        </div>
      </div>
    </div>
  );
}

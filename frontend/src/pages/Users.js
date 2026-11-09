import React, { useEffect, useState } from "react";
import { api, fmtDate } from "../api";
import { Modal } from "../components";

const ROLE_TEXT = {
  admin: "Admin: full access",
  accountant: "Accountant: only marks Present / Half day / Absent",
};

function UserForm({ initial, onClose, onSaved }) {
  const isNew = !initial.id;
  const [f, setF] = useState({ ...initial, password: "" });
  const [err, setErr] = useState("");
  const save = async (e) => {
    e.preventDefault();
    setErr("");
    try {
      const body = { username: f.username, name: f.name, role: f.role, active: f.active, password: f.password || null };
      if (isNew) await api("/users", { method: "POST", body });
      else await api(`/users/${f.id}`, { method: "PUT", body });
      onSaved();
    } catch (x) { setErr(x.message); }
  };
  return (
    <Modal title={isNew ? "Add login" : `Edit login: ${initial.username}`} onClose={onClose}>
      <form onSubmit={save}>
        <div className="row">
          <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Sana (Accounts)" /></label>
          <label>Username *<input required disabled={!isNew} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase().replace(/\s/g, "") })} placeholder="e.g. accounts" /></label>
        </div>
        <div className="row">
          <label>Access
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              <option value="accountant">Accountant: attendance marking only</option>
              <option value="admin">Admin: full access</option>
            </select>
          </label>
          <label>{isNew ? "Password *" : "New password (leave empty to keep)"}
            <input type="text" required={isNew} minLength={6} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="at least 6 characters" />
          </label>
        </div>
        {!isNew && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active (untick to block this login)</label>}
        <div className="info-bar">{ROLE_TEXT[f.role]}</div>
        {err && <div className="error">{err}</div>}
        <div className="actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

export default function Users({ me }) {
  const [list, setList] = useState(null);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState("");
  const load = () => api("/users").then(setList).catch((x) => setErr(x.message));
  useEffect(() => { load(); }, []);
  const del = async (u) => {
    if (!window.confirm(`Delete the login "${u.username}"?`)) return;
    try { await api(`/users/${u.id}`, { method: "DELETE" }); load(); } catch (x) { setErr(x.message); }
  };
  if (!list) return <div className="muted pad">{err || "Loading…"}</div>;
  return (
    <div>
      <div className="toolbar">
        <div className="muted small">
          <b>Admin</b> sees everything. <b>Accountant</b> sees only the Today and Attendance pages, can mark Present / Half day / Absent, and cannot see salaries, advances or settings.
        </div>
        <button className="btn primary" onClick={() => setEdit({ username: "", name: "", role: "accountant", active: true })}>+ Add login</button>
      </div>
      {err && <div className="error" onClick={() => setErr("")}>{err}</div>}
      <div className="card flush scroll">
        <table className="grid-table cards">
          <thead><tr><th>Name</th><th>Username</th><th>Access</th><th>Status</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.id} className={u.active ? "" : "inactive"}>
                <td className="card-title"><b>{u.name}</b>{me && me.id === u.id && <span className="tag mini">you</span>}</td>
                <td data-label="Username" className="mono-cell">{u.username}</td>
                <td data-label="Access"><span className={"tag " + (u.role === "admin" ? "" : "fixed")}>{u.role === "admin" ? "Admin" : "Accountant"}</span></td>
                <td data-label="Status">{u.active ? "Active" : "Blocked"}</td>
                <td data-label="Created">{fmtDate(u.created_at)}</td>
                <td className="r nowrap card-actions">
                  <button className="btn sm" onClick={() => setEdit(u)}>Edit</button>{" "}
                  {!(me && me.id === u.id) && <button className="btn sm danger" onClick={() => del(u)}>Delete</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <UserForm initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </div>
  );
}

export function ChangePassword({ onClose }) {
  const [pw, setPw] = useState({ old_password: "", new_password: "", confirm: "" });
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const save = async (e) => {
    e.preventDefault(); setErr(""); setMsg("");
    if (pw.new_password !== pw.confirm) { setErr("New passwords do not match"); return; }
    try { await api("/change-password", { method: "POST", body: pw }); setMsg("Password changed ✓"); setPw({ old_password: "", new_password: "", confirm: "" }); }
    catch (x) { setErr(x.message); }
  };
  return (
    <Modal title="Change my password" onClose={onClose}>
      <form onSubmit={save}>
        <label>Current password<input type="password" value={pw.old_password} onChange={(e) => setPw({ ...pw, old_password: e.target.value })} /></label>
        <label>New password<input type="password" value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} /></label>
        <label>Confirm new password<input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></label>
        {msg && <div className="okmsg">{msg}</div>}
        {err && <div className="error">{err}</div>}
        <div className="actions"><button type="button" className="btn" onClick={onClose}>Close</button><button className="btn primary">Change password</button></div>
      </form>
    </Modal>
  );
}

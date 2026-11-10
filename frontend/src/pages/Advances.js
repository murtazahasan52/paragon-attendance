import React, { useEffect, useState } from "react";
import { api, inr, fmtDate, thisMonth, todayISO, monthLabel, useLiveSync } from "../api";
import { Modal } from "../components";

export const PLAN_TEXT = (a) =>
  a.plan === "monthly" ? `${inr(a.installment)} per month from ${monthLabel(a.start_month)}`
    : a.plan === "one_time" ? `Full amount in ${monthLabel(a.start_month)}`
      : "Admin decides each month";

export function AdvanceForm({ employees, fixedEmployee, initial, onClose, onSaved }) {
  const [f, setF] = useState(initial || {
    employee_id: fixedEmployee || "", date: todayISO(), amount: "", plan: "manual", installment: "",
    start_month: thisMonth(), note: "",
  });
  const [err, setErr] = useState("");
  const save = async (e) => {
    e.preventDefault();
    setErr("");
    try {
      const body = { ...f, amount: Number(f.amount), installment: Number(f.installment || 0) };
      if (f.id) await api(`/advances/${f.id}`, { method: "PUT", body });
      else await api("/advances", { method: "POST", body });
      onSaved();
    } catch (x) { setErr(x.message); }
  };
  const months = f.plan === "monthly" && f.amount && f.installment ? Math.ceil(Number(f.amount) / Number(f.installment)) : null;
  return (
    <Modal title={f.id ? "Edit advance" : "Give advance"} onClose={onClose}>
      <form onSubmit={save}>
        {!fixedEmployee && (
          <label>Employee *
            <select required value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}>
              <option value="">Select…</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </label>
        )}
        <div className="row">
          <label>Date given *<input type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
          <label>Amount (₹) *<input type="number" min="1" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
        </div>
        <div className="row">
          <label>How to recover
            <select value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}>
              <option value="manual">Admin decides each month (on the Salary page)</option>
              <option value="monthly">Fixed amount every month</option>
              <option value="one_time">Full amount in one month</option>
            </select>
          </label>
          <label>Start deducting from salary of<input type="month" required value={f.start_month} onChange={(e) => setF({ ...f, start_month: e.target.value })} /></label>
        </div>
        {f.plan === "monthly" && (
          <label>Deduct per month (₹) *<input type="number" min="1" required value={f.installment} onChange={(e) => setF({ ...f, installment: e.target.value })} />
            {months && <span className="muted small">About {months} month(s) to recover</span>}</label>
        )}
        <label>Note / agreement<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. Medical, festival advance" /></label>
        <p className="muted small">You can still change the amount deducted in any month on the Salary page before generating the slip.</p>
        {err && <div className="error">{err}</div>}
        <div className="actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

export default function Advances() {
  const [list, setList] = useState(null);
  const [emps, setEmps] = useState([]);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const load = () => Promise.all([api("/advances"), api("/employees")]).then(([a, e]) => { setList(a); setEmps(e); }).catch((x) => setErr(x.message));
  useEffect(() => { load(); }, []);
  useLiveSync(load);
  const del = async (a) => {
    if (!window.confirm(`Delete advance of ${inr(a.amount)} for ${a.employee_name}?`)) return;
    try { await api(`/advances/${a.id}`, { method: "DELETE" }); load(); } catch (x) { setErr(x.message); }
  };
  if (!list) return <div className="muted pad">{err || "Loading…"}</div>;
  const shown = list.filter((a) => showClosed || a.remaining > 0);
  const outstanding = list.reduce((s, a) => s + a.remaining, 0);
  return (
    <div>
      <div className="toolbar">
        <div className="row-inline">
          <span>Total outstanding: <b>{inr(outstanding)}</b></span>
          <label className="check inline"><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show fully recovered</label>
        </div>
        <button className="btn primary" onClick={() => setForm({})}>+ Give advance</button>
      </div>
      {err && <div className="error" onClick={() => setErr("")}>{err}</div>}
      <div className="card flush scroll">
        <table className="grid-table cards">
          <thead><tr><th>Date</th><th>Employee</th><th className="r">Amount</th><th>Recovery plan</th><th className="r">Recovered</th><th className="r">Balance</th><th>Note</th><th></th></tr></thead>
          <tbody>
            {shown.map((a) => (
              <tr key={a.id} className={a.remaining <= 0 ? "inactive" : ""}>
                <td data-label="Date">{fmtDate(a.date)}</td><td className="card-title"><b>{a.employee_name}</b></td><td data-label="Amount" className="r">{inr(a.amount)}</td>
                <td data-label="Plan">{PLAN_TEXT(a)}</td><td data-label="Recovered" className="r">{inr(a.recovered)}</td><td data-label="Balance" className="r"><b>{inr(a.remaining)}</b></td><td data-label="Note" className="hide-empty">{a.note}</td>
                <td className="r nowrap card-actions">
                  <button className="btn sm" onClick={() => setForm({ initial: a })}>Edit</button>{" "}
                  <button className="btn sm danger" onClick={() => del(a)}>Delete</button>
                </td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan="8" className="muted pad">No advances.</td></tr>}
          </tbody>
        </table>
      </div>
      {form && <AdvanceForm employees={emps.filter((e) => e.active)} initial={form.initial ? { ...form.initial } : null}
        onClose={() => setForm(null)} onSaved={() => { setForm(null); load(); }} />}
    </div>
  );
}

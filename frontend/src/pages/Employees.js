import React, { useEffect, useState } from "react";
import { api, inr, fmtDate, monthLabel, thisMonth, printPage, useLiveSync } from "../api";
import { Modal, Stat, WaBadge } from "../components";
import { AdvanceForm, PLAN_TEXT } from "./Advances";

const blankEmp = { code: "", name: "", phone: "", designation: "", salary_type: "per_day", monthly_salary: "", join_date: "", active: true };

function EmployeeForm({ initial, onClose, onSaved }) {
  const [f, setF] = useState(initial);
  const [err, setErr] = useState("");
  const isNew = !f.id;
  const save = async (e) => {
    e.preventDefault();
    setErr("");
    try {
      const body = { ...f, monthly_salary: Number(f.monthly_salary || 0) };
      if (isNew) await api("/employees", { method: "POST", body });
      else await api(`/employees/${f.id}`, { method: "PUT", body });
      onSaved();
    } catch (x) { setErr(x.message); }
  };
  return (
    <Modal title={isNew ? "Add employee" : "Edit employee"} onClose={onClose}>
      <form onSubmit={save}>
        <div className="row">
          <label>Employee code<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></label>
          <label>Name *<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        </div>
        <div className="row">
          <label>Designation<input value={f.designation} onChange={(e) => setF({ ...f, designation: e.target.value })} /></label>
          <label>WhatsApp number<input value={f.phone} placeholder="10-digit mobile" onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
        </div>
        {isNew ? (
          <div className="row">
            <label>Salary type
              <select value={f.salary_type} onChange={(e) => setF({ ...f, salary_type: e.target.value })}>
                <option value="per_day">Per day (paid for days worked)</option>
                <option value="fixed">Fixed monthly (no deduction)</option>
              </select>
            </label>
            <label>Monthly salary (₹) *<input required type="number" min="0" value={f.monthly_salary} onChange={(e) => setF({ ...f, monthly_salary: e.target.value })} /></label>
          </div>
        ) : (
          <div className="info-bar">Salary: <b>{inr(f.monthly_salary)}</b> ({f.salary_type === "fixed" ? "Fixed monthly" : "Per day"}). Use “Change salary” in the employee list to change it from a chosen month.</div>
        )}
        <div className="row">
          <label>Joining date<input type="date" value={f.join_date} onChange={(e) => setF({ ...f, join_date: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
        </div>
        {err && <div className="error">{err}</div>}
        <div className="actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

function SalaryChange({ emp, onClose, onSaved }) {
  const [f, setF] = useState({ effective_from: thisMonth(), monthly_salary: emp.monthly_salary, salary_type: emp.salary_type, note: "" });
  const [err, setErr] = useState("");
  const [warn, setWarn] = useState(null);
  const [cur, setCur] = useState(emp);
  const save = async (e) => {
    e.preventDefault();
    setErr("");
    try {
      const r = await api(`/employees/${emp.id}/salary-change`, { method: "POST", body: { ...f, monthly_salary: Number(f.monthly_salary) } });
      if (r.generated_slips_affected.length) setWarn(r.generated_slips_affected);
      else onSaved();
      setCur(r.employee);
    } catch (x) { setErr(x.message); }
  };
  const removeEntry = async (h) => {
    if (!window.confirm(`Remove the salary entry from ${monthLabel(h.effective_from)}?`)) return;
    try { setCur(await api(`/employees/${emp.id}/salary-change/${h.effective_from}`, { method: "DELETE" })); } catch (x) { setErr(x.message); }
  };
  const hist = cur.salary_history || [];
  return (
    <Modal title={`Change salary: ${emp.name}`} onClose={warn ? onSaved : onClose}>
      {warn ? (
        <div>
          <div className="warn">Saved. Slips for {warn.map(monthLabel).join(", ")} were already generated with the old salary. To apply the new salary to them, cancel those slips on the Salary page and generate them again.</div>
          <div className="actions"><button className="btn primary" onClick={onSaved}>OK</button></div>
        </div>
      ) : (
        <form onSubmit={save}>
          <div className="row">
            <label>Applicable from salary month *<input type="month" required value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} /></label>
            <label>New monthly salary (₹) *<input type="number" min="0" required value={f.monthly_salary} onChange={(e) => setF({ ...f, monthly_salary: e.target.value })} /></label>
          </div>
          <div className="row">
            <label>Salary type
              <select value={f.salary_type} onChange={(e) => setF({ ...f, salary_type: e.target.value })}>
                <option value="per_day">Per day</option><option value="fixed">Fixed monthly</option>
              </select>
            </label>
            <label>Note<input value={f.note} placeholder="e.g. Yearly increment" onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
          </div>
          <p className="muted small">Months before {monthLabel(f.effective_from)} keep the old salary. From this month on, the daily rate is worked out from the new salary.</p>
          {err && <div className="error">{err}</div>}
          <div className="actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save salary change</button></div>
          <h4>Salary history</h4>
          <table className="grid-table">
            <thead><tr><th>From month</th><th className="r">Monthly salary</th><th>Type</th><th>Note</th><th></th></tr></thead>
            <tbody>
              {[...hist].reverse().map((h) => (
                <tr key={h.effective_from}>
                  <td>{h.effective_from === "2000-01" ? "Start" : monthLabel(h.effective_from)}</td><td className="r">{inr(h.monthly_salary)}</td>
                  <td>{h.salary_type === "fixed" ? "Fixed" : "Per day"}</td><td>{h.note}</td>
                  <td className="r">{hist.length > 1 && <button type="button" className="btn sm danger" onClick={() => removeEntry(h)}>✕</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </form>
      )}
    </Modal>
  );
}

function Ledger({ emp, onClose }) {
  const [L, setL] = useState(null);
  const [adv, setAdv] = useState(false);
  const load = () => api(`/employees/${emp.id}/ledger`).then(setL);
  useEffect(() => { load(); }, []);
  return (
    <Modal title={`Ledger: ${emp.name}`} onClose={onClose} wide>
      {!L ? <div className="muted pad">Loading…</div> : (
        <div className="print-area">
          <div className="muted small">{L.employee.designation} {L.employee.phone && "· " + L.employee.phone} · Current salary {inr(L.employee.monthly_salary)} ({L.employee.salary_type === "fixed" ? "Fixed" : "Per day"})</div>
          <div className="stats mt">
            <Stat label="Total salary generated" value={inr(L.totals.gross)} />
            <Stat label="Total net paid" value={inr(L.totals.net)} />
            <Stat label="Advances given" value={inr(L.totals.advance_given)} />
            <Stat label="Advance outstanding" value={inr(L.totals.advance_outstanding)} accent />
          </div>
          <div className="toolbar no-print">
            <h4>Statement</h4>
            <div className="row-inline">
              <button className="btn" onClick={() => setAdv(true)}>+ Give advance</button>
              <button className="btn" onClick={() => printPage(`Ledger ${emp.name}`)}>Print</button>
            </div>
          </div>
          <table className="grid-table">
            <thead><tr><th>Date</th><th>Details</th><th className="r">Gross salary</th><th className="r">Advance given</th><th className="r">Advance deducted</th><th className="r">Net paid</th><th className="r">Advance balance</th></tr></thead>
            <tbody>
              {L.entries.map((e, i) => (
                <tr key={i}>
                  <td className="nowrap">{fmtDate(e.date)}</td><td>{e.text}</td>
                  <td className="r">{e.gross != null ? inr(e.gross) : ""}</td>
                  <td className="r">{e.advance_given ? inr(e.advance_given) : ""}</td>
                  <td className="r">{e.advance_deduction ? "− " + inr(e.advance_deduction) : ""}</td>
                  <td className="r">{e.net != null ? <b>{inr(e.net)}</b> : ""}</td>
                  <td className="r">{inr(e.advance_balance)}</td>
                </tr>
              ))}
              {!L.entries.length && <tr><td colSpan="7" className="muted pad">No salary or advances yet.</td></tr>}
            </tbody>
          </table>
          {L.advances.advances.length > 0 && <>
            <h4>Advances</h4>
            <table className="grid-table">
              <thead><tr><th>Date</th><th className="r">Amount</th><th>Plan</th><th className="r">Recovered</th><th className="r">Balance</th><th>Note</th></tr></thead>
              <tbody>{L.advances.advances.map((a) => (
                <tr key={a.id}><td>{fmtDate(a.date)}</td><td className="r">{inr(a.amount)}</td><td>{PLAN_TEXT(a)}</td><td className="r">{inr(a.recovered)}</td><td className="r"><b>{inr(a.remaining)}</b></td><td>{a.note}</td></tr>
              ))}</tbody>
            </table>
          </>}
          {L.slips.length > 0 && <>
            <h4>Salary slips</h4>
            <table className="grid-table">
              <thead><tr><th>Month</th><th className="r">Monthly salary</th><th className="r">Days</th><th className="r">Daily rate</th><th className="r">Gross</th><th className="r">Deduction</th><th className="r">Net</th><th>WhatsApp</th></tr></thead>
              <tbody>{[...L.slips].reverse().map((s) => (
                <tr key={s.id}><td>{monthLabel(s.month)}</td><td className="r">{inr(s.monthly_salary)}</td><td className="r">{s.days_worked}</td>
                  <td className="r">{s.daily_rate != null ? inr(s.daily_rate) : "Fixed"}</td><td className="r">{inr(s.gross)}</td>
                  <td className="r">{s.advance_deduction ? "− " + inr(s.advance_deduction) : "—"}</td><td className="r"><b>{inr(s.net)}</b></td><td><WaBadge status={s.wa_status} /></td></tr>
              ))}</tbody>
            </table>
          </>}
        </div>
      )}
      {adv && <AdvanceForm fixedEmployee={emp.id} onClose={() => setAdv(false)} onSaved={() => { setAdv(false); load(); }} />}
    </Modal>
  );
}

export default function Employees() {
  const [list, setList] = useState([]);
  const [edit, setEdit] = useState(null);
  const [salary, setSalary] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const load = () => api("/employees").then(setList).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  useLiveSync(load);
  const del = async (emp) => {
    if (!window.confirm(`Delete ${emp.name} and all their attendance and advances?`)) return;
    try { await api(`/employees/${emp.id}`, { method: "DELETE" }); load(); } catch (x) { setErr(x.message); }
  };
  const shown = list.filter((e) => (e.name + e.code + e.phone + e.designation).toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div className="toolbar">
        <input placeholder="Search employees…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn primary" onClick={() => setEdit({ ...blankEmp })}>+ Add employee</button>
      </div>
      {err && <div className="error" onClick={() => setErr("")}>{err}</div>}
      <div className="card flush scroll">
        <table className="grid-table cards">
          <thead><tr><th>Code</th><th>Name</th><th>Designation</th><th>WhatsApp</th><th>Salary type</th><th className="r">Monthly salary</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.id} className={e.active ? "" : "inactive"}>
                <td data-label="Code" className="hide-empty">{e.code}</td><td className="card-title"><b>{e.name}</b></td><td data-label="Designation">{e.designation}</td><td data-label="WhatsApp">{e.phone || <span className="muted">—</span>}</td>
                <td data-label="Salary type"><span className={"tag " + e.salary_type}>{e.salary_type === "fixed" ? "Fixed monthly" : "Per day"}</span></td>
                <td data-label="Monthly salary" className="r">{inr(e.monthly_salary)}</td>
                <td data-label="Status">{e.active ? "Active" : "Inactive"}</td>
                <td className="r nowrap card-actions">
                  <button className="btn sm" onClick={() => setLedger(e)}>Ledger</button>{" "}
                  <button className="btn sm" onClick={() => setSalary(e)}>Change salary</button>{" "}
                  <button className="btn sm" onClick={() => setEdit({ ...blankEmp, ...e })}>Edit</button>{" "}
                  <button className="btn sm danger" onClick={() => del(e)}>Delete</button>
                </td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan="8" className="muted pad">No employees yet. Click “Add employee”.</td></tr>}
          </tbody>
        </table>
      </div>
      {edit && <EmployeeForm initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
      {salary && <SalaryChange emp={salary} onClose={() => setSalary(null)} onSaved={() => { setSalary(null); load(); }} />}
      {ledger && <Ledger emp={ledger} onClose={() => { setLedger(null); load(); }} />}
    </div>
  );
}

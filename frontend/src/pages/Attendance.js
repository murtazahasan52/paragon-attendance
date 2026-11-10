import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtDate, todayISO, useLiveSync } from "../api";
import { Modal } from "../components";

const LABEL = { P: "Present", H: "Half day", A: "Absent" };

export default function Attendance({ month, isAdmin = true }) {
  const [emps, setEmps] = useState([]);
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState(null); // { emp, day } for the popup
  const monthRef = useRef(month); monthRef.current = month;
  const seq = useRef(0);
  const saving = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const [e, a] = await Promise.all([api("/employees"), api(`/attendance?month=${month}`)]);
      if (my !== seq.current || month !== monthRef.current || saving.current > 0) return;
      setEmps(e.filter((x) => x.active || a.records[x.id]));
      setData(a);
    } catch (x) { if (my === seq.current) setErr(x.message); }
  }, [month]);
  const loadRef = useRef(load); loadRef.current = load; // always reload the date/month on screen now
  useEffect(() => { load(); }, [load]);
  useLiveSync(load);

  const open = (emp, day) => {
    const future = day.date > todayISO();
    if (future && !(isAdmin && data.records[emp.id]?.[day.date])) return; // future dates can't be marked
    if (data.locked.includes(emp.id)) { setErr("Salary slip already generated for this employee and month. Cancel the slip to edit."); return; }
    if (!isAdmin && data.records[emp.id]?.[day.date]) { setErr("Already marked. Only the admin can change it."); return; }
    setPick({ emp, day });
  };
  const setStatus = async (empId, date, next) => {
    setPick(null);
    setData((d) => {
      const rec = { ...(d.records[empId] || {}) };
      if (next) rec[date] = next; else delete rec[date];
      return { ...d, records: { ...d.records, [empId]: rec } };
    });
    saving.current += 1;
    try { await api("/attendance", { method: "PUT", body: { employee_id: empId, date, status: next } }); }
    catch (x) { setErr(x.message); }
    saving.current -= 1;
    if (saving.current === 0) loadRef.current();
  };
  const markDay = async (date) => {
    await api("/attendance/bulk", { method: "POST", body: { month, date, status: "P", only_empty: true } });
    load();
  };

  if (!data) return <div className="muted pad">{err || "Loading…"}</div>;
  const count = (empId) => Object.values(data.records[empId] || {}).reduce((s, v) => s + (v === "P" ? 1 : v === "H" ? 0.5 : 0), 0);

  return (
    <div>
      <div className="toolbar">
        <div className="legend">
          <span className="cell P">P</span> Present <span className="cell H">H</span> Half day <span className="cell A">A</span> Absent
          <span className="cell sun">S</span> Sunday <span className="cell hol">★</span> Paid holiday <span className="lock">🔒</span> Slip generated
        </div>
      </div>
      {err && <div className="error" onClick={() => setErr("")}>{err}</div>}
      <p className="muted small">Click a cell to mark Present, Half day or Absent. Future dates can't be marked.{!isAdmin && " Once a day is marked, only the admin can change it."} Click a date heading to mark everyone present that day.</p>
      <div className="card flush scroll">
        <table className="att">
          <thead>
            <tr>
              <th className="sticky">Employee</th>
              {data.days.map((d) => (
                <th key={d.date} className={(d.sunday ? "sun" : d.holiday ? "hol" : d.date > todayISO() ? "" : "click") + (d.date > todayISO() ? " future" : "")}
                    title={d.holiday || (d.sunday ? "Sunday" : d.date > todayISO() ? "Future date" : "Mark everyone present")}
                    onClick={() => !d.sunday && !d.holiday && d.date <= todayISO() && markDay(d.date)}>
                  <div>{d.day}</div><div className="wd">{d.weekday.slice(0, 2)}</div>
                </th>
              ))}
              <th>Marked</th>
            </tr>
          </thead>
          <tbody>
            {emps.map((e) => {
              const locked = data.locked.includes(e.id);
              return (
                <tr key={e.id} className={locked ? "locked" : ""}>
                  <td className="sticky name">{locked && "🔒 "}{e.name}{e.salary_type === "fixed" && <span className="tag fixed mini">Fixed</span>}</td>
                  {data.days.map((d) => {
                    const s = data.records[e.id]?.[d.date] || "";
                    const cls = s || (d.sunday ? "sun" : d.holiday ? "hol" : "");
                    return <td key={d.date} className={"cell " + cls + (d.date > todayISO() ? " future" : "")} onClick={() => open(e, d)}>{s || (d.sunday ? "S" : d.holiday ? "★" : "")}</td>;
                  })}
                  <td className="r"><b>{count(e.id)}</b></td>
                </tr>
              );
            })}
            {!emps.length && <tr><td colSpan="40" className="muted pad">Add employees first.</td></tr>}
          </tbody>
        </table>
      </div>
      {pick && (() => {
        const cur = data.records[pick.emp.id]?.[pick.day.date] || "";
        return (
          <Modal title={pick.emp.name} onClose={() => setPick(null)}>
            <div className="muted small">
              {fmtDate(pick.day.date)} · {pick.day.weekday}{pick.day.sunday ? " (Sunday)" : ""}{pick.day.holiday ? ` (${pick.day.holiday})` : ""}
              {cur && <> · now <b>{LABEL[cur]}</b></>}
            </div>
            <div className="mark-pick">
              {pick.day.date <= todayISO() && ["P", "H", "A"].map((k) => (
                <button key={k} className={"mp " + k + (cur === k ? " on" : "")} onClick={() => setStatus(pick.emp.id, pick.day.date, k)}>
                  <span className="mp-key">{k}</span>{LABEL[k]}
                </button>
              ))}
            </div>
            {!isAdmin && <div className="muted small mt">Once saved, only the admin can change it.</div>}
            {cur && isAdmin && <button className="btn block mt" onClick={() => setStatus(pick.emp.id, pick.day.date, "")}>Clear this day</button>}
          </Modal>
        );
      })()}
    </div>
  );
}

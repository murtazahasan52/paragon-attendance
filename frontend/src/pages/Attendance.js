import React, { useCallback, useEffect, useState } from "react";
import { api, monthLabel } from "../api";

const NEXT = { "": "P", P: "H", H: "A", A: "" };

export default function Attendance({ month, isAdmin = true }) {
  const [emps, setEmps] = useState([]);
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    try {
      const [e, a] = await Promise.all([api("/employees"), api(`/attendance?month=${month}`)]);
      setEmps(e.filter((x) => x.active || a.records[x.id] || a.overrides[x.id] != null));
      setData(a);
    } catch (x) { setErr(x.message); }
  }, [month]);
  useEffect(() => { load(); }, [load]);

  const cycle = async (empId, date) => {
    if (data.locked.includes(empId)) { setErr("Salary slip already generated for this employee and month. Cancel the slip to edit."); return; }
    const cur = data.records[empId]?.[date] || "";
    const next = NEXT[cur];
    setData((d) => {
      const rec = { ...(d.records[empId] || {}) };
      if (next) rec[date] = next; else delete rec[date];
      return { ...d, records: { ...d.records, [empId]: rec } };
    });
    try { await api("/attendance", { method: "PUT", body: { employee_id: empId, date, status: next } }); }
    catch (x) { setErr(x.message); load(); }
  };
  const fill = async (empIds, status, onlyEmpty = true) => {
    await api("/attendance/bulk", { method: "POST", body: { month, status, employee_ids: empIds, only_empty: onlyEmpty } });
    load();
  };
  const markDay = async (date) => {
    await api("/attendance/bulk", { method: "POST", body: { month, date, status: "P", only_empty: true } });
    load();
  };
  const setOverride = async (empId, val) => {
    try {
      await api("/attendance/override", { method: "PUT", body: { employee_id: empId, month, days: val === "" ? null : Number(val) } });
    } catch (x) { setErr(x.message); }
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
        {isAdmin && <div className="row-inline">
          <button className="btn" onClick={() => fill([], "P")}>Mark blank working days Present</button>
          <button className="btn danger" onClick={() => window.confirm(`Clear ALL attendance for ${monthLabel(month)}?`) && fill([], "", false)}>Clear month</button>
        </div>}
      </div>
      {err && <div className="error" onClick={() => setErr("")}>{err}</div>}
      <p className="muted small">Click a cell to change it: blank → P → H → A → blank. Click a date heading to mark everyone present that day. {isAdmin && "“Days override” lets you type days worked directly (for example 26); it takes priority over the marked days."}</p>
      <div className="card flush scroll">
        <table className="att">
          <thead>
            <tr>
              <th className="sticky">Employee</th>
              {data.days.map((d) => (
                <th key={d.date} className={d.sunday ? "sun" : d.holiday ? "hol" : "click"} title={d.holiday || (d.sunday ? "Sunday" : "Mark everyone present")}
                    onClick={() => !d.sunday && !d.holiday && markDay(d.date)}>
                  <div>{d.day}</div><div className="wd">{d.weekday.slice(0, 2)}</div>
                </th>
              ))}
              <th>Marked</th>{isAdmin && <><th>Days override</th><th></th></>}
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
                    return <td key={d.date} className={"cell " + cls} onClick={() => cycle(e.id, d.date)}>{s || (d.sunday ? "S" : d.holiday ? "★" : "")}</td>;
                  })}
                  <td className="r"><b>{count(e.id)}</b></td>
                  {isAdmin && <><td>
                    <input className="ovr" type="number" step="0.5" min="0" max="31" placeholder="—" disabled={locked}
                           defaultValue={data.overrides[e.id] ?? ""} key={month + e.id + (data.overrides[e.id] ?? "")}
                           onBlur={(ev) => ev.target.value !== String(data.overrides[e.id] ?? "") && setOverride(e.id, ev.target.value)} />
                  </td>
                  <td>{!locked && <button className="btn sm" onClick={() => fill([e.id], "P")}>Fill P</button>}</td></>}
                </tr>
              );
            })}
            {!emps.length && <tr><td colSpan="40" className="muted pad">Add employees first.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

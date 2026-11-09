import React, { useEffect, useMemo, useState } from "react";
import { api, inr } from "../api";

export default function Holidays({ year }) {
  const [s, setS] = useState(null);
  const [calc, setCalc] = useState(null);
  const [msg, setMsg] = useState("");
  const [nd, setNd] = useState("");
  const [nn, setNn] = useState("");
  const [sal, setSal] = useState(15000);
  const [days, setDays] = useState(26);
  useEffect(() => { api(`/settings/${year}`).then((r) => { setS(r.settings); setCalc(r.calc); }); }, [year]);
  const save = async () => {
    try { const r = await api(`/settings/${year}`, { method: "PUT", body: s }); setS(r.settings); setCalc(r.calc); setMsg("Saved ✓"); }
    catch (x) { setMsg(x.message); }
    setTimeout(() => setMsg(""), 2500);
  };
  const add = () => {
    if (!nd.startsWith(String(year))) { setMsg(`Pick a date in ${year}`); return; }
    setS({ ...s, holidays: [...s.holidays.filter((h) => h.date !== nd), { date: nd, name: nn }].sort((a, b) => a.date.localeCompare(b.date)) });
    setNd(""); setNn("");
  };
  const onSunday = useMemo(() => (s ? s.holidays.filter((h) => new Date(h.date + "T00:00").getDay() === 0) : []), [s]);
  if (!s || !calc) return <div className="muted pad">Loading…</div>;
  const x2 = sal * 12;
  const x3 = calc.working_days > 0 ? x2 / calc.working_days : 0;
  return (
    <div className="two-col">
      <div>
        <div className="card">
          <h3>Year {year}</h3>
          <label>Paid holidays in year (used in the formula)<input type="number" min="0" value={s.paid_holidays} onChange={(e) => setS({ ...s, paid_holidays: +e.target.value })} /></label>
          <table className="formula">
            <tbody>
              <tr><td>Days in year</td><td>{calc.days_in_year}</td></tr>
              <tr><td>Sundays (counted from the calendar)</td><td>{calc.sundays}</td></tr>
              <tr><td>Paid holidays</td><td>{calc.paid_holidays}</td></tr>
              <tr className="total"><td>Working days (x1)</td><td>{calc.working_days}</td></tr>
            </tbody>
          </table>
          <div className="actions"><span className="muted">{msg}</span><button className="btn primary" onClick={save}>Save</button></div>
        </div>
        <div className="card">
          <h3>Salary calculator</h3>
          <div className="row">
            <label>Monthly salary<input type="number" value={sal} onChange={(e) => setSal(+e.target.value)} /></label>
            <label>Days worked<input type="number" step="0.5" value={days} onChange={(e) => setDays(+e.target.value)} /></label>
          </div>
          <table className="formula">
            <tbody>
              <tr><td>x1 Working days</td><td>{calc.days_in_year} − {calc.sundays} − {calc.paid_holidays}</td><td>{calc.working_days}</td></tr>
              <tr><td>x2 Yearly salary</td><td>{inr(sal)} × 12</td><td>{inr(x2)}</td></tr>
              <tr><td>x3 Daily salary</td><td>{inr(x2)} ÷ {calc.working_days}</td><td>{inr(+x3.toFixed(2))}</td></tr>
              <tr className="total"><td>x4 Month salary</td><td>{days} × {inr(+x3.toFixed(2))}</td><td>{inr(Math.round(days * x3))}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <h3>Holiday dates ({s.holidays.length})</h3>
        <p className="muted small">These dates show as ★ on the attendance sheet. The formula uses the “Paid holidays” number.</p>
        {s.holidays.length > 0 && s.holidays.length !== s.paid_holidays && <div className="warn">{s.holidays.length} dates are listed, but “Paid holidays” is set to {s.paid_holidays}.</div>}
        {onSunday.length > 0 && <div className="warn">{onSunday.length} holiday(s) fall on a Sunday: {onSunday.map((h) => h.name || h.date).join(", ")}.</div>}
        <div className="row">
          <input type="date" value={nd} onChange={(e) => setNd(e.target.value)} />
          <input placeholder="Holiday name" value={nn} onChange={(e) => setNn(e.target.value)} />
          <button className="btn" onClick={add}>Add</button>
        </div>
        <table className="grid-table">
          <tbody>
            {s.holidays.map((h) => (
              <tr key={h.date}>
                <td>{new Date(h.date + "T00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", weekday: "short" })}</td>
                <td>{h.name}</td>
                <td className="r"><button className="btn sm danger" onClick={() => setS({ ...s, holidays: s.holidays.filter((x) => x.date !== h.date) })}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="actions"><button className="btn primary" onClick={save}>Save holidays</button></div>
      </div>
    </div>
  );
}

import React, { useCallback, useEffect, useState } from "react";
import { api, inr, monthLabel, fmtDate, downloadFile, printPage, useLiveSync } from "../api";
import { SlipView, WaBadge } from "../components";

export default function Salary({ month }) {
  const [p, setP] = useState(null);
  const [slip, setSlip] = useState(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [send, setSend] = useState(true);

  const load = useCallback(() => api(`/payroll?month=${month}`).then(setP).catch((e) => setErr(e.message)), [month]);
  useEffect(() => { setP(null); setSlip(null); load(); }, [load]);
  useLiveSync(load);
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(""), 4000); };

  const saveDeduction = async (row, val) => {
    setErr("");
    const v = val === "" ? null : Number(val);
    if (v != null && (v < 0 || v > row.advance_outstanding || v > row.gross)) {
      setErr(`${row.name}: deduction must be between 0 and ${inr(Math.min(row.advance_outstanding, row.gross))}`);
      load();
      return;
    }
    await api("/payroll/draft", { method: "PUT", body: { month, employee_id: row.employee_id, advance_deduction: v } });
    load();
  };
  const generate = async (ids) => {
    const n = ids.length || p.rows.filter((r) => !r.generated).length;
    if (!window.confirm(`Generate ${n} salary slip(s) for ${monthLabel(month)}${send ? " and send them on WhatsApp" : ""}?\nAttendance for these employees will be locked for this month.`)) return;
    setBusy(true); setErr("");
    try {
      const r = await api("/payroll/generate", { method: "POST", body: { month, employee_ids: ids, send_whatsapp: send } });
      flash(`${r.created} slip(s) generated${send ? ". WhatsApp messages are being sent." : "."}`);
      if (r.errors.length) setErr(r.errors.join(" | "));
      setTimeout(load, 2500);
      load();
    } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  const cancel = async (row) => {
    if (!window.confirm(`Cancel ${row.name}'s slip for ${monthLabel(month)}? Attendance unlocks and the slip can be generated again.`)) return;
    try { await api(`/slips/${row.id}`, { method: "DELETE" }); setSlip(null); load(); } catch (x) { setErr(x.message); }
  };
  const resend = async (row) => {
    try { const r = await api(`/slips/${row.id}/send`, { method: "POST" }); flash(`WhatsApp: ${r.status}${r.status !== "sent" ? " (" + r.response + ")" : ""}`); load(); }
    catch (x) { setErr(x.message); }
  };
  const csv = () => {
    const head = ["Code", "Name", "Type", "Monthly salary", "Present", "Half days", "Absent", "Days worked", "Daily rate", "Gross", "Advance deduction", "Net", "Status"];
    const lines = p.rows.map((r) => [r.code, r.name, r.salary_type === "fixed" ? "Fixed" : "Per day", r.monthly_salary, r.present, r.half_days, r.absent,
      r.days_worked, r.daily_rate ?? "", r.gross, r.advance_deduction, r.net, r.generated ? "Generated" : "Draft"]);
    lines.push(["", "TOTAL", "", "", "", "", "", "", "", p.total_gross, p.total_deduction, p.total_net, ""]);
    const text = [head, ...lines].map((l) => l.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    downloadFile(`Paragon-Salary-${month}.csv`, "text/csv", text);
  };

  if (!p) return <div className="muted pad">{err || "Loading…"}</div>;
  if (slip) {
    const row = p.rows.find((r) => r.employee_id === slip) || {};
    return (
      <SlipView row={row} calc={p.calc} company={p.company_name} month={month} onBack={() => setSlip(null)}
        actions={row.generated ? <>
          <button className="btn" onClick={() => resend(row)}>Send on WhatsApp again</button>{" "}
          <button className="btn danger" onClick={() => cancel(row)}>Cancel slip</button>
        </> : <button className="btn" onClick={() => generate([row.employee_id])}>Generate this slip</button>} />
    );
  }
  const pending = p.rows.filter((r) => !r.generated);
  return (
    <div>
      <div className="info-bar no-print">
        Salary month: <b>1 to {new Date(+month.slice(0, 4), +month.slice(5), 0).getDate()} {monthLabel(month)}</b> · Salary day: <b>{fmtDate(p.salary_date)}</b>.
        {" "}Check the advance deductions below, then click <b>Generate</b> to finalise. Each employee gets their slip on WhatsApp only then.
        {" "}Working days in {p.calc.year}: <b>{p.calc.working_days}</b> ({p.calc.days_in_year} − {p.calc.sundays} Sundays − {p.calc.paid_holidays} holidays).
      </div>
      <div className="toolbar no-print">
        <label className="check inline"><input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} /> Send slip to employee on WhatsApp</label>
        <div className="row-inline">
          <button className="btn" onClick={csv}>Export Excel (CSV)</button>
          <button className="btn" onClick={() => printPage(`Salary sheet ${monthLabel(month)}`)}>Print sheet</button>
          <button className="btn primary" disabled={busy || !pending.length} onClick={() => generate([])}>
            {busy ? "Generating…" : `Generate ${pending.length} slip(s)`}
          </button>
        </div>
      </div>
      {msg && <div className="okmsg">{msg}</div>}
      {err && <div className="error" onClick={() => setErr("")}>{err}</div>}
      <div className="card flush scroll print-area">
        <div className="print-only print-head">{p.company_name}: Salary sheet, {monthLabel(month)}</div>
        <table className="grid-table cards">
          <thead>
            <tr><th>Name</th><th>Type</th><th className="r">Monthly</th><th className="r">P / H / A</th><th className="r">Days</th><th className="r">Daily rate</th>
              <th className="r">Gross</th><th className="r">Advance due</th><th className="r">Advance deduction</th><th className="r">Net pay</th><th>Status</th><th className="no-print"></th></tr>
          </thead>
          <tbody>
            {p.rows.map((r) => (
              <tr key={r.employee_id} className={r.generated ? "done" : ""}>
                <td className="card-title"><b>{r.name}</b>{r.code && <div className="muted small">{r.code}</div>}</td>
                <td data-label="Type"><span className={"tag " + r.salary_type}>{r.salary_type === "fixed" ? "Fixed" : "Per day"}</span></td>
                <td data-label="Monthly" className="r">{inr(r.monthly_salary)}</td>
                <td data-label="P / H / A" className="r nowrap">{r.present} / {r.half_days} / {r.absent}</td>
                <td data-label="Days worked" className="r">{r.days_worked}{r.override != null && <span className="tag mini" title="Entered manually">M</span>}</td>
                <td data-label="Daily rate" className="r">{r.daily_rate != null ? inr(r.daily_rate) : "—"}</td>
                <td data-label="Gross" className="r">{inr(r.gross)}</td>
                <td data-label="Advance due" className="r">{r.advance_outstanding ? inr(r.advance_outstanding) : "—"}</td>
                <td data-label="Advance deduction" className="r">
                  {r.generated || !r.advance_outstanding ? (r.advance_deduction ? "− " + inr(r.advance_deduction) : "—") : (
                    <input className="ded no-print-input" type="number" min="0" step="1"
                      defaultValue={r.advance_deduction} key={month + r.employee_id + r.advance_deduction}
                      title={`Suggested by plan: ${inr(r.suggested_deduction)}`}
                      onBlur={(e) => Number(e.target.value) !== r.advance_deduction && saveDeduction(r, e.target.value)} />
                  )}
                </td>
                <td data-label="Net pay" className="r net-cell"><b>{inr(r.net)}</b></td>
                <td data-label="Status">{r.generated ? <><span className="tag ok">Generated</span> <WaBadge status={r.wa_status} /></> : <span className="tag muted-tag">Draft</span>}</td>
                <td className="r nowrap no-print card-actions">
                  <button className="btn sm" onClick={() => setSlip(r.employee_id)}>{r.generated ? "Slip" : "Preview"}</button>
                </td>
              </tr>
            ))}
            {!p.rows.length && <tr><td colSpan="12" className="muted pad">No employees.</td></tr>}
          </tbody>
          <tfoot>
            <tr className="mobile-total"><td colSpan="12"><b>Total net pay: {inr(p.total_net)}</b> <span className="muted">(gross {inr(p.total_gross)}, advance − {inr(p.total_deduction)})</span></td></tr>
            <tr className="desk-total"><td colSpan="6" className="r"><b>Total</b></td><td className="r"><b>{inr(p.total_gross)}</b></td><td></td>
              <td className="r">− {inr(p.total_deduction)}</td><td className="r"><b>{inr(p.total_net)}</b></td><td></td><td className="no-print"></td></tr>
          </tfoot>
        </table>
      </div>
      <p className="muted small no-print">Advance deduction starts at the amount from the advance plan. Change it for this month before generating; it saves when you leave the box.</p>
    </div>
  );
}

import React from "react";
import { inr, monthLabel, printPage } from "./api";

export const Stat = ({ label, value, accent, tone }) => (
  <div className={"stat" + (accent ? " accent" : "") + (tone ? " " + tone : "")}>
    <div className="v">{value}</div>
    <div className="l">{label}</div>
  </div>
);

export function Modal({ title, onClose, children, wide }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className={"card modal" + (wide ? " wide" : "")} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn sm" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const WaBadge = ({ status }) => {
  if (!status) return null;
  const cls = status === "sent" ? "ok" : status === "failed" ? "bad" : "muted-tag";
  const label = status === "sent" ? "WhatsApp sent" : status === "failed" ? "WhatsApp failed" : status;
  return <span className={"tag " + cls}>{label}</span>;
};

/* Salary slip, works for both a generated slip and a preview row */
export function SlipView({ row, calc, company, month, onBack, actions }) {
  const fixed = row.salary_type === "fixed";
  const c = row.calc || calc;
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return (
    <div>
      <div className="toolbar no-print">
        <button className="btn" onClick={onBack}>← Back</button>
        <div>
          {actions}{" "}
          <button className="btn primary" onClick={() => printPage(`Salary slip ${row.name} ${monthLabel(month)}`)}>Print / Save PDF</button>
        </div>
      </div>
      <div className="card slip print-area">
        <div className="slip-head">
          <div className="brand big">{(company || "Paragon").toUpperCase()}</div>
          <div>Salary slip, {monthLabel(month)}</div>
          <div className="muted small">Period: 01/{String(m).padStart(2, "0")}/{y} to {last}/{String(m).padStart(2, "0")}/{y}
            {!row.generated && <b className="draft-mark"> · DRAFT (not generated yet)</b>}</div>
        </div>
        <table className="kv">
          <tbody>
            <tr><td>Employee</td><td><b>{row.name}</b></td><td>Code</td><td>{row.code || "—"}</td></tr>
            <tr><td>Designation</td><td>{row.designation || "—"}</td><td>Phone</td><td>{row.phone || "—"}</td></tr>
            <tr><td>Salary type</td><td>{fixed ? "Fixed monthly" : "Per day"}</td><td>Monthly salary</td><td>{inr(row.monthly_salary)}</td></tr>
          </tbody>
        </table>
        <table className="kv">
          <tbody>
            <tr><td>Present</td><td>{row.present}</td><td>Half days</td><td>{row.half_days}</td></tr>
            <tr><td>Absent</td><td>{row.absent}</td><td>Days worked</td><td><b>{row.days_worked}</b>{row.override != null && " (entered manually)"}</td></tr>
          </tbody>
        </table>
        <table className="formula">
          <tbody>
            {!fixed && <>
              <tr><td>Working days in {c.year}</td><td>{c.days_in_year} − {c.sundays} Sundays − {c.paid_holidays} holidays</td><td>{c.working_days}</td></tr>
              <tr><td>Daily salary</td><td>{inr(row.monthly_salary)} × 12 ÷ {c.working_days}</td><td>{inr(row.daily_rate)}</td></tr>
              <tr><td>Gross salary</td><td>{row.days_worked} days × {inr(row.daily_rate)}</td><td>{inr(row.gross)}</td></tr>
            </>}
            {fixed && <tr><td>Gross salary</td><td>Fixed monthly salary</td><td>{inr(row.gross)}</td></tr>}
            <tr><td>Less: advance deduction</td><td>Advance outstanding before this slip: {inr(row.advance_outstanding)}</td><td>− {inr(row.advance_deduction)}</td></tr>
          </tbody>
        </table>
        <div className="net">Net salary payable: <b>{inr(row.net)}</b></div>
        <div className="muted small r">Advance balance after this slip: {inr(row.advance_balance_after ?? (row.advance_outstanding - row.advance_deduction))}</div>
        <div className="sign"><div>Employee signature</div><div>Authorised signatory</div></div>
      </div>
    </div>
  );
}

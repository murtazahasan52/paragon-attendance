import React, { useEffect, useState } from "react";
import { api } from "../api";

export const TEMPLATES = [
  {
    key: "tpl_attendance", title: "1. Attendance message (to employee)", vars: 4,
    text: `Dear {{1}},
Your attendance for {{2}} has been marked as *{{3}}*.
- {{4}}
This is an automated message.`,
    sample: ["Ravi Kumar", "09 Nov 2026 (Mon)", "Present", "Paragon"],
  },
  {
    key: "tpl_salary", title: "2. Salary slip (to employee, on salary day)", vars: 14,
    text: `Dear {{1}},
Your salary slip for *{{2}}*:

Monthly salary: {{3}}
Working days in year: {{4}}
Daily salary: {{5}}
Days worked: {{6}} (Present {{7}}, Half day {{8}}, Absent {{9}})
Gross salary: {{10}}
Advance deducted: {{11}}
*Net salary: {{12}}*
Advance balance: {{13}}

- {{14}}
Please contact the office for any query.`,
    sample: ["Ravi Kumar", "October 2026", "Rs. 15,000", "365 - 52 Sundays - 24 holidays = 289 days", "Rs. 622.84", "26", "26", "0", "0", "Rs. 16,194", "Rs. 2,000", "Rs. 14,194", "Rs. 8,000", "Paragon"],
  },
  {
    key: "tpl_summary", title: "3. Daily attendance summary (to admin)", vars: 8,
    text: `Attendance summary for {{1}}

Total employees: {{2}}
Present: {{3}}
Half day: {{4}}
Absent: {{5}}
Not marked: {{6}}

Absent: {{7}}
- {{8}}
This is an automated daily report.`,
    sample: ["09 Nov 2026 (Mon)", "12", "10", "1", "1", "0", "Sunil", "Paragon"],
  },
];

export default function WhatsApp() {
  const [s, setS] = useState(null);
  const [logs, setLogs] = useState([]);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [testNo, setTestNo] = useState("");
  const load = () => {
    api("/app-settings").then(setS).catch((e) => setErr(e.message));
    api("/whatsapp/logs?limit=100").then(setLogs);
  };
  useEffect(() => { load(); }, []);
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(""), 4000); };
  const save = async (e) => {
    e.preventDefault(); setErr("");
    try { setS(await api("/app-settings", { method: "PUT", body: { ...s, salary_day: Number(s.salary_day) } })); flash("Settings saved ✓"); }
    catch (x) { setErr(x.message); }
  };
  const test = async () => {
    try { const r = await api("/whatsapp/test", { method: "POST", body: { phone: testNo } }); flash(`Test: ${r.status} ${r.status !== "sent" ? "(" + r.response + ")" : ""}`); load(); }
    catch (x) { setErr(x.message); }
  };
  const copy = (t) => { navigator.clipboard?.writeText(t); flash("Template text copied"); };
  if (!s) return <div className="muted pad">{err || "Loading…"}</div>;
  const set = (k) => (e) => setS({ ...s, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  return (
    <div>
      {msg && <div className="okmsg">{msg}</div>}
      {err && <div className="error" onClick={() => setErr("")}>{err}</div>}
      <form className="two-col" onSubmit={save}>
        <div className="card">
          <h3>WhatsApp connection</h3>
          <label>Company name (used in messages and slips)<input value={s.company_name} onChange={set("company_name")} /></label>
          <label>Send messages through
            <select value={s.wa_provider} onChange={set("wa_provider")}>
              <option value="interakt">Interakt</option>
              <option value="bhashsms">BhashSMS</option>
            </select>
          </label>
          {s.wa_provider === "bhashsms" ? <>
            <label>BhashSMS API URL<input value={s.bhash_url} onChange={set("bhash_url")} /></label>
            <div className="row">
              <label>User<input value={s.bhash_user} onChange={set("bhash_user")} autoComplete="off" /></label>
              <label>Password {s.has_bhash_pass && <span className="ok-text">✓ saved</span>}
                <input type="password" value={s.bhash_pass} onChange={set("bhash_pass")} autoComplete="new-password" placeholder="BhashSMS password" />
              </label>
            </div>
            <div className="row">
              <label>Sender<input value={s.bhash_sender} onChange={set("bhash_sender")} /></label>
              <label>Priority<input value={s.bhash_priority} onChange={set("bhash_priority")} /></label>
              <label>Type (stype)<input value={s.bhash_stype} onChange={set("bhash_stype")} /></label>
            </div>
            <label>Country code<input value={s.country_code} onChange={set("country_code")} /></label>
            <p className="muted small">Each message is sent as the template name below with its values in <code>Params</code>, separated by commas (commas inside amounts are removed, e.g. 15,000 → 15000). The phone number is sent as 10 digits.</p>
          </> : <>
            <label>Interakt API key {s.has_api_key && <span className="ok-text">✓ saved</span>}
              <input value={s.interakt_api_key} onChange={set("interakt_api_key")} placeholder="Interakt → Settings → Developer Setting → Secret Key" />
            </label>
            <div className="row">
              <label>Country code<input value={s.country_code} onChange={set("country_code")} /></label>
              <label>Template language code<input value={s.tpl_language} onChange={set("tpl_language")} /></label>
            </div>
          </>}
          <label>Attendance template name<input value={s.tpl_attendance} onChange={set("tpl_attendance")} /></label>
          <label>Salary slip template name<input value={s.tpl_salary} onChange={set("tpl_salary")} /></label>
          <label>Owner summary template name<input value={s.tpl_summary} onChange={set("tpl_summary")} /></label>
          <div className="row">
            <input placeholder="Mobile number for a test message" value={testNo} onChange={(e) => setTestNo(e.target.value)} />
            <button type="button" className="btn" onClick={test} disabled={!testNo}>Send test</button>
          </div>
        </div>
        <div className="card">
          <h3>Messages & schedule</h3>
          <label className="check"><input type="checkbox" checked={s.attendance_msgs} onChange={set("attendance_msgs")} /> Send attendance message to the employee as soon as they are marked</label>
          <label className="check"><input type="checkbox" checked={s.salary_msgs} onChange={set("salary_msgs")} /> Send salary slip to employee when generated</label>
          <label className="check"><input type="checkbox" checked={s.auto_generate} onChange={set("auto_generate")} /> Also generate and send slips automatically on salary day (normally off: the admin generates them)</label>
          <div className="row">
            <label>Salary day (of every month)<input type="number" min="1" max="28" value={s.salary_day} onChange={set("salary_day")} /></label>
            <label>Time on salary day<input type="time" value={s.salary_time} onChange={set("salary_time")} /></label>
          </div>
          <label className="check"><input type="checkbox" checked={s.owner_summary} onChange={set("owner_summary")} /> Send the daily attendance summary to the admin</label>
          <div className="row">
            <label>Admin WhatsApp number(s), comma separated<input value={s.owner_numbers} onChange={set("owner_numbers")} placeholder="98220xxxxx, 98900xxxxx" /></label>
            <label>Daily summary time<input type="time" value={s.summary_time} onChange={set("summary_time")} /></label>
          </div>
          <p className="muted small">All times are India time (IST). On Vercel's free plan the summary goes out once a day between 8 and 9 PM.</p>
          <div className="actions"><button className="btn primary">Save settings</button></div>
        </div>
      </form>

      <div className="card">
        <h3>Templates to create in {s.wa_provider === "bhashsms" ? "BhashSMS" : "Interakt"}</h3>
        {s.wa_provider === "bhashsms" && <p className="muted small">In BhashSMS, create each template below for WhatsApp (category <b>Utility</b>, language <b>English</b>). Once it is approved, enter its exact template name above. Keep the variables in the same order.</p>}
        <p className="muted small" style={s.wa_provider === "bhashsms" ? { display: "none" } : undefined}>In Interakt, go to Templates → Create, choose category <b>Utility</b> and language <b>English</b>, and paste each text below. After WhatsApp approves a template, enter its code name above (the part of the template's URL between <code>/template/</code> and <code>/view</code>). Keep the variables in the same order. WhatsApp does not allow a template to start or end with a variable, which is why each one ends with a fixed line.</p>
        <div className="tpl-grid">
          {TEMPLATES.map((t) => (
            <div key={t.key} className="tpl">
              <div className="tpl-head"><b>{t.title}</b><button type="button" className="btn sm" onClick={() => copy(t.text)}>Copy</button></div>
              <div className="muted small">Code name now: <code>{s[t.key]}</code> · {t.vars} variables</div>
              <pre>{t.text}</pre>
              <div className="muted small">Sample values for approval: {t.sample.map((v, i) => `{{${i + 1}}} ${v}`).join(" · ")}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card flush scroll">
        <div className="toolbar pad-sm"><h3>Message log</h3><button className="btn sm" onClick={load}>Refresh</button></div>
        <table className="grid-table cards">
          <thead><tr><th>Time</th><th>Type</th><th>To</th><th>Status</th><th>Details</th></tr></thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td className="nowrap card-title">{l.at.replace("T", " ").slice(0, 16)}<span className="mobile-only"> · {l.kind}</span></td><td data-label="Type" className="desk-only">{l.kind}</td><td data-label="To">{l.to}</td>
                <td data-label="Status"><span className={"tag " + (l.status === "sent" ? "ok" : l.status === "failed" ? "bad" : "muted-tag")}>{l.status}</span></td>
                <td data-label="Details" className="small">{l.status === "sent" ? l.values.slice(0, 3).join(" · ") : l.response}</td>
              </tr>
            ))}
            {!logs.length && <tr><td colSpan="5" className="muted pad">No messages yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

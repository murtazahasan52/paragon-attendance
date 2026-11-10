import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, todayISO, useLiveSync } from "../api";
import Icon from "../icons";

const STATUS = [
  ["P", "Present"],
  ["H", "Half day"],
  ["A", "Absent"],
];
const FILTERS = [
  ["all", "All"],
  ["none", "Not marked"],
  ["P", "Present"],
  ["H", "Half day"],
  ["A", "Absent"],
];

const shiftDate = (iso, n) => {
  const t = new Date(iso + "T00:00");
  t.setDate(t.getDate() + n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};
const initials = (n) => (n || "?").replace(/\(.*?\)|[^A-Za-z\s]/g, " ").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";

export default function Today({ isAdmin = true }) {
  const [d, setD] = useState(todayISO());
  const [emps, setEmps] = useState([]);
  const [day, setDay] = useState(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const dateRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const [e, a] = await Promise.all([api("/employees"), api(`/attendance/day?d=${d}`)]);
      setEmps(e.filter((x) => x.active));
      setDay(a);
    } catch (x) { setErr(x.message); }
  }, [d]);
  useEffect(() => { setDay(null); load(); }, [load]);
  useLiveSync(load, 4000);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(""), 3500); };
  const mark = async (empId, status) => {
    setErr("");
    const cur = day.records[empId]?.status;
    if (d > todayISO()) { setErr("Attendance can't be marked for a future date."); return; }
    if (!isAdmin && cur) { setErr("Already marked. Only the admin can change it."); return; }
    const next = cur === status ? "" : status;
    // update the screen at once, then save
    setDay((dd) => {
      const records = { ...dd.records };
      if (next) records[empId] = { status: next, notified: false, sending: true }; else delete records[empId];
      return { ...dd, records };
    });
    try {
      await api("/attendance", { method: "PUT", body: { employee_id: empId, date: d, status: next } });
      load(); // shows "Sent" once WhatsApp has accepted the message
    } catch (x) { setErr(x.message); load(); }
  };
  const allPresent = async () => {
    try {
      const r = await api("/attendance/bulk", { method: "POST", body: { date: d, status: "P", only_empty: true } });
      flash(r.changed ? `${r.changed} marked present, WhatsApp messages sent` : "Everyone is already marked");
      load();
    } catch (x) { setErr(x.message); }
  };
  const sendNow = async () => { await api("/notifications/flush", { method: "POST" }); flash("Pending WhatsApp messages sent"); load(); };
  const ownerSummary = async () => {
    try { const r = await api("/summary/send", { method: "POST", body: { date: d } }); flash(`Summary sent to ${r.length} owner number${r.length === 1 ? "" : "s"}`); }
    catch (x) { setErr(x.message); }
  };
  const openPicker = () => { const el = dateRef.current; if (!el) return; try { el.showPicker(); } catch (e) { el.focus(); } };

  if (!day) return <div className="muted pad">{err || "Loading…"}</div>;
  const recs = day.records;
  const n = emps.length;
  const count = { P: 0, H: 0, A: 0 };
  emps.forEach((e) => { const s = recs[e.id]?.status; if (s) count[s] += 1; });
  const unmarked = n - count.P - count.H - count.A;
  const dt = new Date(d + "T00:00");
  const isToday = d === todayISO();
  const isSunday = dt.getDay() === 0;
  const pct = (v) => (n ? (v / n) * 100 : 0);
  const shown = emps.filter((e) => {
    if (q && !(e.name + " " + (e.code || "") + " " + (e.designation || "")).toLowerCase().includes(q.toLowerCase())) return false;
    const s = recs[e.id]?.status;
    if (filter === "none") return !s;
    if (filter === "all") return true;
    return s === filter;
  });
  const pendingCount = day.pending.length; // old queued messages only

  return (
    <div className="today">
      <section className="roll-head">
        <div className="roll-date">
          <button className="icon-btn" onClick={() => setD(shiftDate(d, -1))} aria-label="Previous day"><Icon name="left" /></button>
          <button className="roll-date-main" onClick={openPicker} title="Pick a date">
            <span className="roll-day">{dt.toLocaleDateString("en-IN", { weekday: "long" })}{isToday && <em className="today-chip">Today</em>}</span>
            <span className="roll-num">{dt.toLocaleDateString("en-IN", { day: "numeric", month: "long" })}</span>
          </button>
          <input ref={dateRef} type="date" className="month-hidden" value={d} max={todayISO()} onChange={(e) => e.target.value && setD(e.target.value > todayISO() ? todayISO() : e.target.value)} tabIndex={-1} aria-hidden="true" />
          <button className="icon-btn" onClick={() => setD(shiftDate(d, 1))} aria-label="Next day" disabled={d >= todayISO()}><Icon name="right" /></button>
        </div>

        <div className="roll-progress">
          <div className="roll-figure"><b>{n - unmarked}</b><span>of {n} marked</span></div>
          <div className="roll-bar" role="img" aria-label={`${count.P} present, ${count.H} half day, ${count.A} absent, ${unmarked} not marked`}>
            <i className="seg P" style={{ width: pct(count.P) + "%" }} />
            <i className="seg H" style={{ width: pct(count.H) + "%" }} />
            <i className="seg A" style={{ width: pct(count.A) + "%" }} />
          </div>
          <div className="roll-legend">
            <span><i className="dot P" />{count.P} present</span>
            <span><i className="dot H" />{count.H} half day</span>
            <span><i className="dot A" />{count.A} absent</span>
            <span><i className="dot none" />{unmarked} not marked</span>
          </div>
        </div>
      </section>

      {isSunday && <div className="note-line">This is a Sunday, a paid off day. Mark only the people who came in.</div>}

      <div className="roll-actions">
        <button className="btn primary" onClick={allPresent} disabled={!unmarked}><Icon name="check" size={18} /> Mark the rest present</button>
        {pendingCount > 0 && <button className="btn" onClick={sendNow}><Icon name="whatsapp" size={18} /> Send {pendingCount} waiting message{pendingCount === 1 ? "" : "s"}</button>}
        {isAdmin && <button className="btn" onClick={ownerSummary}><Icon name="whatsapp" size={18} /> Send today's summary to admin</button>}
      </div>
      {msg && <div className="okmsg">{msg}</div>}
      {err && <div className="error" onClick={() => setErr("")}>{err}</div>}

      <div className="roll">
        <div className="roll-tools">
          <div className="chips" role="tablist">
            {FILTERS.map(([k, label]) => (
              <button key={k} role="tab" aria-selected={filter === k} className={"chip" + (filter === k ? " on" : "")} onClick={() => setFilter(k)}>
                {label}<span>{k === "all" ? n : k === "none" ? unmarked : count[k]}</span>
              </button>
            ))}
          </div>
          <input className="roll-search" placeholder="Search name or designation" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ul className="roll-list">
          {shown.map((e) => {
            const r = recs[e.id];
            const st = r?.status || "";
            const pending = day.pending.includes(e.id) || (r && r.sending);
            const fixed = !isAdmin && !!st; // accountant: a marked day can't be changed
            return (
              <li key={e.id} className={"roll-row s-" + (st || "none")}>
                <span className="avatar big">{initials(e.name)}</span>
                <div className="roll-who">
                  <b>{e.name}</b>
                  <span>{e.designation || "Staff"}{!e.phone && <em className="no-phone"> · no WhatsApp number</em>}{fixed && <em className="no-phone"> · 🔒 only admin can change</em>}</span>
                </div>
                <div className="seg-switch" role="radiogroup" aria-label={`Attendance for ${e.name}`}>
                  {STATUS.map(([s, label]) => (
                    <button key={s} role="radio" aria-checked={st === s} className={"opt " + s + (st === s ? " on" : "")} disabled={fixed && st !== s} onClick={() => !fixed && mark(e.id, s)}>{label}</button>
                  ))}
                </div>
                <div className={"roll-wa" + (r && !pending && !r.notified ? " fail" : "")} title={r && r.error ? r.error : pending ? "Sending WhatsApp message" : r?.notified ? "WhatsApp message sent" : ""}>
                  {r && (pending ? <><Icon name="clock" size={16} /> <span>Sending</span></> : r.notified ? <><Icon name="check" size={16} /> <span>Sent</span></> : <span>Not sent</span>)}
                </div>
              </li>
            );
          })}
          {!shown.length && <li className="roll-empty">{n ? "No one matches this filter." : "No employees yet. Add them on the Employees page."}</li>}
        </ul>
        <p className="muted small roll-foot">Each person gets a WhatsApp message as soon as you tap Present, Half day or Absent. {isAdmin ? "Changing it sends the corrected status." : "Once marked, only the admin can change it."}</p>
      </div>
    </div>
  );
}

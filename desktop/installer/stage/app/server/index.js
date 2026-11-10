/*
 * Paragon Attendance & Payroll - Windows / LAN edition server
 * Same /api as the FastAPI backend, with a built-in file database (NeDB)
 * so nothing else (MongoDB, Python) has to be installed.
 *
 * Salary rule: daily rate = monthly x 12 / (days in year - Sundays - paid holidays)
 * Fixed-salary employees always get the full monthly salary.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const Datastore = require("@seald-io/nedb");

// ------------------------------------------------------------ config & data folder
const DATA_DIR = process.env.PARAGON_DATA ||
  (process.platform === "win32" ? path.join(process.env.ProgramData || "C:\\ProgramData", "ParagonAttendance")
    : path.join(os.homedir(), ".paragon-attendance"));
fs.mkdirSync(path.join(DATA_DIR, "db"), { recursive: true });
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
if (!fs.existsSync(CONFIG_FILE)) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    port: 8001, admin_username: "admin", admin_password: "paragon@123",
    secret_key: crypto.randomBytes(32).toString("hex"),
  }, null, 2));
}
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const PORT = Number(process.env.PORT || CONFIG.port || 8001);
const INTERAKT_URL = process.env.INTERAKT_URL || "https://api.interakt.ai/v1/public/message/";
const PUBLIC_DIR = process.env.PARAGON_PUBLIC || path.join(__dirname, "..", "public");
const DEFAULT_PAID_HOLIDAYS = 24;

const logFile = path.join(DATA_DIR, "server.log");
function log(...a) {
  const line = `[${nowIST().iso}] ${a.join(" ")}\n`;
  try { fs.appendFileSync(logFile, line); } catch (e) { /* ignore */ }
  if (process.stdout.isTTY) process.stdout.write(line);
}

// ------------------------------------------------------------ database
const COLLECTIONS = ["settings", "app_settings", "employees", "attendance", "overrides", "notify_queue",
  "advances", "slips", "drafts", "wa_logs", "jobs"];
const db = {};
for (const c of COLLECTIONS) {
  db[c] = new Datastore({ filename: path.join(DATA_DIR, "db", c + ".db"), autoload: true });
  db[c].setAutocompactionInterval(10 * 60 * 1000);
}
const clean = (d) => { if (d) delete d._id; return d; };
const find = async (c, q = {}, sort = null, limit = 0) => {
  let cur = db[c].findAsync(q);
  if (sort) cur = cur.sort(sort);
  if (limit) cur = cur.limit(limit);
  return (await cur).map(clean);
};
const findOne = async (c, q) => clean(await db[c].findOneAsync(q));
const upsert = (c, q, set) => db[c].updateAsync(q, { $set: set }, { upsert: true });
const removeOne = (c, q) => db[c].removeAsync(q, { multi: false });
const removeMany = (c, q) => db[c].removeAsync(q, { multi: true });
const monthRe = (m) => new RegExp("^" + m + "-");

// ------------------------------------------------------------ time (India, UTC+05:30, no DST)
function nowIST() {
  const d = new Date(Date.now() + 330 * 60000);
  const p = (n) => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const hm = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return { date, hm, day: d.getUTCDate(), month: date.slice(0, 7), iso: `${date}T${hm}:${p(d.getUTCSeconds())}+05:30`, ms: Date.now() };
}
const todayIST = () => nowIST().date;
const isoPlus = (sec) => {
  const d = new Date(Date.now() + 330 * 60000 + sec * 1000);
  return d.toISOString().slice(0, 19) + "+05:30";
};

// ------------------------------------------------------------ calendar helpers
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInYear = (y) => (isLeap(y) ? 366 : 365);
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12
const weekday = (iso) => new Date(iso + "T00:00:00Z").getUTCDay(); // 0 = Sunday
function countSundays(y) {
  let n = 0;
  for (let t = Date.UTC(y, 0, 1); t < Date.UTC(y + 1, 0, 1); t += 86400000) if (new Date(t).getUTCDay() === 0) n++;
  return n;
}
function monthDays(month) {
  const [y, m] = month.split("-").map(Number);
  const out = [];
  for (let d = 1; d <= dim(y, m); d++) out.push(`${month}-${String(d).padStart(2, "0")}`);
  return { y, m, days: out };
}
function prevMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_M = MONTHS.map((x) => x.slice(0, 3));
const monthLabel = (month) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const dayLabel = (iso) => `${iso.slice(8, 10)} ${SHORT_M[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)} (${DAYS[weekday(iso)]})`;

function fmtInr(v) {
  v = Number(v || 0);
  const neg = v < 0; v = Math.abs(v);
  const whole = Math.trunc(v);
  const frac = Math.round((v - whole) * 100);
  let s = String(whole);
  if (s.length > 3) {
    const head = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    s = head + "," + s.slice(-3);
  }
  return (neg ? "-" : "") + "Rs. " + s + (frac ? "." + String(frac).padStart(2, "0") : "");
}
const r2 = (x) => Math.round(x * 100) / 100;

const STATUS_VALUE = { P: 1, H: 0.5, A: 0 };
const STATUS_TEXT = { P: "Present", H: "Half Day", A: "Absent" };

// ------------------------------------------------------------ errors / auth
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };

function makeToken(u) {
  const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
  const payload = `${u}|${exp}`;
  return payload + "|" + crypto.createHmac("sha256", CONFIG.secret_key).update(payload).digest("hex");
}
function checkToken(t) {
  const parts = (t || "").split("|");
  if (parts.length !== 3) return false;
  const good = crypto.createHmac("sha256", CONFIG.secret_key).update(parts[0] + "|" + parts[1]).digest("hex");
  return good.length === parts[2].length && crypto.timingSafeEqual(Buffer.from(good), Buffer.from(parts[2])) &&
    Number(parts[1]) > Date.now() / 1000;
}

// ------------------------------------------------------------ settings
async function getYearSettings(year) {
  const s = (await findOne("settings", { year })) || {};
  return { year, holidays: s.holidays || [], paid_holidays: s.paid_holidays ?? DEFAULT_PAID_HOLIDAYS };
}
function yearCalc(s) {
  const total = daysInYear(s.year), sundays = countSundays(s.year);
  const paid = Number(s.paid_holidays ?? DEFAULT_PAID_HOLIDAYS);
  const working = total - sundays - paid;
  return { year: s.year, days_in_year: total, sundays, paid_holidays: paid, total_off_days: sundays + paid,
    working_days: working, avg_working_days_per_month: r2(working / 12) };
}
const dailyRate = (monthly, wd) => (wd > 0 ? (Number(monthly) * 12) / wd : 0);

const APP_DEFAULTS = {
  company_name: "Paragon", interakt_api_key: "", country_code: "+91",
  tpl_attendance: "attendance_update", tpl_salary: "salary_slip", tpl_summary: "attendance_summary", tpl_language: "en",
  attendance_msgs: true, salary_msgs: true, owner_summary: true, owner_numbers: "",
  summary_time: "20:00", salary_day: 5, salary_time: "10:00", auto_generate: true,
};
async function getAppSettings() {
  const s = (await findOne("app_settings", { key: "app" })) || {};
  delete s.key;
  return { ...APP_DEFAULTS, ...s };
}
const mask = (k) => (k ? "•".repeat(8) + k.slice(-4) : "");

// ------------------------------------------------------------ WhatsApp (Interakt)
function splitPhone(phone, cc) {
  let digits = String(phone || "").replace(/\D/g, "");
  const c = String(cc || "91").replace(/\D/g, "");
  if (digits.length > 10 && digits.startsWith(c)) digits = digits.slice(c.length);
  if (digits.length > 10) digits = digits.replace(/^0+/, "");
  return ["+" + c, digits];
}
function waValue(v) {
  let s = String(v === null || v === undefined || v === "" ? "-" : v).replace(/[\r\n\t]+/g, " ");
  s = s.replace(/ {4,}/g, "   ").trim().slice(0, 900);
  return s || "-";
}
async function sendTemplate(phone, template, values, kind, ref = "") {
  const s = await getAppSettings();
  const entry = { id: crypto.randomUUID(), at: nowIST().iso, to: phone, kind, template, ref, values: values.map(waValue) };
  const [cc, num] = splitPhone(phone, s.country_code);
  if (!s.interakt_api_key) Object.assign(entry, { status: "skipped", response: "Interakt API key not set" });
  else if (num.length < 8) Object.assign(entry, { status: "failed", response: "Invalid phone number" });
  else {
    try {
      const r = await fetch(INTERAKT_URL, {
        method: "POST",
        headers: { Authorization: "Basic " + s.interakt_api_key, "Content-Type": "application/json" },
        body: JSON.stringify({ countryCode: cc, phoneNumber: num, callbackData: `${kind}:${ref}`.slice(0, 500), type: "Template",
          template: { name: template, languageCode: s.tpl_language || "en", bodyValues: entry.values } }),
        signal: AbortSignal.timeout(20000),
      });
      const body = (await r.text()).slice(0, 500);
      const ok = r.status < 300 && !body.replace(/\s/g, "").includes('"result":false');
      Object.assign(entry, { status: ok ? "sent" : "failed", response: `${r.status} ${body}` });
    } catch (e) {
      Object.assign(entry, { status: "failed", response: String(e.message || e).slice(0, 500) });
    }
  }
  await db.wa_logs.insertAsync({ ...entry });
  return entry;
}

async function enqueueAttendance(empId, d) {
  const s = await getAppSettings();
  if (!s.attendance_msgs) return;
  const today = todayIST();
  const yesterday = new Date(Date.parse(today + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
  if (d !== today && d !== yesterday) return;
  await upsert("notify_queue", { employee_id: empId, date: d }, { employee_id: empId, date: d, due_at: isoPlus(60) });
}
async function processQueue(force = false) {
  const s = await getAppSettings();
  const items = await find("notify_queue", force ? {} : { due_at: { $lte: nowIST().iso } });
  for (const it of items) {
    await removeOne("notify_queue", { employee_id: it.employee_id, date: it.date });
    const rec = await findOne("attendance", { employee_id: it.employee_id, date: it.date });
    const emp = await findOne("employees", { id: it.employee_id });
    if (!rec || !emp || !emp.phone || rec.notified_status === rec.status) continue;
    const res = await sendTemplate(emp.phone, s.tpl_attendance,
      [emp.name, dayLabel(it.date), STATUS_TEXT[rec.status], s.company_name], "attendance", `${emp.id}:${it.date}`);
    if (res.status === "sent") await upsert("attendance", { employee_id: it.employee_id, date: it.date }, { notified_status: rec.status });
  }
}

async function buildDaySummary(d) {
  const emps = await find("employees", { active: true }, { name: 1 });
  const recs = {};
  for (const r of await find("attendance", { date: d })) recs[r.employee_id] = r.status;
  const ys = await getYearSettings(Number(d.slice(0, 4)));
  const hol = Object.fromEntries(ys.holidays.map((h) => [h.date, h.name || ""]));
  const out = { date: d, total: emps.length, present: [], half: [], absent: [], not_marked: [], sunday: weekday(d) === 0, holiday: hol[d] ?? null };
  for (const e of emps) out[{ P: "present", H: "half", A: "absent" }[recs[e.id]] || "not_marked"].push(e.name);
  return out;
}
async function sendOwnerSummary(d) {
  const s = await getAppSettings();
  const sm = await buildDaySummary(d);
  const numbers = String(s.owner_numbers).split(/[,\n;]/).map((x) => x.trim()).filter(Boolean);
  let absent = sm.absent.join(", ") || "None";
  if (sm.not_marked.length) absent += `. Not marked: ${sm.not_marked.join(", ")}`;
  const vals = [dayLabel(d), sm.total, sm.present.length, sm.half.length, sm.absent.length, sm.not_marked.length, absent, s.company_name];
  const out = [];
  for (const n of numbers) out.push(await sendTemplate(n, s.tpl_summary, vals, "summary", d));
  return out;
}

// ------------------------------------------------------------ salary helpers
function salaryFor(emp, month) {
  const hist = [...(emp.salary_history || [])].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  if (!hist.length) return { monthly_salary: emp.monthly_salary || 0, salary_type: emp.salary_type || "per_day", effective_from: "" };
  let pick = hist[0];
  for (const h of hist) if (h.effective_from <= month) pick = h;
  return pick;
}
async function refreshCurrentSalary(empId) {
  const emp = await findOne("employees", { id: empId });
  const cur = salaryFor(emp, nowIST().month);
  await upsert("employees", { id: empId }, { monthly_salary: cur.monthly_salary, salary_type: cur.salary_type });
}

async function advanceStatus(empId, excludeMonth = null) {
  const advs = await find("advances", { employee_id: empId }, { date: 1, created_at: 1 });
  const q = { employee_id: empId };
  if (excludeMonth) q.month = { $ne: excludeMonth };
  let recovered = 0;
  for (const s of await find("slips", q)) recovered += Number(s.advance_deduction || 0);
  let left = recovered;
  for (const a of advs) {
    const r = Math.min(a.amount, left);
    left -= r;
    a.recovered = r2(r);
    a.remaining = r2(a.amount - r);
  }
  const total = advs.reduce((x, a) => x + a.amount, 0);
  return { advances: advs, total: r2(total), recovered: r2(recovered), outstanding: r2(Math.max(total - recovered, 0)) };
}
function suggestedDeduction(advs, month) {
  let s = 0;
  for (const a of advs) {
    if (a.remaining <= 0 || a.start_month > month) continue;
    if (a.plan === "one_time") s += a.remaining;
    else if (a.plan === "monthly") s += Math.min(a.installment || a.remaining, a.remaining);
  }
  return r2(s);
}

async function computeRow(emp, month, calc, att, override) {
  const sal = salaryFor(emp, month);
  const vals = Object.values(att);
  const present = vals.filter((s) => s === "P").length;
  const half = vals.filter((s) => s === "H").length;
  const absent = vals.filter((s) => s === "A").length;
  const marked = vals.reduce((x, s) => x + (STATUS_VALUE[s] || 0), 0);
  const daysWorked = override !== undefined && override !== null ? Number(override) : marked;
  const rate = dailyRate(sal.monthly_salary, calc.working_days);
  let gross, rateShow;
  if (sal.salary_type === "fixed") { gross = Math.round(Number(sal.monthly_salary)); rateShow = null; }
  else { gross = Math.round(daysWorked * rate); rateShow = r2(rate); }
  const adv = await advanceStatus(emp.id, month);
  const suggested = Math.min(suggestedDeduction(adv.advances, month), gross, adv.outstanding);
  return {
    employee_id: emp.id, name: emp.name, code: emp.code || "", designation: emp.designation || "", phone: emp.phone || "",
    salary_type: sal.salary_type, monthly_salary: Number(sal.monthly_salary), salary_effective_from: sal.effective_from || "",
    present, half_days: half, absent, marked_days: marked, override: override ?? null, days_worked: daysWorked,
    daily_rate: rateShow, gross, advance_outstanding: adv.outstanding, suggested_deduction: r2(suggested),
  };
}
async function monthContext(month) {
  const { y, days } = monthDays(month);
  const ys = await getYearSettings(y);
  const calc = yearCalc(ys);
  const hol = new Set(ys.holidays.map((h) => h.date));
  const wim = days.filter((d) => weekday(d) !== 0 && !hol.has(d)).length;
  const att = {};
  for (const r of await find("attendance", { date: monthRe(month) })) (att[r.employee_id] ||= {})[r.date] = r.status;
  const overrides = {};
  for (const o of await find("overrides", { month })) overrides[o.employee_id] = o.days;
  return { calc, wim, att, overrides };
}

async function generateSlips(month, employeeIds, deductions, send, skipEmpty = false) {
  const { calc, att, overrides } = await monthContext(month);
  const done = new Set((await find("slips", { month })).map((s) => s.employee_id));
  const drafts = {};
  for (const d of await find("drafts", { month })) drafts[d.employee_id] = d.advance_deduction;
  const created = [], errors = [];
  const { days } = monthDays(month);
  for (const e of await find("employees", {}, { name: 1 })) {
    if (done.has(e.id) || (employeeIds.length && !employeeIds.includes(e.id))) continue;
    if (!employeeIds.length && e.active === false && !att[e.id] && overrides[e.id] === undefined) continue;
    const r = await computeRow(e, month, calc, att[e.id] || {}, overrides[e.id]);
    if (skipEmpty && r.salary_type !== "fixed" && r.days_worked === 0) continue;
    let ded = deductions[e.id] ?? drafts[e.id] ?? r.suggested_deduction;
    ded = r2(Number(ded || 0));
    if (ded < 0 || ded > r.advance_outstanding + 0.001 || ded > r.gross) {
      errors.push(`${e.name}: advance deduction must be between 0 and ${Math.min(r.advance_outstanding, r.gross)}`);
      continue;
    }
    const slip = { ...r, id: crypto.randomUUID(), month, period: `${month}-01 to ${days[days.length - 1]}`, calc,
      advance_deduction: ded, net: r2(r.gross - ded), advance_balance_after: r2(r.advance_outstanding - ded),
      generated_at: nowIST().iso, wa_status: "not sent" };
    await db.slips.insertAsync({ ...slip });
    await removeOne("drafts", { employee_id: e.id, month });
    created.push(slip.id);
  }
  if (send && created.length) sendSlipMessages(created).catch((e) => log("slip send error", e.message));
  return { created: created.length, errors };
}
function slipValues(sl, company) {
  const c = sl.calc, fixed = sl.salary_type === "fixed";
  return [sl.name, monthLabel(sl.month), fmtInr(sl.monthly_salary),
    fixed ? "Fixed monthly salary" : `${c.days_in_year} - ${c.sundays} Sundays - ${c.paid_holidays} holidays = ${c.working_days} days`,
    fixed ? "-" : fmtInr(sl.daily_rate), String(sl.days_worked), sl.present, sl.half_days, sl.absent,
    fmtInr(sl.gross), fmtInr(sl.advance_deduction), fmtInr(sl.net), fmtInr(sl.advance_balance_after), company];
}
async function sendSlipMessages(ids) {
  const s = await getAppSettings();
  if (!s.salary_msgs) return;
  for (const id of ids) {
    const sl = await findOne("slips", { id });
    if (!sl) continue;
    if (!sl.phone) { await upsert("slips", { id }, { wa_status: "no phone" }); continue; }
    const res = await sendTemplate(sl.phone, s.tpl_salary, slipValues(sl, s.company_name), "salary", id);
    await upsert("slips", { id }, { wa_status: res.status, wa_at: res.at });
  }
}

// ------------------------------------------------------------ validation helpers
const reqStr = (v, name) => { if (typeof v !== "string" || !v.trim()) fail(400, `${name} is required`); return v; };
const isMonth = (v) => /^\d{4}-\d{2}$/.test(v || "");
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "");
const num = (v, def = 0) => (v === undefined || v === null || v === "" ? def : Number(v));

// ------------------------------------------------------------ Google Drive backup
const zlib = require("zlib");
const GOOGLE_AUTH_URL = process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
const GOOGLE_API = (process.env.GOOGLE_API || "https://www.googleapis.com").replace(/\/$/, "");
const GDRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file openid email";
const GDRIVE_FOLDER = "Paragon Attendance Backups";
const BACKUP_COLLECTIONS = ["settings", "app_settings", "employees", "attendance", "overrides", "advances", "slips", "drafts", "wa_logs", "jobs"];
const GDRIVE_DEFAULTS = {
  client_id: CONFIG.google_client_id || "", client_secret: CONFIG.google_client_secret || "",
  refresh_token: "", email: "", folder_id: "", backup_on_exit: true, daily_backup: true, daily_backup_time: "21:00",
  keep_backups: 30, last_backup_at: "", last_status: "", last_message: "", last_file: "", last_hash: "",
};
async function getGdrive() {
  const s = (await findOne("app_settings", { key: "gdrive" })) || {};
  delete s.key;
  const out = { ...GDRIVE_DEFAULTS };
  for (const [k, v] of Object.entries(s)) if (v !== null && v !== undefined && (v !== "" || !["client_id", "client_secret"].includes(k))) out[k] = v;
  return out;
}
const saveGdrive = (kw) => upsert("app_settings", { key: "gdrive" }, { ...kw, key: "gdrive" });
const gdrivePublic = (g) => ({
  connected: !!g.refresh_token, email: g.email, has_client: !!(g.client_id && g.client_secret), client_id: g.client_id,
  client_secret: mask(g.client_secret), backup_on_exit: g.backup_on_exit, daily_backup: g.daily_backup,
  daily_backup_time: g.daily_backup_time, keep_backups: g.keep_backups, last_backup_at: g.last_backup_at,
  last_status: g.last_status, last_message: g.last_message, last_file: g.last_file,
});
function signState(data) {
  const sig = crypto.createHmac("sha256", CONFIG.secret_key).update(data).digest("hex").slice(0, 32);
  return Buffer.from(`${data}|${sig}`).toString("base64url");
}
function readState(state) {
  try {
    const raw = Buffer.from(state, "base64url").toString();
    const i = raw.lastIndexOf("|");
    const data = raw.slice(0, i), sig = raw.slice(i + 1);
    const good = crypto.createHmac("sha256", CONFIG.secret_key).update(data).digest("hex").slice(0, 32);
    return good === sig ? data : null;
  } catch (e) { return null; }
}
async function googleAccessToken(g) {
  if (!g.refresh_token) fail(400, "Google Drive is not connected");
  const r = await fetch(GOOGLE_TOKEN_URL, { method: "POST", body: new URLSearchParams({
    client_id: g.client_id, client_secret: g.client_secret, refresh_token: g.refresh_token, grant_type: "refresh_token" }) });
  const text = await r.text();
  if (r.status !== 200) {
    if (text.includes("invalid_grant")) {
      await saveGdrive({ refresh_token: "", last_status: "failed", last_message: "Google access was removed or expired. Please connect Google Drive again." });
      fail(400, "Google access expired. Please connect Google Drive again.");
    }
    fail(502, "Google token error: " + text.slice(0, 200));
  }
  return JSON.parse(text).access_token;
}
async function gfetch(token, url, opts = {}) {
  return fetch(url, { ...opts, headers: { Authorization: "Bearer " + token, ...(opts.headers || {}) }, signal: AbortSignal.timeout(120000) });
}
async function gdriveFolder(token, g) {
  if (g.folder_id) {
    const r = await gfetch(token, `${GOOGLE_API}/drive/v3/files/${g.folder_id}?fields=id,trashed`);
    if (r.status === 200 && !(await r.json()).trashed) return g.folder_id;
  }
  const q = `name='${GDRIVE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const r = await gfetch(token, `${GOOGLE_API}/drive/v3/files?` + new URLSearchParams({ q, fields: "files(id)" }));
  const files = r.status === 200 ? (await r.json()).files || [] : [];
  let fid;
  if (files.length) fid = files[0].id;
  else {
    const c = await gfetch(token, `${GOOGLE_API}/drive/v3/files?fields=id`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: GDRIVE_FOLDER, mimeType: "application/vnd.google-apps.folder" }) });
    if (c.status >= 300) fail(502, "Could not create Drive folder: " + (await c.text()).slice(0, 200));
    fid = (await c.json()).id;
  }
  await saveGdrive({ folder_id: fid });
  return fid;
}
async function exportData() {
  const out = { app: "paragon-attendance", version: 1, at: nowIST().iso };
  for (const c of BACKUP_COLLECTIONS) out[c] = await find(c, c === "app_settings" ? { key: { $ne: "gdrive" } } : {});
  return out;
}
const stable = (v) => (Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v);
let backupChain = Promise.resolve();
function runDriveBackup(reason, force = false) {
  const job = backupChain.then(() => doDriveBackup(reason, force));
  backupChain = job.catch(() => {});
  return job;
}
async function doDriveBackup(reason, force) {
  const g = await getGdrive();
  if (!g.refresh_token) return { status: "skipped", message: "Google Drive is not connected" };
  const data = await exportData();
  const { at, ...rest } = data;
  const digest = crypto.createHash("sha256").update(JSON.stringify(stable(rest))).digest("hex");
  if (!force && digest === g.last_hash) return { status: "unchanged", message: "No changes since the last backup" };
  try {
    const token = await googleAccessToken(g);
    const folder = await gdriveFolder(token, g);
    const n = nowIST();
    const name = `Paragon-Backup-${n.date}_${n.hm.replace(":", "")}.json.gz`;
    const payload = zlib.gzipSync(Buffer.from(JSON.stringify(data)));
    const boundary = "paragon" + crypto.randomBytes(12).toString("hex");
    const meta = JSON.stringify({ name, parents: [folder], description: `Paragon Attendance backup (${reason})` });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`),
      payload, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const r = await gfetch(token, `${GOOGLE_API}/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,createdTime,webViewLink`,
      { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
    if (r.status >= 300) fail(502, "Upload failed: " + (await r.text()).slice(0, 200));
    const f = await r.json();
    const lr = await gfetch(token, `${GOOGLE_API}/drive/v3/files?` + new URLSearchParams({
      q: `'${folder}' in parents and trashed=false`, orderBy: "createdTime desc", fields: "files(id,name)", pageSize: "1000" }));
    if (lr.status === 200) {
      const olds = ((await lr.json()).files || []).filter((x) => x.name.startsWith("Paragon-Backup-"));
      for (const x of olds.slice(Math.max(Number(g.keep_backups) || 30, 1))) await gfetch(token, `${GOOGLE_API}/drive/v3/files/${x.id}`, { method: "DELETE" });
    }
    await saveGdrive({ last_backup_at: nowIST().iso, last_status: "ok", last_message: `Backed up (${reason})`, last_file: f.name, last_hash: digest });
    log("Drive backup ok:", f.name, reason);
    return { status: "ok", file: f, message: `Saved ${f.name} to Google Drive` };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    await saveGdrive({ last_status: "failed", last_message: msg, last_backup_at: nowIST().iso });
    log("Drive backup failed:", msg);
    return { status: "failed", message: msg };
  }
}
async function importData(data) {
  if (!data || data.app !== "paragon-attendance") fail(400, "This is not a Paragon Attendance backup file");
  for (const c of BACKUP_COLLECTIONS) {
    let rows = data[c];
    if (!Array.isArray(rows)) continue;
    if (c === "app_settings") { await removeMany(c, { key: { $ne: "gdrive" } }); rows = rows.filter((r) => r.key !== "gdrive"); }
    else await removeMany(c, {});
    for (const r of rows) { const x = { ...r }; delete x._id; await db[c].insertAsync(x); }
  }
  await removeMany("notify_queue", {});
}

// ------------------------------------------------------------ routes
const app = express();
app.use(express.json({ limit: "2mb" }));
const api = express.Router();
const h = (fn) => (req, res) => Promise.resolve(fn(req, res)).then((out) => res.json(out)).catch((e) => {
  if (e instanceof HttpError) res.status(e.code).json({ detail: e.message });
  else { log("ERROR", req.method, req.path, e.stack || e); res.status(500).json({ detail: "Server error: " + e.message }); }
});
const auth = (req, res, next) => {
  const a = req.headers.authorization || "";
  if (!a.startsWith("Bearer ")) return res.status(401).json({ detail: "Not logged in" });
  if (!checkToken(a.slice(7))) return res.status(401).json({ detail: "Session expired, please log in again" });
  next();
};

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || [])
    if (i.family === "IPv4" && !i.internal) out.push(`http://${i.address}:${PORT}`);
  return out;
}

api.get("/", h(async () => ({ app: "Paragon Attendance & Payroll", status: "ok", edition: "desktop", time_ist: nowIST().iso })));
api.get("/server-info", h(async () => ({ edition: "desktop", port: PORT, lan_urls: lanAddresses(), data_dir: DATA_DIR, hostname: os.hostname() })));
api.post("/login", h(async (req) => {
  const { username = "", password = "" } = req.body || {};
  if (username.trim() !== CONFIG.admin_username || password !== CONFIG.admin_password) fail(401, "Wrong username or password");
  return { token: makeToken(CONFIG.admin_username), username: CONFIG.admin_username };
}));
api.get("/calc", h(async (req) => {
  const c = yearCalc({ year: Number(req.query.year), paid_holidays: num(req.query.paid_holidays, DEFAULT_PAID_HOLIDAYS) });
  const r = dailyRate(Number(req.query.monthly_salary), c.working_days);
  return { ...c, annual_salary: Number(req.query.monthly_salary) * 12, daily_rate: r2(r), days: Number(req.query.days), month_salary: Math.round(Number(req.query.days) * r) };
}));

api.get("/gdrive/callback", async (req, res) => {
  try {
    const data = readState(String(req.query.state || ""));
    if (!data) return res.status(400).send("<h3>Invalid or expired link. Please try Connect Google Drive again.</h3>");
    const [exp, redirectUri, ...rest] = data.split("|");
    const back = rest.join("|").replace(/\/$/, "") + "/?gdrive=";
    if (Number(exp) < Date.now() / 1000) return res.redirect(back + "expired");
    if (req.query.error || !req.query.code) return res.redirect(back + "cancelled");
    const g = await getGdrive();
    const r = await fetch(GOOGLE_TOKEN_URL, { method: "POST", body: new URLSearchParams({ code: String(req.query.code), client_id: g.client_id,
      client_secret: g.client_secret, redirect_uri: redirectUri, grant_type: "authorization_code" }) });
    if (r.status !== 200) { log("gdrive token exchange failed", (await r.text()).slice(0, 300)); return res.redirect(back + "failed"); }
    const tok = await r.json();
    let email = "";
    try { email = JSON.parse(Buffer.from(String(tok.id_token).split(".")[1], "base64url").toString()).email || ""; } catch (e) { /* no email */ }
    const upd = { email, folder_id: "", last_hash: "" };
    if (tok.refresh_token) upd.refresh_token = tok.refresh_token;
    else if (!g.refresh_token) return res.redirect(back + "norefresh");
    await saveGdrive(upd);
    res.redirect(back + "connected");
  } catch (e) { log("gdrive callback error", e.stack || e); res.status(500).send("Google connection failed: " + e.message); }
});
api.post("/gdrive/backup-beacon", express.text({ type: "*/*" }), async (req, res) => {
  let token = "";
  try { token = JSON.parse(typeof req.body === "string" ? req.body : JSON.stringify(req.body || {})).token || ""; } catch (e) { /* bad body */ }
  if (!checkToken(token)) return res.status(401).json({ detail: "Not logged in" });
  const g = await getGdrive();
  if (g.refresh_token && g.backup_on_exit) runDriveBackup("app closed").catch(() => {});
  res.json({ ok: true });
});

api.use(auth);

// password change (desktop only)
api.post("/change-password", h(async (req) => {
  const { old_password, new_password } = req.body || {};
  if (old_password !== CONFIG.admin_password) fail(400, "Current password is wrong");
  if (!new_password || new_password.length < 6) fail(400, "New password must be at least 6 characters");
  CONFIG.admin_password = new_password;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2));
  return { ok: true };
}));

// app settings
api.get("/app-settings", h(async () => {
  const s = await getAppSettings();
  return { ...s, has_api_key: !!s.interakt_api_key, interakt_api_key: mask(s.interakt_api_key) };
}));
api.put("/app-settings", h(async (req) => {
  const b = req.body || {};
  const cur = await getAppSettings();
  if (b.summary_time && !/^\d{2}:\d{2}$/.test(b.summary_time)) fail(400, "Summary time must be HH:MM");
  if (b.salary_time && !/^\d{2}:\d{2}$/.test(b.salary_time)) fail(400, "Salary time must be HH:MM");
  const day = num(b.salary_day, 5);
  if (!(day >= 1 && day <= 28)) fail(400, "Salary day must be between 1 and 28");
  const data = {};
  for (const k of Object.keys(APP_DEFAULTS)) data[k] = b[k] !== undefined ? b[k] : cur[k];
  data.salary_day = day;
  const key = String(b.interakt_api_key || "").trim();
  data.interakt_api_key = key && !key.startsWith("•") ? key.replace(/^Basic\s+/, "").trim() : cur.interakt_api_key;
  await upsert("app_settings", { key: "app" }, { ...data, key: "app" });
  const s = await getAppSettings();
  return { ...s, has_api_key: !!s.interakt_api_key, interakt_api_key: mask(s.interakt_api_key) };
}));

// WhatsApp
api.get("/whatsapp/logs", h(async (req) => find("wa_logs", {}, { at: -1 }, Math.min(num(req.query.limit, 100), 500))));
api.post("/whatsapp/test", h(async (req) => {
  const s = await getAppSettings();
  return sendTemplate(reqStr(req.body.phone, "Phone"), s.tpl_attendance, ["Test Employee", dayLabel(todayIST()), "Present", s.company_name], "test");
}));
api.get("/summary", h(async (req) => buildDaySummary(req.query.d || todayIST())));
api.post("/summary/send", h(async (req) => {
  const res = await sendOwnerSummary((req.body && req.body.date) || todayIST());
  if (!res.length) fail(400, "Add owner WhatsApp numbers in WhatsApp settings first");
  return res;
}));
api.post("/notifications/flush", h(async () => { await processQueue(true); return { ok: true }; }));

// year settings
api.get("/settings/:year", h(async (req) => {
  const s = await getYearSettings(Number(req.params.year));
  return { settings: s, calc: yearCalc(s) };
}));
api.put("/settings/:year", h(async (req) => {
  const year = Number(req.params.year);
  const paid = num(req.body.paid_holidays, DEFAULT_PAID_HOLIDAYS);
  if (!(paid >= 0 && paid <= 100)) fail(400, "Paid holidays must be between 0 and 100");
  const map = {};
  for (const hd of req.body.holidays || []) if (isDate(hd.date) && hd.date.startsWith(String(year))) map[hd.date] = { date: hd.date, name: hd.name || "" };
  const doc = { year, paid_holidays: paid, holidays: Object.values(map).sort((a, b) => a.date.localeCompare(b.date)) };
  await upsert("settings", { year }, doc);
  return { settings: doc, calc: yearCalc(doc) };
}));

// employees
function empBody(b) {
  const name = reqStr(b.name, "Name").trim();
  const st = b.salary_type === "fixed" ? "fixed" : "per_day";
  const ms = num(b.monthly_salary);
  if (!(ms >= 0)) fail(400, "Salary cannot be negative");
  return { code: b.code || "", name, phone: b.phone || "", designation: b.designation || "", salary_type: st,
    monthly_salary: ms, join_date: b.join_date || "", active: b.active !== false };
}
api.get("/employees", h(async () => find("employees", {}, { active: -1, name: 1 })));
api.post("/employees", h(async (req) => {
  const doc = { ...empBody(req.body), id: crypto.randomUUID() };
  doc.salary_history = [{ effective_from: (doc.join_date || "").slice(0, 7) || "2000-01", monthly_salary: doc.monthly_salary,
    salary_type: doc.salary_type, note: "Joining salary", at: nowIST().iso }];
  await db.employees.insertAsync({ ...doc });
  return doc;
}));
api.put("/employees/:id", h(async (req) => {
  const emp = await findOne("employees", { id: req.params.id });
  if (!emp) fail(404, "Employee not found");
  const b = empBody(req.body);
  const upd = { code: b.code, name: b.name, phone: b.phone, designation: b.designation, join_date: b.join_date, active: b.active };
  if (!emp.salary_history || !emp.salary_history.length) {
    upd.salary_history = [{ effective_from: "2000-01", monthly_salary: b.monthly_salary, salary_type: b.salary_type, note: "Opening salary", at: nowIST().iso }];
    upd.monthly_salary = b.monthly_salary; upd.salary_type = b.salary_type;
  }
  await upsert("employees", { id: req.params.id }, upd);
  return findOne("employees", { id: req.params.id });
}));
api.delete("/employees/:id", h(async (req) => {
  const id = req.params.id;
  if (await findOne("slips", { employee_id: id })) fail(400, "This employee has salary slips. Mark them Inactive instead of deleting.");
  for (const c of ["attendance", "overrides", "advances", "drafts", "notify_queue"]) await removeMany(c, { employee_id: id });
  await removeOne("employees", { id });
  return { ok: true };
}));
api.post("/employees/:id/salary-change", h(async (req) => {
  const emp = await findOne("employees", { id: req.params.id });
  if (!emp) fail(404, "Employee not found");
  const b = req.body || {};
  if (!isMonth(b.effective_from)) fail(400, "Choose the month the salary applies from");
  const ms = num(b.monthly_salary, NaN);
  if (!(ms >= 0)) fail(400, "Enter a valid salary");
  let hist = (emp.salary_history || []).filter((x) => x.effective_from !== b.effective_from);
  if (!hist.length && !(emp.salary_history || []).length)
    hist = [{ effective_from: "2000-01", monthly_salary: emp.monthly_salary || 0, salary_type: emp.salary_type || "per_day", note: "Opening salary" }];
  hist.push({ effective_from: b.effective_from, monthly_salary: ms, salary_type: b.salary_type === "fixed" ? "fixed" : "per_day", note: b.note || "", at: nowIST().iso });
  hist.sort((a, c) => a.effective_from.localeCompare(c.effective_from));
  await upsert("employees", { id: emp.id }, { salary_history: hist });
  await refreshCurrentSalary(emp.id);
  const affected = (await find("slips", { employee_id: emp.id, month: { $gte: b.effective_from } })).map((s) => s.month);
  return { employee: await findOne("employees", { id: emp.id }), generated_slips_affected: affected };
}));
api.delete("/employees/:id/salary-change/:eff", h(async (req) => {
  const emp = await findOne("employees", { id: req.params.id });
  if (!emp) fail(404, "Employee not found");
  const hist = emp.salary_history || [];
  if (hist.length <= 1) fail(400, "Cannot remove the only salary entry");
  await upsert("employees", { id: emp.id }, { salary_history: hist.filter((x) => x.effective_from !== req.params.eff) });
  await refreshCurrentSalary(emp.id);
  return findOne("employees", { id: emp.id });
}));

// attendance
async function setStatus(empId, d, status) {
  if (status === "") {
    await removeOne("attendance", { employee_id: empId, date: d });
    await removeOne("notify_queue", { employee_id: empId, date: d });
  } else {
    await upsert("attendance", { employee_id: empId, date: d }, { employee_id: empId, date: d, status });
    await enqueueAttendance(empId, d);
  }
}
async function ensureUnlocked(empId, d) {
  if (await findOne("slips", { employee_id: empId, month: d.slice(0, 7) }))
    fail(400, "Salary slip already generated for this month. Cancel the slip to edit attendance.");
}
const validStatus = (s) => { if (!["", "P", "H", "A"].includes(s)) fail(400, "Status must be P, H or A"); };

api.get("/attendance", h(async (req) => {
  const month = req.query.month;
  if (!isMonth(month)) fail(400, "Bad month");
  const { y, days } = monthDays(month);
  const ys = await getYearSettings(y);
  const hol = Object.fromEntries(ys.holidays.map((x) => [x.date, x.name || ""]));
  const records = {};
  for (const r of await find("attendance", { date: monthRe(month) })) (records[r.employee_id] ||= {})[r.date] = r.status;
  const overrides = {};
  for (const o of await find("overrides", { month })) overrides[o.employee_id] = o.days;
  const locked = (await find("slips", { month })).map((s) => s.employee_id);
  const dayInfo = days.map((d) => ({ date: d, day: Number(d.slice(8)), weekday: DAYS[weekday(d)], sunday: weekday(d) === 0, holiday: hol[d] ?? null }));
  return { month, days: dayInfo, records, overrides, locked };
}));
api.get("/attendance/day", h(async (req) => {
  const d = req.query.d;
  const records = {};
  for (const r of await find("attendance", { date: d })) records[r.employee_id] = { status: r.status, notified: r.notified_status === r.status };
  const pending = [...new Set((await find("notify_queue", { date: d })).map((q) => q.employee_id))];
  return { date: d, records, pending };
}));
api.put("/attendance", h(async (req) => {
  const { employee_id, date, status = "" } = req.body || {};
  validStatus(status);
  if (!isDate(date)) fail(400, "Bad date");
  await ensureUnlocked(employee_id, date);
  await setStatus(employee_id, date, status);
  return { ok: true };
}));
api.post("/attendance/bulk", h(async (req) => {
  const b = req.body || {};
  const status = b.status ?? "P";
  validStatus(status);
  const month = b.month || (b.date || "").slice(0, 7);
  if (!isMonth(month)) fail(400, "Bad month");
  const { y, days } = monthDays(month);
  const hol = new Set((await getYearSettings(y)).holidays.map((x) => x.date));
  const targets = b.date ? [b.date] : days.filter((d) => weekday(d) !== 0 && !hol.has(d));
  const ids = b.employee_ids && b.employee_ids.length ? b.employee_ids : (await find("employees", { active: true })).map((e) => e.id);
  const locked = new Set((await find("slips", { month })).map((s) => s.employee_id));
  const onlyEmpty = b.only_empty !== false;
  let changed = 0;
  for (const eid of ids) {
    if (locked.has(eid)) continue;
    const existing = new Set((await find("attendance", { employee_id: eid, date: { $in: targets } })).map((r) => r.date));
    for (const t of targets) {
      if (onlyEmpty && existing.has(t)) continue;
      if (status === "" && !existing.has(t)) continue;
      await setStatus(eid, t, status);
      changed++;
    }
  }
  return { ok: true, changed, skipped_locked: ids.filter((i) => locked.has(i)).length };
}));
api.put("/attendance/override", h(async (req) => {
  const { employee_id, month, days } = req.body || {};
  if (!isMonth(month)) fail(400, "Bad month");
  await ensureUnlocked(employee_id, month + "-01");
  if (days === null || days === undefined || days === "") await removeOne("overrides", { employee_id, month });
  else {
    const d = Number(days);
    if (!(d >= 0 && d <= 31)) fail(400, "Days must be between 0 and 31");
    await upsert("overrides", { employee_id, month }, { employee_id, month, days: d });
  }
  return { ok: true };
}));

// advances
function advBody(b) {
  if (!b.employee_id) fail(400, "Choose an employee");
  if (!isDate(b.date)) fail(400, "Enter the date");
  const amount = num(b.amount, NaN);
  if (!(amount > 0)) fail(400, "Amount must be more than 0");
  const plan = ["monthly", "one_time", "manual"].includes(b.plan) ? b.plan : "monthly";
  const installment = num(b.installment);
  if (plan === "monthly" && !(installment > 0)) fail(400, "Enter the monthly deduction amount");
  if (!isMonth(b.start_month)) fail(400, "Choose the start month");
  return { employee_id: b.employee_id, date: b.date, amount, plan, installment, start_month: b.start_month, note: b.note || "" };
}
api.get("/advances", h(async (req) => {
  const names = Object.fromEntries((await find("employees")).map((e) => [e.id, e.name]));
  const ids = req.query.employee_id ? [req.query.employee_id] : [...new Set((await find("advances")).map((a) => a.employee_id))];
  const out = [];
  for (const id of ids) for (const a of (await advanceStatus(id)).advances) out.push({ ...a, employee_name: names[id] || "?" });
  return out.sort((a, b) => b.date.localeCompare(a.date));
}));
api.post("/advances", h(async (req) => {
  const b = advBody(req.body || {});
  if (!(await findOne("employees", { id: b.employee_id }))) fail(404, "Employee not found");
  const doc = { ...b, id: crypto.randomUUID(), created_at: nowIST().iso };
  await db.advances.insertAsync({ ...doc });
  return doc;
}));
api.put("/advances/:id", h(async (req) => {
  const b = advBody(req.body || {});
  if (!(await findOne("advances", { id: req.params.id }))) fail(404, "Advance not found");
  await upsert("advances", { id: req.params.id }, b);
  return { ok: true };
}));
api.delete("/advances/:id", h(async (req) => {
  const a = await findOne("advances", { id: req.params.id });
  if (!a) fail(404, "Advance not found");
  const mine = (await advanceStatus(a.employee_id)).advances.find((x) => x.id === a.id);
  if (mine && mine.recovered > 0) fail(400, "Part of this advance is already recovered in salary slips. Edit it instead.");
  await removeOne("advances", { id: a.id });
  return { ok: true };
}));

// payroll
api.get("/payroll", h(async (req) => {
  const month = req.query.month;
  if (!isMonth(month)) fail(400, "Bad month");
  const { calc, wim, att, overrides } = await monthContext(month);
  const slips = Object.fromEntries((await find("slips", { month })).map((s) => [s.employee_id, s]));
  const drafts = {};
  for (const d of await find("drafts", { month })) drafts[d.employee_id] = d.advance_deduction;
  const rows = [];
  for (const e of await find("employees", {}, { name: 1 })) {
    if (slips[e.id]) { rows.push({ ...slips[e.id], generated: true }); continue; }
    if (e.active === false && !att[e.id] && overrides[e.id] === undefined) continue;
    const r = await computeRow(e, month, calc, att[e.id] || {}, overrides[e.id]);
    r.advance_deduction = drafts[e.id] ?? r.suggested_deduction;
    r.net = r2(r.gross - r.advance_deduction);
    r.generated = false;
    rows.push(r);
  }
  const s = await getAppSettings();
  const [y, m] = month.split("-").map(Number);
  const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
  return { month, calc, working_days_in_month: wim, rows, company_name: s.company_name,
    salary_date: `${ny}-${String(nm).padStart(2, "0")}-${String(s.salary_day).padStart(2, "0")}`,
    total_gross: rows.reduce((x, r) => x + r.gross, 0), total_deduction: r2(rows.reduce((x, r) => x + r.advance_deduction, 0)),
    total_net: r2(rows.reduce((x, r) => x + r.net, 0)) };
}));
api.put("/payroll/draft", h(async (req) => {
  const { month, employee_id, advance_deduction } = req.body || {};
  if (advance_deduction === null || advance_deduction === undefined || advance_deduction === "") await removeOne("drafts", { employee_id, month });
  else {
    const v = Number(advance_deduction);
    if (!(v >= 0)) fail(400, "Deduction cannot be negative");
    await upsert("drafts", { employee_id, month }, { employee_id, month, advance_deduction: v });
  }
  return { ok: true };
}));
api.post("/payroll/generate", h(async (req) => {
  const b = req.body || {};
  if (!isMonth(b.month)) fail(400, "Bad month");
  return generateSlips(b.month, b.employee_ids || [], b.deductions || {}, b.send_whatsapp !== false);
}));
api.post("/slips/:id/send", h(async (req) => {
  const s = await getAppSettings();
  const sl = await findOne("slips", { id: req.params.id });
  if (!sl) fail(404, "Slip not found");
  if (!sl.phone) fail(400, "Employee has no phone number on this slip");
  const res = await sendTemplate(sl.phone, s.tpl_salary, slipValues(sl, s.company_name), "salary", sl.id);
  await upsert("slips", { id: sl.id }, { wa_status: res.status, wa_at: res.at });
  return res;
}));
api.delete("/slips/:id", h(async (req) => {
  const sl = await findOne("slips", { id: req.params.id });
  if (!sl) fail(404, "Slip not found");
  const later = await findOne("slips", { employee_id: sl.employee_id, month: { $gt: sl.month } });
  if (later) fail(400, `Cancel the later slip (${later.month}) first`);
  await removeOne("slips", { id: sl.id });
  await upsert("drafts", { employee_id: sl.employee_id, month: sl.month }, { employee_id: sl.employee_id, month: sl.month, advance_deduction: sl.advance_deduction });
  return { ok: true };
}));

// ledger
api.get("/employees/:id/ledger", h(async (req) => {
  const emp = await findOne("employees", { id: req.params.id });
  if (!emp) fail(404, "Employee not found");
  const adv = await advanceStatus(emp.id);
  const slips = await find("slips", { employee_id: emp.id }, { month: 1 });
  const events = [];
  for (const a of adv.advances) events.push({ date: a.date, sort: a.date + "0", type: "advance", text: "Advance given" + (a.note ? " - " + a.note : ""), advance_given: a.amount });
  for (const s of slips) {
    const d = s.generated_at.slice(0, 10);
    events.push({ date: d, sort: d + "1" + s.month, type: "salary", month: s.month, text: `Salary for ${monthLabel(s.month)} (${s.days_worked} days)`,
      gross: s.gross, advance_deduction: s.advance_deduction, net: s.net, slip_id: s.id });
  }
  events.sort((a, b) => a.sort.localeCompare(b.sort));
  let bal = 0;
  for (const e of events) { bal += (e.advance_given || 0) - (e.advance_deduction || 0); e.advance_balance = r2(bal); delete e.sort; }
  return { employee: emp, advances: adv, slips, entries: events,
    totals: { gross: slips.reduce((x, s) => x + s.gross, 0), net: r2(slips.reduce((x, s) => x + s.net, 0)),
      advance_given: adv.total, advance_recovered: adv.recovered, advance_outstanding: adv.outstanding } };
}));

// Google Drive routes
api.get("/gdrive/status", h(async () => gdrivePublic(await getGdrive())));
api.put("/gdrive/settings", h(async (req) => {
  const b = req.body || {};
  const t = b.daily_backup_time || "21:00";
  if (!/^\d{2}:\d{2}$/.test(t)) fail(400, "Backup time must be HH:MM");
  const keep = num(b.keep_backups, 30);
  if (!(keep >= 1 && keep <= 365)) fail(400, "Keep backups must be between 1 and 365");
  const upd = { backup_on_exit: b.backup_on_exit !== false, daily_backup: b.daily_backup !== false, daily_backup_time: t, keep_backups: keep };
  if (typeof b.client_id === "string") upd.client_id = b.client_id.trim();
  if (b.client_secret && !String(b.client_secret).startsWith("•")) upd.client_secret = String(b.client_secret).trim();
  await saveGdrive(upd);
  return gdrivePublic(await getGdrive());
}));
api.get("/gdrive/auth-url", h(async (req) => {
  const g = await getGdrive();
  if (!(g.client_id && g.client_secret)) fail(400, "Enter the Google OAuth Client ID and Client Secret first");
  const redirectUri = String(req.query.api_base || `http://localhost:${PORT}`).replace(/\/$/, "") + "/api/gdrive/callback";
  const state = signState(`${Math.floor(Date.now() / 1000) + 900}|${redirectUri}|${req.query.return_to || `http://localhost:${PORT}`}`);
  const url = GOOGLE_AUTH_URL + "?" + new URLSearchParams({ client_id: g.client_id, redirect_uri: redirectUri, response_type: "code",
    scope: GDRIVE_SCOPE, access_type: "offline", prompt: "consent", include_granted_scopes: "true", state });
  return { url, redirect_uri: redirectUri };
}));
api.post("/gdrive/disconnect", h(async () => {
  const g = await getGdrive();
  if (g.refresh_token) { try { await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", body: new URLSearchParams({ token: g.refresh_token }), signal: AbortSignal.timeout(15000) }); } catch (e) { /* offline */ } }
  await saveGdrive({ refresh_token: "", email: "", folder_id: "", last_hash: "" });
  return gdrivePublic(await getGdrive());
}));
api.post("/gdrive/backup", h(async (req) => runDriveBackup(String((req.body || {}).reason || "manual").slice(0, 30), !!(req.body || {}).force)));
api.get("/gdrive/backups", h(async () => {
  const g = await getGdrive();
  const token = await googleAccessToken(g);
  const folder = await gdriveFolder(token, g);
  const r = await gfetch(token, `${GOOGLE_API}/drive/v3/files?` + new URLSearchParams({ q: `'${folder}' in parents and trashed=false`,
    orderBy: "createdTime desc", fields: "files(id,name,size,createdTime,webViewLink)", pageSize: "200" }));
  if (r.status >= 300) fail(502, "Could not list backups: " + (await r.text()).slice(0, 200));
  return ((await r.json()).files || []).filter((f) => f.name.startsWith("Paragon-Backup-"));
}));
api.post("/gdrive/restore", h(async (req) => {
  const g = await getGdrive();
  const token = await googleAccessToken(g);
  const r = await gfetch(token, `${GOOGLE_API}/drive/v3/files/${encodeURIComponent((req.body || {}).file_id || "")}?alt=media`);
  if (r.status >= 300) fail(502, "Could not download backup: " + (await r.text()).slice(0, 200));
  let raw = Buffer.from(await r.arrayBuffer());
  let data;
  try { if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw); data = JSON.parse(raw.toString()); }
  catch (e) { fail(400, "Backup file is damaged"); }
  await runDriveBackup("before restore", true);
  await importData(data);
  await saveGdrive({ last_hash: "" });
  return { ok: true, restored_from: data.at };
}));

// backup: download all data as one JSON file
api.get("/backup", h(async () => exportData()));

app.use("/api", api);
app.use("/api", (req, res) => res.status(404).json({ detail: "Not found" }));

// React frontend
app.use(express.static(PUBLIC_DIR, { index: "index.html", maxAge: "1h" }));
app.use((req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

// ------------------------------------------------------------ scheduler
async function runOncePer(key) {
  if (await findOne("jobs", { key })) return false;
  await db.jobs.insertAsync({ key, at: nowIST().iso });
  return true;
}
async function schedulerTick() {
  await processQueue();
  const s = await getAppSettings();
  const n = nowIST();
  if (s.owner_summary && String(s.owner_numbers).trim() && n.hm >= s.summary_time && (await runOncePer("summary-" + n.date))) {
    await sendOwnerSummary(n.date);
  }
  const g = await getGdrive();
  if (g.refresh_token && g.daily_backup && n.hm >= g.daily_backup_time && (await runOncePer("gbackup-" + n.date))) await runDriveBackup("daily");
  if (s.auto_generate && n.day === Number(s.salary_day) && n.hm >= s.salary_time) {
    const last = prevMonth(n.month);
    if (await runOncePer("salary-" + last)) await generateSlips(last, [], {}, true, true);
  }
}
let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try { await schedulerTick(); } catch (e) { log("scheduler error", e.stack || e); }
  ticking = false;
}, 20000);

process.on("uncaughtException", (e) => log("uncaught", e.stack || e));
process.on("unhandledRejection", (e) => log("unhandled", (e && e.stack) || e));

const server = app.listen(PORT, "0.0.0.0", () => {
  log(`Paragon Attendance running on http://localhost:${PORT}  LAN: ${lanAddresses().join(", ") || "none"}  data: ${DATA_DIR}`);
});
server.on("error", (e) => { log("Server failed to start:", e.message); process.exit(1); });
module.exports = { app, nowIST, fmtInr, countSundays };

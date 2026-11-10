"""
Paragon Attendance & Payroll - FastAPI backend (all routes under /api)

Salary rule (per-day salaried employees):
    x1 working days in year = days_in_year - actual Sundays - paid holidays
    x2 yearly salary        = monthly salary * 12
    x3 daily rate           = x2 / x1
    x4 month salary         = days worked * x3
Fixed-salary employees always get their full monthly salary.
Salary month = 1st to last day of the month. Salary day = 5th of next month (configurable).

WhatsApp via Interakt (approved templates):
    attendance message to employee, salary slip message, daily owner summary.
A background loop (every 20 s) sends queued attendance messages, the owner
summary at the set time, and auto-generates last month's slips on salary day.
"""
import asyncio
import base64
import calendar
import contextvars
import gzip
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv
from fastapi import APIRouter, BackgroundTasks, Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "paragon_attendance")
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "paragon@123")
SECRET_KEY = os.environ.get("SECRET_KEY", "change-this-secret-key")
INTERAKT_URL = os.environ.get("INTERAKT_URL", "https://api.interakt.ai/v1/public/message/")
SERVERLESS = bool(os.environ.get("VERCEL") or os.environ.get("SERVERLESS"))  # Vercel sets VERCEL=1
DISABLE_SCHEDULER = os.environ.get("DISABLE_SCHEDULER", "") == "1" or SERVERLESS
CRON_SECRET = os.environ.get("CRON_SECRET", "")
DEFAULT_PAID_HOLIDAYS = 24
IST = ZoneInfo("Asia/Kolkata")

log = logging.getLogger("paragon")
class _LazyDB:
    """Mongo database handle that reconnects when the event loop changes
    (serverless platforms like Vercel may run each request in a fresh loop)."""
    def __init__(self):
        self._loop = None
        self._client = None

    def _db(self):
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if self._client is None or (loop is not None and loop is not self._loop):
            self._client = AsyncIOMotorClient(MONGO_URL, serverSelectionTimeoutMS=10000, appname="paragon-attendance")
            self._loop = loop
        return self._client[DB_NAME]

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self._db()[name]

    def __getitem__(self, name):
        return self._db()[name]

    def close(self):
        if self._client is not None:
            self._client.close()


db = _LazyDB()

app = FastAPI(title="Paragon Attendance & Payroll")
api = APIRouter(prefix="/api")


def now_ist() -> datetime:
    return datetime.now(IST)


def today_ist() -> str:
    return now_ist().date().isoformat()


# ================================================================ auth
def make_token(username: str) -> str:
    exp = str(int(time.time()) + 60 * 60 * 24 * 7)
    payload = f"{username}|{exp}"
    sig = hmac.new(SECRET_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}|{sig}"


def check_token(token: str) -> bool:
    try:
        username, exp, sig = token.split("|")
    except ValueError:
        return False
    good = hmac.new(SECRET_KEY.encode(), f"{username}|{exp}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, good) and int(exp) > time.time()


# ---- users & roles ------------------------------------------------------------
# admin: everything. accountant: only attendance marking (Today + Attendance pages).
ROLES = ("admin", "accountant")
ACCOUNTANT_ALLOWED = [
    ("GET", r"^/api/employees$"), ("GET", r"^/api/attendance$"), ("GET", r"^/api/attendance/day$"),
    ("PUT", r"^/api/attendance$"), ("POST", r"^/api/attendance/bulk$"), ("POST", r"^/api/notifications/flush$"),
    ("GET", r"^/api/gdrive/status$"), ("POST", r"^/api/gdrive/backup$"), ("GET", r"^/api/me$"),
    ("POST", r"^/api/change-password$"),
]
CURRENT_USER: contextvars.ContextVar = contextvars.ContextVar("current_user", default=None)


def hash_password(pw: str, salt: Optional[str] = None) -> str:
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 200000).hex()
    return f"pbkdf2${200000}${salt}${h}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        _, it, salt, h = stored.split("$")
        return hmac.compare_digest(hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), int(it)).hex(), h)
    except Exception:
        return False


async def ensure_admin_user():
    if not await db.users.find_one({"role": "admin", "active": True}):
        if not await db.users.find_one({"username": ADMIN_USERNAME}):
            await db.users.insert_one({"id": str(uuid.uuid4()), "username": ADMIN_USERNAME, "name": "Administrator",
                                       "role": "admin", "active": True, "password": hash_password(ADMIN_PASSWORD),
                                       "created_at": now_ist().isoformat(timespec="seconds")})
        else:
            await db.users.update_one({"username": ADMIN_USERNAME}, {"$set": {"role": "admin", "active": True}})


def token_user(token: str) -> Optional[str]:
    return token.split("|")[0] if check_token(token) else None


def public_user(u: dict) -> dict:
    return {k: u.get(k) for k in ("id", "username", "name", "role", "active", "created_at")}


async def require_auth(request: Request, authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Not logged in")
    username = token_user(authorization[7:])
    if not username:
        raise HTTPException(401, "Session expired, please log in again")
    u = await db.users.find_one({"username": username, "active": True})
    if not u:
        raise HTTPException(401, "This login was removed or disabled")
    if u["role"] != "admin":
        path, method = request.url.path, request.method
        if not any(m == method and re.match(rx, path) for m, rx in ACCOUNTANT_ALLOWED):
            raise HTTPException(403, "Only the admin can do this")
    CURRENT_USER.set(u)
    return u


AUTH = [Depends(require_auth)]


def is_admin() -> bool:
    u = CURRENT_USER.get()
    return bool(u and u.get("role") == "admin")


class LoginIn(BaseModel):
    username: str
    password: str


@api.post("/login")
async def login(body: LoginIn):
    await ensure_admin_user()
    u = await db.users.find_one({"username": body.username.strip().lower(), "active": True}) or \
        await db.users.find_one({"username": body.username.strip(), "active": True})
    if not u or not verify_password(body.password, u.get("password", "")):
        raise HTTPException(401, "Wrong username or password")
    return {"token": make_token(u["username"]), "user": public_user(u), "username": u["username"]}


@api.get("/me", dependencies=AUTH)
async def me():
    if SERVERLESS:
        try:
            await process_queue()
        except Exception:
            log.exception("queue")
    return public_user(CURRENT_USER.get())


class PasswordIn(BaseModel):
    old_password: str
    new_password: str


@api.post("/change-password", dependencies=AUTH)
async def change_password(body: PasswordIn):
    u = CURRENT_USER.get()
    if not verify_password(body.old_password, u.get("password", "")):
        raise HTTPException(400, "Current password is wrong")
    if len(body.new_password) < 6:
        raise HTTPException(400, "New password must be at least 6 characters")
    await db.users.update_one({"id": u["id"]}, {"$set": {"password": hash_password(body.new_password)}})
    return {"ok": True}


class UserIn(BaseModel):
    username: str = ""
    name: str = ""
    role: str = Field("accountant", pattern="^(admin|accountant)$")
    active: bool = True
    password: Optional[str] = None


async def active_admins(exclude_id: str = "") -> int:
    return len([u async for u in db.users.find({"role": "admin", "active": True}) if u["id"] != exclude_id])


@api.get("/users", dependencies=AUTH)
async def list_users():
    return [public_user(u) async for u in db.users.find().sort([("role", 1), ("name", 1)])]


@api.post("/users", dependencies=AUTH)
async def add_user(body: UserIn):
    un = body.username.strip().lower()
    if not re.match(r"^[a-z0-9._@-]{3,40}$", un):
        raise HTTPException(400, "Username: 3-40 letters/numbers, no spaces")
    if await db.users.find_one({"username": un}):
        raise HTTPException(400, "This username already exists")
    if not body.password or len(body.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    doc = {"id": str(uuid.uuid4()), "username": un, "name": body.name.strip() or un, "role": body.role,
           "active": body.active, "password": hash_password(body.password), "created_at": now_ist().isoformat(timespec="seconds")}
    await db.users.insert_one(dict(doc))
    return public_user(doc)


@api.put("/users/{user_id}", dependencies=AUTH)
async def update_user(user_id: str, body: UserIn):
    u = await db.users.find_one({"id": user_id})
    if not u:
        raise HTTPException(404, "User not found")
    if (body.role != "admin" or not body.active) and u["role"] == "admin" and await active_admins(user_id) == 0:
        raise HTTPException(400, "Keep at least one active admin")
    upd = {"name": body.name.strip() or u["username"], "role": body.role, "active": body.active}
    if body.password:
        if len(body.password) < 6:
            raise HTTPException(400, "Password must be at least 6 characters")
        upd["password"] = hash_password(body.password)
    await db.users.update_one({"id": user_id}, {"$set": upd})
    return public_user(await db.users.find_one({"id": user_id}))


@api.delete("/users/{user_id}", dependencies=AUTH)
async def delete_user(user_id: str):
    u = await db.users.find_one({"id": user_id})
    if not u:
        raise HTTPException(404, "User not found")
    if u["id"] == CURRENT_USER.get()["id"]:
        raise HTTPException(400, "You cannot delete your own login")
    if u["role"] == "admin" and await active_admins(user_id) == 0:
        raise HTTPException(400, "Keep at least one active admin")
    await db.users.delete_one({"id": user_id})
    return {"ok": True}


# ================================================================ helpers
def clean(doc):
    if doc:
        doc.pop("_id", None)
    return doc


def count_sundays(year: int) -> int:
    return sum(1 for m in range(1, 13) for w in calendar.monthcalendar(year, m) if w[6])


def days_in_year(year: int) -> int:
    return 366 if calendar.isleap(year) else 365


def month_days(month: str):
    y, m = map(int, month.split("-"))
    n = calendar.monthrange(y, m)[1]
    return y, m, [date(y, m, d) for d in range(1, n + 1)]


def prev_month(month: str) -> str:
    y, m = map(int, month.split("-"))
    return f"{y - 1}-12" if m == 1 else f"{y}-{m - 1:02d}"


def month_label(month: str) -> str:
    y, m = map(int, month.split("-"))
    return f"{calendar.month_name[m]} {y}"


def fmt_inr(v) -> str:
    v = float(v or 0)
    neg = v < 0
    v = abs(v)
    whole = int(v)
    frac = round(v - whole, 2)
    s = str(whole)
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        head = re.sub(r"(\d)(?=(\d\d)+$)", r"\1,", head)
        s = head + "," + tail
    out = s + (f"{frac:.2f}"[1:] if frac else "")
    return ("-" if neg else "") + "Rs. " + out


STATUS_VALUE = {"P": 1.0, "H": 0.5, "A": 0.0}
STATUS_TEXT = {"P": "Present", "H": "Half Day", "A": "Absent"}


async def get_year_settings(year: int) -> dict:
    s = clean(await db.settings.find_one({"year": year})) or {}
    s.setdefault("year", year)
    s.setdefault("holidays", [])
    s.setdefault("paid_holidays", DEFAULT_PAID_HOLIDAYS)
    return s


def year_calc(settings: dict) -> dict:
    year = settings["year"]
    total = days_in_year(year)
    sundays = count_sundays(year)
    paid = int(settings.get("paid_holidays", DEFAULT_PAID_HOLIDAYS))
    working = total - sundays - paid
    return {"year": year, "days_in_year": total, "sundays": sundays, "paid_holidays": paid,
            "total_off_days": sundays + paid, "working_days": working,
            "avg_working_days_per_month": round(working / 12, 2)}


def daily_rate(monthly_salary: float, working_days: int) -> float:
    return (float(monthly_salary) * 12) / working_days if working_days > 0 else 0.0


# ================================================================ app settings
APP_DEFAULTS = {
    "company_name": "Paragon",
    "interakt_api_key": "",
    "wa_provider": "interakt",            # "interakt" or "bhashsms"
    "bhash_url": "https://bhashsms.com/api/sendmsgutil.php",
    "bhash_user": "hayatbw19",
    "bhash_pass": "",
    "bhash_sender": "BUZWAP",
    "bhash_priority": "wa",
    "bhash_stype": "normal",
    "country_code": "+91",
    "tpl_attendance": "attendance_update",
    "tpl_salary": "salary_slip",
    "tpl_summary": "attendance_summary",
    "tpl_language": "en",
    "attendance_msgs": True,
    "salary_msgs": True,
    "owner_summary": True,
    "owner_numbers": "",
    "summary_time": "20:00",
    "salary_day": 5,
    "salary_time": "10:00",
    "auto_generate": False,  # slips are sent only when the admin clicks Generate
}


async def get_app_settings() -> dict:
    s = clean(await db.app_settings.find_one({"key": "app"})) or {}
    out = {**APP_DEFAULTS, **{k: v for k, v in s.items() if k != "key"}}
    return out


def mask(key: str) -> str:
    return "" if not key else ("•" * 8 + key[-4:])


class AppSettingsIn(BaseModel):
    company_name: str = "Paragon"
    interakt_api_key: Optional[str] = None  # None / masked = keep existing
    wa_provider: str = Field("interakt", pattern=r"^(interakt|bhashsms)$")
    bhash_url: str = "https://bhashsms.com/api/sendmsgutil.php"
    bhash_user: str = ""
    bhash_pass: Optional[str] = None  # None / masked = keep existing
    bhash_sender: str = "BUZWAP"
    bhash_priority: str = "wa"
    bhash_stype: str = "normal"
    country_code: str = "+91"
    tpl_attendance: str = "attendance_update"
    tpl_salary: str = "salary_slip"
    tpl_summary: str = "attendance_summary"
    tpl_language: str = "en"
    attendance_msgs: bool = True
    salary_msgs: bool = True
    owner_summary: bool = True
    owner_numbers: str = ""
    summary_time: str = Field("20:00", pattern=r"^\d{2}:\d{2}$")
    salary_day: int = Field(5, ge=1, le=28)
    salary_time: str = Field("10:00", pattern=r"^\d{2}:\d{2}$")
    auto_generate: bool = False


@api.get("/app-settings", dependencies=AUTH)
async def read_app_settings():
    s = await get_app_settings()
    s["has_api_key"] = bool(s["interakt_api_key"])
    s["interakt_api_key"] = mask(s["interakt_api_key"])
    s["has_bhash_pass"] = bool(s["bhash_pass"])
    s["bhash_pass"] = mask(s["bhash_pass"])
    return s


@api.put("/app-settings", dependencies=AUTH)
async def save_app_settings(body: AppSettingsIn):
    cur = await get_app_settings()
    data = body.model_dump()
    key = (data.pop("interakt_api_key") or "").strip()
    if key and not key.startswith("•"):
        data["interakt_api_key"] = key.removeprefix("Basic ").strip()
    else:
        data["interakt_api_key"] = cur["interakt_api_key"]
    bp = (data.pop("bhash_pass") or "").strip()
    data["bhash_pass"] = bp if bp and not bp.startswith("•") else cur["bhash_pass"]
    for k in ("bhash_url", "bhash_user", "bhash_sender", "bhash_priority", "bhash_stype"):
        data[k] = (data.get(k) or "").strip() or APP_DEFAULTS[k]
    await db.app_settings.update_one({"key": "app"}, {"$set": {**data, "key": "app"}}, upsert=True)
    return await read_app_settings()


# ================================================================ WhatsApp (Interakt)
def split_phone(phone: str, country_code: str):
    digits = re.sub(r"\D", "", phone or "")
    cc = re.sub(r"\D", "", country_code or "91")
    if len(digits) > 10 and digits.startswith(cc):
        digits = digits[len(cc):]
    digits = digits.lstrip("0") if len(digits) > 10 else digits
    return "+" + cc, digits


def bhash_value(v: str) -> str:
    # BhashSMS separates variables with commas: drop thousands commas (15,000 -> 15000), other commas -> space
    v = re.sub(r"(?<=\d),(?=\d)", "", v)
    return re.sub(r"\s*,\s*", " / ", v).strip() or "-"  # "Sunil, Ravi" -> "Sunil / Ravi"


def wa_value(v) -> str:
    # WhatsApp template variables cannot contain new lines / tabs / 4+ spaces
    s = re.sub(r"[\r\n\t]+", " ", str(v if v not in (None, "") else "-"))
    return re.sub(r" {4,}", "   ", s).strip()[:900] or "-"


async def send_template(phone: str, template: str, values: List, kind: str, ref: str = "") -> dict:
    s = await get_app_settings()
    entry = {"id": str(uuid.uuid4()), "at": now_ist().isoformat(timespec="seconds"), "to": phone,
             "kind": kind, "template": template, "ref": ref, "values": [wa_value(v) for v in values]}
    cc, num = split_phone(phone, s["country_code"])
    entry["provider"] = s.get("wa_provider", "interakt")
    if entry["provider"] == "bhashsms":
        if not s["bhash_user"] or not s["bhash_pass"]:
            entry.update(status="skipped", response="BhashSMS user / password not set")
        elif len(num) < 8:
            entry.update(status="failed", response="Invalid phone number")
        else:
            # BhashSMS WhatsApp: text = approved template name, Params = the variables, comma separated
            params = ",".join(bhash_value(v) for v in entry["values"])
            q = {"user": s["bhash_user"], "pass": s["bhash_pass"], "sender": s["bhash_sender"], "phone": num,
                 "text": template, "priority": s["bhash_priority"], "stype": s["bhash_stype"], "Params": params}
            try:
                async with httpx.AsyncClient(timeout=20, follow_redirects=True) as hc:
                    r = await hc.get(s["bhash_url"], params=q)
                body = r.text.strip()[:500]
                bad = re.search(r"invalid|error|fail|insufficient|incorrect|wrong|not\s+(allowed|approved|found)", body, re.I)
                ok = r.status_code < 300 and body and not bad
                entry.update(status="sent" if ok else "failed", response=f"{r.status_code} {body or '(empty reply)'}")
            except Exception as e:  # network errors
                entry.update(status="failed", response=str(e)[:500])
        await db.wa_logs.insert_one(dict(entry))
        return clean(entry)
    if not s["interakt_api_key"]:
        entry.update(status="skipped", response="Interakt API key not set")
    elif len(num) < 8:
        entry.update(status="failed", response="Invalid phone number")
    else:
        payload = {"countryCode": cc, "phoneNumber": num, "callbackData": f"{kind}:{ref}"[:500],
                   "type": "Template",
                   "template": {"name": template, "languageCode": s["tpl_language"] or "en",
                                "bodyValues": entry["values"]}}
        try:
            async with httpx.AsyncClient(timeout=20) as hc:
                r = await hc.post(INTERAKT_URL, json=payload,
                                  headers={"Authorization": f"Basic {s['interakt_api_key']}",
                                           "Content-Type": "application/json"})
            body = r.text[:500]
            ok = r.status_code < 300 and '"result":false' not in body.replace(" ", "")
            entry.update(status="sent" if ok else "failed", response=f"{r.status_code} {body}")
        except Exception as e:  # network errors
            entry.update(status="failed", response=str(e)[:500])
    await db.wa_logs.insert_one(dict(entry))
    return clean(entry)


@api.get("/whatsapp/logs", dependencies=AUTH)
async def wa_logs(limit: int = 100):
    return [clean(x) async for x in db.wa_logs.find().sort("at", -1).limit(min(limit, 500))]


class TestIn(BaseModel):
    phone: str


@api.post("/whatsapp/test", dependencies=AUTH)
async def wa_test(body: TestIn):
    s = await get_app_settings()
    d = now_ist()
    return await send_template(body.phone, s["tpl_attendance"],
                               ["Test Employee", d.strftime("%d %b %Y (%a)"), "Present", s["company_name"]],
                               "test")


# ---------------- attendance notifications: sent at once when Present / Half day / Absent is clicked
async def enqueue_attendance(emp_id: str, d: str):
    s = await get_app_settings()
    if not s["attendance_msgs"]:
        return
    today = now_ist().date()
    if d not in (today.isoformat(), (today - timedelta(days=1)).isoformat()):
        return  # only notify for today / yesterday, not old corrections
    rec = await db.attendance.find_one({"employee_id": emp_id, "date": d})
    emp = await db.employees.find_one({"id": emp_id})
    if not rec or not emp:
        return
    if not emp.get("phone"):
        await db.attendance.update_one({"_id": rec["_id"]}, {"$set": {"notify_error": "No WhatsApp number"}})
        return
    if rec.get("notified_status") == rec["status"]:
        return
    res = await send_template(emp["phone"], s["tpl_attendance"],
                              [emp["name"], date.fromisoformat(d).strftime("%d %b %Y (%a)"), STATUS_TEXT[rec["status"]],
                               s["company_name"]], "attendance", f"{emp_id}:{d}")
    if res["status"] == "sent":
        await db.attendance.update_one({"_id": rec["_id"]}, {"$set": {"notified_status": rec["status"], "notify_error": ""}})
    else:
        await db.attendance.update_one({"_id": rec["_id"]}, {"$set": {"notify_error": str(res.get("response", ""))[:120]}})


async def process_queue(force: bool = False):
    s = await get_app_settings()
    now = now_ist().isoformat()
    items = [x async for x in db.notify_queue.find({} if force else {"due_at": {"$lte": now}})]
    for it in items:
        await db.notify_queue.delete_one({"employee_id": it["employee_id"], "date": it["date"]})
        rec = await db.attendance.find_one({"employee_id": it["employee_id"], "date": it["date"]})
        emp = await db.employees.find_one({"id": it["employee_id"]})
        if not rec or not emp or not emp.get("phone"):
            continue
        if rec.get("notified_status") == rec["status"]:
            continue
        d = date.fromisoformat(it["date"])
        res = await send_template(emp["phone"], s["tpl_attendance"],
                                  [emp["name"], d.strftime("%d %b %Y (%a)"), STATUS_TEXT[rec["status"]],
                                   s["company_name"]], "attendance", f"{emp['id']}:{it['date']}")
        if res["status"] == "sent":
            await db.attendance.update_one({"_id": rec["_id"]}, {"$set": {"notified_status": rec["status"]}})


# ---------------- owner daily summary
async def build_day_summary(d: str) -> dict:
    emps = [clean(e) async for e in db.employees.find({"active": True}).sort("name", 1)]
    recs = {r["employee_id"]: r["status"] async for r in db.attendance.find({"date": d})}
    y = int(d[:4])
    ys = await get_year_settings(y)
    hol = {h["date"]: h.get("name", "") for h in ys["holidays"]}
    out = {"date": d, "total": len(emps), "present": [], "half": [], "absent": [], "not_marked": [],
           "sunday": date.fromisoformat(d).weekday() == 6, "holiday": hol.get(d)}
    for e in emps:
        st = recs.get(e["id"])
        key = {"P": "present", "H": "half", "A": "absent"}.get(st, "not_marked")
        out[key].append(e["name"])
    return out


async def send_owner_summary(d: str) -> List[dict]:
    s = await get_app_settings()
    sm = await build_day_summary(d)
    numbers = [n.strip() for n in re.split(r"[,\n;]", s["owner_numbers"]) if n.strip()]
    absent = ", ".join(sm["absent"]) or "None"
    if sm["not_marked"]:
        absent += f". Not marked: {', '.join(sm['not_marked'])}"
    vals = [date.fromisoformat(d).strftime("%d %b %Y (%a)"), sm["total"], len(sm["present"]), len(sm["half"]),
            len(sm["absent"]), len(sm["not_marked"]), absent, s["company_name"]]
    return [await send_template(n, s["tpl_summary"], vals, "summary", d) for n in numbers]


@api.get("/summary", dependencies=AUTH)
async def day_summary(d: Optional[str] = None):
    return await build_day_summary(d or today_ist())


class SummaryIn(BaseModel):
    date: Optional[str] = None


@api.post("/summary/send", dependencies=AUTH)
async def summary_send(body: SummaryIn):
    res = await send_owner_summary(body.date or today_ist())
    if not res:
        raise HTTPException(400, "Add the admin WhatsApp number in WhatsApp settings first")
    return res


# ================================================================ year settings / holidays
class Holiday(BaseModel):
    date: str
    name: str = ""


class SettingsIn(BaseModel):
    paid_holidays: int = DEFAULT_PAID_HOLIDAYS
    holidays: List[Holiday] = []


@api.get("/settings/{year}", dependencies=AUTH)
async def read_settings(year: int):
    s = await get_year_settings(year)
    return {"settings": s, "calc": year_calc(s)}


@api.put("/settings/{year}", dependencies=AUTH)
async def save_settings(year: int, body: SettingsIn):
    if not 0 <= body.paid_holidays <= 100:
        raise HTTPException(400, "Paid holidays must be between 0 and 100")
    hol = sorted({h.date: h.model_dump() for h in body.holidays if h.date.startswith(str(year))}.values(),
                 key=lambda h: h["date"])
    doc = {"year": year, "paid_holidays": body.paid_holidays, "holidays": hol}
    await db.settings.update_one({"year": year}, {"$set": doc}, upsert=True)
    return {"settings": doc, "calc": year_calc(doc)}


# ================================================================ employees + salary history
class EmployeeIn(BaseModel):
    code: str = ""
    name: str
    phone: str = ""
    designation: str = ""
    salary_type: str = Field("per_day", pattern="^(per_day|fixed)$")
    monthly_salary: float = Field(0, ge=0)
    join_date: str = ""
    active: bool = True


def salary_for(emp: dict, month: str) -> dict:
    hist = sorted(emp.get("salary_history") or [], key=lambda h: h["effective_from"])
    if not hist:
        return {"monthly_salary": emp.get("monthly_salary", 0), "salary_type": emp.get("salary_type", "per_day"),
                "effective_from": ""}
    pick = hist[0]
    for h in hist:
        if h["effective_from"] <= month:
            pick = h
    return pick


async def refresh_current_salary(emp_id: str):
    emp = await db.employees.find_one({"id": emp_id})
    cur = salary_for(emp, now_ist().strftime("%Y-%m"))
    await db.employees.update_one({"id": emp_id}, {"$set": {"monthly_salary": cur["monthly_salary"],
                                                            "salary_type": cur["salary_type"]}})


@api.get("/employees", dependencies=AUTH)
async def list_employees():
    rows = [clean(e) async for e in db.employees.find().sort([("active", -1), ("name", 1)])]
    if not is_admin():
        for e in rows:
            e.pop("monthly_salary", None)
            e.pop("salary_history", None)
    return rows


@api.post("/employees", dependencies=AUTH)
async def add_employee(body: EmployeeIn):
    if not body.name.strip():
        raise HTTPException(400, "Name is required")
    doc = body.model_dump()
    doc["name"] = doc["name"].strip()
    doc["id"] = str(uuid.uuid4())
    eff = (body.join_date or "")[:7] or "2000-01"
    doc["salary_history"] = [{"effective_from": eff, "monthly_salary": body.monthly_salary,
                              "salary_type": body.salary_type, "note": "Joining salary",
                              "at": now_ist().isoformat(timespec="seconds")}]
    await db.employees.insert_one(dict(doc))
    return doc


@api.put("/employees/{emp_id}", dependencies=AUTH)
async def update_employee(emp_id: str, body: EmployeeIn):
    """Edits profile only. Salary changes go through /salary-change (with an effective month)."""
    if not body.name.strip():
        raise HTTPException(400, "Name is required")
    emp = await db.employees.find_one({"id": emp_id})
    if not emp:
        raise HTTPException(404, "Employee not found")
    upd = body.model_dump(exclude={"monthly_salary", "salary_type"})
    upd["name"] = upd["name"].strip()
    if not emp.get("salary_history"):  # legacy record: create history from current values
        upd["salary_history"] = [{"effective_from": "2000-01", "monthly_salary": body.monthly_salary,
                                  "salary_type": body.salary_type, "note": "Opening salary",
                                  "at": now_ist().isoformat(timespec="seconds")}]
        upd["monthly_salary"], upd["salary_type"] = body.monthly_salary, body.salary_type
    await db.employees.update_one({"id": emp_id}, {"$set": upd})
    return clean(await db.employees.find_one({"id": emp_id}))


@api.delete("/employees/{emp_id}", dependencies=AUTH)
async def delete_employee(emp_id: str):
    if await db.slips.find_one({"employee_id": emp_id}):
        raise HTTPException(400, "This employee has salary slips. Mark them Inactive instead of deleting.")
    for c in (db.attendance, db.overrides, db.advances, db.drafts, db.notify_queue):
        await c.delete_many({"employee_id": emp_id})
    await db.employees.delete_one({"id": emp_id})
    return {"ok": True}


class SalaryChangeIn(BaseModel):
    effective_from: str = Field(..., pattern=r"^\d{4}-\d{2}$")
    monthly_salary: float = Field(..., ge=0)
    salary_type: str = Field("per_day", pattern="^(per_day|fixed)$")
    note: str = ""


@api.post("/employees/{emp_id}/salary-change", dependencies=AUTH)
async def salary_change(emp_id: str, body: SalaryChangeIn):
    emp = await db.employees.find_one({"id": emp_id})
    if not emp:
        raise HTTPException(404, "Employee not found")
    hist = [h for h in (emp.get("salary_history") or []) if h["effective_from"] != body.effective_from]
    if not hist and not emp.get("salary_history"):
        hist = [{"effective_from": "2000-01", "monthly_salary": emp.get("monthly_salary", 0),
                 "salary_type": emp.get("salary_type", "per_day"), "note": "Opening salary"}]
    hist.append({**body.model_dump(), "at": now_ist().isoformat(timespec="seconds")})
    hist.sort(key=lambda h: h["effective_from"])
    await db.employees.update_one({"id": emp_id}, {"$set": {"salary_history": hist}})
    await refresh_current_salary(emp_id)
    affected = [s["month"] async for s in db.slips.find({"employee_id": emp_id,
                                                         "month": {"$gte": body.effective_from}})]
    return {"employee": clean(await db.employees.find_one({"id": emp_id})), "generated_slips_affected": affected}


@api.delete("/employees/{emp_id}/salary-change/{effective_from}", dependencies=AUTH)
async def salary_change_delete(emp_id: str, effective_from: str):
    emp = await db.employees.find_one({"id": emp_id})
    hist = emp.get("salary_history") or []
    if len(hist) <= 1:
        raise HTTPException(400, "Cannot remove the only salary entry")
    hist = [h for h in hist if h["effective_from"] != effective_from]
    await db.employees.update_one({"id": emp_id}, {"$set": {"salary_history": hist}})
    await refresh_current_salary(emp_id)
    return clean(await db.employees.find_one({"id": emp_id}))


# ================================================================ attendance
class MarkIn(BaseModel):
    employee_id: str
    date: str
    status: str = ""


class BulkIn(BaseModel):
    month: Optional[str] = None
    status: str = "P"
    employee_ids: List[str] = []
    date: Optional[str] = None
    only_empty: bool = True


class OverrideIn(BaseModel):
    employee_id: str
    month: str
    days: Optional[float] = None


async def set_status(emp_id: str, d: str, status: str):
    if status == "":
        await db.attendance.delete_one({"employee_id": emp_id, "date": d})
        await db.notify_queue.delete_one({"employee_id": emp_id, "date": d})
    else:
        await db.attendance.update_one({"employee_id": emp_id, "date": d}, {"$set": {"status": status}},
                                       upsert=True)
        await enqueue_attendance(emp_id, d)


@api.get("/attendance", dependencies=AUTH)
async def get_attendance(month: str):
    y, m, days = month_days(month)
    settings = await get_year_settings(y)
    hol = {h["date"]: h.get("name", "") for h in settings["holidays"]}
    records: Dict[str, Dict[str, str]] = {}
    async for r in db.attendance.find({"date": {"$regex": f"^{month}-"}}):
        records.setdefault(r["employee_id"], {})[r["date"]] = r["status"]
    overrides = {o["employee_id"]: o["days"] async for o in db.overrides.find({"month": month})}
    locked = [s["employee_id"] async for s in db.slips.find({"month": month})]
    day_info = [{"date": d.isoformat(), "day": d.day, "weekday": d.strftime("%a"),
                 "sunday": d.weekday() == 6, "holiday": hol.get(d.isoformat())} for d in days]
    return {"month": month, "days": day_info, "records": records, "overrides": overrides, "locked": locked}


@api.get("/attendance/day", dependencies=AUTH)
async def get_day(d: str):
    if SERVERLESS:
        await process_queue()  # Today page polls every 20 s, so messages go out while it is open
    recs = {r["employee_id"]: {"status": r["status"], "notified": r.get("notified_status") == r["status"],
                               "error": r.get("notify_error", "") if r.get("notified_status") != r["status"] else ""}
            async for r in db.attendance.find({"date": d})}
    pending = {q["employee_id"] async for q in db.notify_queue.find({"date": d})}
    return {"date": d, "records": recs, "pending": list(pending)}


async def ensure_unlocked(emp_id: str, d: str):
    if await db.slips.find_one({"employee_id": emp_id, "month": d[:7]}):
        raise HTTPException(400, "Salary slip already generated for this month. Cancel the slip to edit attendance.")


@api.put("/attendance", dependencies=AUTH)
async def mark(body: MarkIn):
    if body.status not in ("", "P", "H", "A"):
        raise HTTPException(400, "Status must be P, H or A")
    if body.status and body.date > today_ist():
        raise HTTPException(400, "Attendance can't be marked for a future date")
    await ensure_unlocked(body.employee_id, body.date)
    if not is_admin():
        cur = await db.attendance.find_one({"employee_id": body.employee_id, "date": body.date})
        if cur and cur.get("status"):
            raise HTTPException(403, "Already marked. Only the admin can change it.")
        if not body.status:
            raise HTTPException(403, "Only the admin can clear attendance")
    await set_status(body.employee_id, body.date, body.status)
    return {"ok": True}


@api.post("/attendance/bulk", dependencies=AUTH)
async def bulk_mark(body: BulkIn):
    if not is_admin() and (not body.date or body.status not in ("P", "H", "A") or not body.only_empty):
        raise HTTPException(403, "Accountant can only mark one day at a time")
    if body.status not in ("", "P", "H", "A"):
        raise HTTPException(400, "Status must be P, H or A")
    month = body.month or (body.date or "")[:7]
    y, m, days = month_days(month)
    hol = {h["date"] for h in (await get_year_settings(y))["holidays"]}
    targets = [body.date] if body.date else \
        [d.isoformat() for d in days if d.weekday() != 6 and d.isoformat() not in hol]
    if body.status:  # never mark future dates
        if body.date and body.date > today_ist():
            raise HTTPException(400, "Attendance can't be marked for a future date")
        targets = [t for t in targets if t <= today_ist()]
    ids = body.employee_ids or [e["id"] async for e in db.employees.find({"active": True})]
    locked = {s["employee_id"] async for s in db.slips.find({"month": month})}
    changed = 0
    for eid in ids:
        if eid in locked:
            continue
        existing = {r["date"] async for r in db.attendance.find({"employee_id": eid, "date": {"$in": targets}})}
        for t in targets:
            if body.only_empty and t in existing:
                continue
            await set_status(eid, t, body.status)
            changed += 1
    return {"ok": True, "changed": changed, "skipped_locked": len(locked & set(ids))}


@api.put("/attendance/override", dependencies=AUTH)
async def set_override(body: OverrideIn):
    await ensure_unlocked(body.employee_id, body.month + "-01")
    if body.days is None:
        await db.overrides.delete_one({"employee_id": body.employee_id, "month": body.month})
    else:
        if not 0 <= body.days <= 31:
            raise HTTPException(400, "Days must be between 0 and 31")
        await db.overrides.update_one({"employee_id": body.employee_id, "month": body.month},
                                      {"$set": {"days": body.days}}, upsert=True)
    return {"ok": True}


@api.post("/notifications/flush", dependencies=AUTH)
async def flush_notifications():
    await process_queue(force=True)
    return {"ok": True}


# ================================================================ advances
class AdvanceIn(BaseModel):
    employee_id: str
    date: str
    amount: float = Field(..., gt=0)
    plan: str = Field("monthly", pattern="^(monthly|one_time|manual)$")
    installment: float = Field(0, ge=0)
    start_month: str = Field(..., pattern=r"^\d{4}-\d{2}$")
    note: str = ""


async def advance_status(emp_id: str, exclude_month: Optional[str] = None) -> dict:
    """FIFO-allocate all advance deductions (from generated slips) against advances."""
    advs = [clean(a) async for a in db.advances.find({"employee_id": emp_id}).sort([("date", 1), ("created_at", 1)])]
    q = {"employee_id": emp_id}
    if exclude_month:
        q["month"] = {"$ne": exclude_month}
    recovered = 0.0
    async for s in db.slips.find(q):
        recovered += float(s.get("advance_deduction", 0) or 0)
    left = recovered
    for a in advs:
        r = min(a["amount"], left)
        left -= r
        a["recovered"] = round(r, 2)
        a["remaining"] = round(a["amount"] - r, 2)
    total = sum(a["amount"] for a in advs)
    return {"advances": advs, "total": round(total, 2), "recovered": round(recovered, 2),
            "outstanding": round(max(total - recovered, 0), 2)}


def suggested_deduction(advs: List[dict], month: str) -> float:
    s = 0.0
    for a in advs:
        if a["remaining"] <= 0 or a["start_month"] > month:
            continue
        if a["plan"] == "one_time":
            s += a["remaining"]
        elif a["plan"] == "monthly":
            s += min(a["installment"] or a["remaining"], a["remaining"])
    return round(s, 2)


@api.get("/advances", dependencies=AUTH)
async def list_advances(employee_id: Optional[str] = None):
    emps = {e["id"]: e["name"] async for e in db.employees.find()}
    ids = [employee_id] if employee_id else list({a["employee_id"] async for a in db.advances.find()})
    out = []
    for eid in ids:
        st = await advance_status(eid)
        for a in st["advances"]:
            a["employee_name"] = emps.get(eid, "?")
            out.append(a)
    out.sort(key=lambda a: a["date"], reverse=True)
    return out


@api.post("/advances", dependencies=AUTH)
async def add_advance(body: AdvanceIn):
    if not await db.employees.find_one({"id": body.employee_id}):
        raise HTTPException(404, "Employee not found")
    if body.plan == "monthly" and body.installment <= 0:
        raise HTTPException(400, "Enter the monthly deduction amount")
    doc = {**body.model_dump(), "id": str(uuid.uuid4()), "created_at": now_ist().isoformat(timespec="seconds")}
    await db.advances.insert_one(dict(doc))
    return doc


@api.put("/advances/{adv_id}", dependencies=AUTH)
async def update_advance(adv_id: str, body: AdvanceIn):
    res = await db.advances.update_one({"id": adv_id}, {"$set": body.model_dump()})
    if not res.matched_count:
        raise HTTPException(404, "Advance not found")
    return {"ok": True}


@api.delete("/advances/{adv_id}", dependencies=AUTH)
async def delete_advance(adv_id: str):
    a = await db.advances.find_one({"id": adv_id})
    if not a:
        raise HTTPException(404, "Advance not found")
    st = await advance_status(a["employee_id"])
    mine = next((x for x in st["advances"] if x["id"] == adv_id), None)
    if mine and mine["recovered"] > 0:
        raise HTTPException(400, "Part of this advance is already recovered in salary slips. Edit it instead.")
    await db.advances.delete_one({"id": adv_id})
    return {"ok": True}


# ================================================================ payroll / salary slips
async def compute_row(emp: dict, month: str, calc: dict, att: Dict[str, str], override) -> dict:
    sal = salary_for(emp, month)
    present = sum(1 for s in att.values() if s == "P")
    half = sum(1 for s in att.values() if s == "H")
    absent = sum(1 for s in att.values() if s == "A")
    marked = sum(STATUS_VALUE.get(s, 0) for s in att.values())
    days_worked = float(override) if override is not None else marked
    rate = daily_rate(sal["monthly_salary"], calc["working_days"])
    if sal["salary_type"] == "fixed":
        gross, rate_show = round(float(sal["monthly_salary"])), None
    else:
        gross, rate_show = round(days_worked * rate), round(rate, 2)
    adv = await advance_status(emp["id"], exclude_month=month)
    suggested = min(suggested_deduction(adv["advances"], month), gross, adv["outstanding"])
    return {"employee_id": emp["id"], "name": emp["name"], "code": emp.get("code", ""),
            "designation": emp.get("designation", ""), "phone": emp.get("phone", ""),
            "salary_type": sal["salary_type"], "monthly_salary": sal["monthly_salary"],
            "salary_effective_from": sal.get("effective_from", ""),
            "present": present, "half_days": half, "absent": absent, "marked_days": marked,
            "override": override, "days_worked": days_worked, "daily_rate": rate_show, "gross": gross,
            "advance_outstanding": adv["outstanding"], "suggested_deduction": round(suggested, 2)}


async def month_context(month: str):
    y, m, days = month_days(month)
    ys = await get_year_settings(y)
    calc = year_calc(ys)
    hol = {h["date"] for h in ys["holidays"]}
    working_in_month = sum(1 for d in days if d.weekday() != 6 and d.isoformat() not in hol)
    att: Dict[str, Dict[str, str]] = {}
    async for r in db.attendance.find({"date": {"$regex": f"^{month}-"}}):
        att.setdefault(r["employee_id"], {})[r["date"]] = r["status"]
    overrides = {}  # "Days override" was removed: salary always uses the marked days
    return calc, working_in_month, att, overrides


@api.get("/payroll", dependencies=AUTH)
async def payroll(month: str):
    calc, wim, att, overrides = await month_context(month)
    slips = {s["employee_id"]: clean(s) async for s in db.slips.find({"month": month})}
    drafts = {d["employee_id"]: d["advance_deduction"] async for d in db.drafts.find({"month": month})}
    rows = []
    async for e in db.employees.find().sort("name", 1):
        e = clean(e)
        if e["id"] in slips:
            rows.append({**slips[e["id"]], "generated": True})
            continue
        if not e.get("active", True) and e["id"] not in att and e["id"] not in overrides:
            continue
        r = await compute_row(e, month, calc, att.get(e["id"], {}), overrides.get(e["id"]))
        r["advance_deduction"] = drafts.get(e["id"], r["suggested_deduction"])
        r["net"] = round(r["gross"] - r["advance_deduction"], 2)
        r["generated"] = False
        rows.append(r)
    s = await get_app_settings()
    y, m = map(int, month.split("-"))
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
    return {"month": month, "calc": calc, "working_days_in_month": wim, "rows": rows,
            "company_name": s["company_name"], "salary_date": f"{ny}-{nm:02d}-{int(s['salary_day']):02d}",
            "total_gross": sum(r["gross"] for r in rows), "total_deduction": sum(r["advance_deduction"] for r in rows),
            "total_net": round(sum(r["net"] for r in rows), 2)}


class DraftIn(BaseModel):
    month: str
    employee_id: str
    advance_deduction: Optional[float] = None  # None = back to suggested


@api.put("/payroll/draft", dependencies=AUTH)
async def save_draft(body: DraftIn):
    if body.advance_deduction is None:
        await db.drafts.delete_one({"employee_id": body.employee_id, "month": body.month})
    else:
        if body.advance_deduction < 0:
            raise HTTPException(400, "Deduction cannot be negative")
        await db.drafts.update_one({"employee_id": body.employee_id, "month": body.month},
                                   {"$set": {"advance_deduction": body.advance_deduction}}, upsert=True)
    return {"ok": True}


class GenerateIn(BaseModel):
    month: str
    employee_ids: List[str] = []  # empty = everyone not yet generated
    deductions: Dict[str, float] = {}
    send_whatsapp: bool = True


async def generate_slips(month: str, employee_ids: List[str], deductions: Dict[str, float], send: bool,
                         skip_empty: bool = False, bg: Optional[BackgroundTasks] = None) -> dict:
    calc, wim, att, overrides = await month_context(month)
    done = {s["employee_id"] async for s in db.slips.find({"month": month})}
    drafts = {d["employee_id"]: d["advance_deduction"] async for d in db.drafts.find({"month": month})}
    created, errors = [], []
    async for e in db.employees.find().sort("name", 1):
        e = clean(e)
        if e["id"] in done or (employee_ids and e["id"] not in employee_ids):
            continue
        if not employee_ids and not e.get("active", True) and e["id"] not in att and e["id"] not in overrides:
            continue
        r = await compute_row(e, month, calc, att.get(e["id"], {}), overrides.get(e["id"]))
        if skip_empty and r["salary_type"] != "fixed" and r["days_worked"] == 0:
            continue  # auto-run: nobody with zero attendance gets a zero slip
        ded = deductions.get(e["id"], drafts.get(e["id"], r["suggested_deduction"]))
        ded = round(float(ded or 0), 2)
        if ded < 0 or ded > r["advance_outstanding"] + 0.001 or ded > r["gross"]:
            errors.append(f"{e['name']}: advance deduction must be between 0 and "
                          f"{min(r['advance_outstanding'], r['gross'])}")
            continue
        slip = {**r, "id": str(uuid.uuid4()), "month": month, "period": f"{month}-01 to {month_days(month)[2][-1].isoformat()}",
                "calc": calc, "advance_deduction": ded, "net": round(r["gross"] - ded, 2),
                "advance_balance_after": round(r["advance_outstanding"] - ded, 2),
                "generated_at": now_ist().isoformat(timespec="seconds"), "wa_status": "not sent"}
        await db.slips.insert_one(dict(slip))
        await db.drafts.delete_one({"employee_id": e["id"], "month": month})
        created.append(slip["id"])
    if send and created:
        if bg is not None:
            bg.add_task(send_slip_messages, created)
        else:
            await send_slip_messages(created)
    return {"created": len(created), "errors": errors}


def slip_values(sl: dict, company: str) -> List:
    c = sl["calc"]
    fixed = sl["salary_type"] == "fixed"
    return [
        sl["name"], month_label(sl["month"]), fmt_inr(sl["monthly_salary"]),
        "Fixed monthly salary" if fixed else f"{c['days_in_year']} - {c['sundays']} Sundays - {c['paid_holidays']} holidays = {c['working_days']} days",
        "-" if fixed else fmt_inr(sl["daily_rate"]),
        f"{sl['days_worked']:g}", sl["present"], sl["half_days"], sl["absent"],
        fmt_inr(sl["gross"]), fmt_inr(sl["advance_deduction"]), fmt_inr(sl["net"]),
        fmt_inr(sl["advance_balance_after"]), company,
    ]


async def send_slip_messages(slip_ids: List[str]):
    s = await get_app_settings()
    if not s["salary_msgs"]:
        return
    for sid in slip_ids:
        sl = await db.slips.find_one({"id": sid})
        if not sl:
            continue
        if not sl.get("phone"):
            await db.slips.update_one({"id": sid}, {"$set": {"wa_status": "no phone"}})
            continue
        res = await send_template(sl["phone"], s["tpl_salary"], slip_values(sl, s["company_name"]), "salary", sid)
        await db.slips.update_one({"id": sid}, {"$set": {"wa_status": res["status"], "wa_at": res["at"]}})


@api.post("/payroll/generate", dependencies=AUTH)
async def generate(body: GenerateIn, bg: BackgroundTasks):
    # serverless: send inside the request (background work may be frozen after the response)
    return await generate_slips(body.month, body.employee_ids, body.deductions, body.send_whatsapp,
                                bg=None if SERVERLESS else bg)


@api.post("/slips/{slip_id}/send", dependencies=AUTH)
async def resend_slip(slip_id: str):
    s = await get_app_settings()
    sl = await db.slips.find_one({"id": slip_id})
    if not sl:
        raise HTTPException(404, "Slip not found")
    if not sl.get("phone"):
        raise HTTPException(400, "Employee has no phone number on this slip")
    res = await send_template(sl["phone"], s["tpl_salary"], slip_values(sl, s["company_name"]), "salary", slip_id)
    await db.slips.update_one({"id": slip_id}, {"$set": {"wa_status": res["status"], "wa_at": res["at"]}})
    return res


@api.delete("/slips/{slip_id}", dependencies=AUTH)
async def cancel_slip(slip_id: str):
    sl = await db.slips.find_one({"id": slip_id})
    if not sl:
        raise HTTPException(404, "Slip not found")
    later = await db.slips.find_one({"employee_id": sl["employee_id"], "month": {"$gt": sl["month"]}})
    if later:
        raise HTTPException(400, f"Cancel the later slip ({later['month']}) first")
    await db.slips.delete_one({"id": slip_id})
    # keep the admin's chosen deduction as draft so regenerating gives the same amount
    await db.drafts.update_one({"employee_id": sl["employee_id"], "month": sl["month"]},
                               {"$set": {"advance_deduction": sl["advance_deduction"]}}, upsert=True)
    return {"ok": True}


# ================================================================ ledger
@api.get("/employees/{emp_id}/ledger", dependencies=AUTH)
async def ledger(emp_id: str):
    emp = clean(await db.employees.find_one({"id": emp_id}))
    if not emp:
        raise HTTPException(404, "Employee not found")
    adv = await advance_status(emp_id)
    slips = [clean(s) async for s in db.slips.find({"employee_id": emp_id}).sort("month", 1)]
    events = []
    for a in adv["advances"]:
        events.append({"date": a["date"], "sort": a["date"] + "0", "type": "advance",
                       "text": f"Advance given{' - ' + a['note'] if a.get('note') else ''}",
                       "advance_given": a["amount"]})
    for s in slips:
        d = s["generated_at"][:10]
        events.append({"date": d, "sort": d + "1" + s["month"], "type": "salary", "month": s["month"],
                       "text": f"Salary for {month_label(s['month'])} ({s['days_worked']:g} days)",
                       "gross": s["gross"], "advance_deduction": s["advance_deduction"], "net": s["net"],
                       "slip_id": s["id"]})
    events.sort(key=lambda e: e["sort"])
    bal = 0.0
    for e in events:
        bal += e.get("advance_given", 0) - e.get("advance_deduction", 0)
        e["advance_balance"] = round(bal, 2)
        e.pop("sort")
    return {"employee": emp, "advances": adv, "slips": slips, "entries": events,
            "totals": {"gross": sum(s["gross"] for s in slips), "net": round(sum(s["net"] for s in slips), 2),
                       "advance_given": adv["total"], "advance_recovered": adv["recovered"],
                       "advance_outstanding": adv["outstanding"]}}


# ================================================================ Google Drive backup
GOOGLE_AUTH_URL = os.environ.get("GOOGLE_AUTH_URL", "https://accounts.google.com/o/oauth2/v2/auth")
GOOGLE_TOKEN_URL = os.environ.get("GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token")
GOOGLE_API = os.environ.get("GOOGLE_API", "https://www.googleapis.com").rstrip("/")
GDRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file openid email"
GDRIVE_FOLDER = "Paragon Attendance Backups"
BACKUP_COLLECTIONS = ["users", "settings", "app_settings", "employees", "attendance", "overrides", "advances",
                      "slips", "drafts", "wa_logs", "jobs"]
GDRIVE_DEFAULTS = {
    "client_id": os.environ.get("GDRIVE_CLIENT_ID", ""), "client_secret": os.environ.get("GDRIVE_CLIENT_SECRET", ""),
    "refresh_token": "", "email": "", "folder_id": "",
    "backup_on_exit": True, "daily_backup": True, "daily_backup_time": "21:00", "keep_backups": 30,
    "last_backup_at": "", "last_status": "", "last_message": "", "last_file": "", "last_hash": "",
}
_backup_lock = asyncio.Lock()


async def get_gdrive() -> dict:
    s = clean(await db.app_settings.find_one({"key": "gdrive"})) or {}
    s.pop("key", None)
    return {**GDRIVE_DEFAULTS, **{k: v for k, v in s.items() if v not in (None,) and (v != "" or k not in ("client_id", "client_secret"))}}


async def save_gdrive(**kw):
    await db.app_settings.update_one({"key": "gdrive"}, {"$set": {**kw, "key": "gdrive"}}, upsert=True)


def gdrive_public(g: dict) -> dict:
    return {"connected": bool(g["refresh_token"]), "email": g["email"], "has_client": bool(g["client_id"] and g["client_secret"]),
            "client_id": g["client_id"], "client_secret": mask(g["client_secret"]),
            "backup_on_exit": g["backup_on_exit"], "daily_backup": g["daily_backup"],
            "daily_backup_time": g["daily_backup_time"], "keep_backups": g["keep_backups"],
            "last_backup_at": g["last_backup_at"], "last_status": g["last_status"],
            "last_message": g["last_message"], "last_file": g["last_file"]}


def sign_state(data: str) -> str:
    sig = hmac.new(SECRET_KEY.encode(), data.encode(), hashlib.sha256).hexdigest()[:32]
    return base64.urlsafe_b64encode(f"{data}|{sig}".encode()).decode().rstrip("=")


def read_state(state: str) -> Optional[str]:
    try:
        raw = base64.urlsafe_b64decode(state + "=" * (-len(state) % 4)).decode()
        data, sig = raw.rsplit("|", 1)
    except Exception:
        return None
    good = hmac.new(SECRET_KEY.encode(), data.encode(), hashlib.sha256).hexdigest()[:32]
    return data if hmac.compare_digest(sig, good) else None


async def google_access_token(g: dict) -> str:
    if not g["refresh_token"]:
        raise HTTPException(400, "Google Drive is not connected")
    async with httpx.AsyncClient(timeout=30) as hc:
        r = await hc.post(GOOGLE_TOKEN_URL, data={"client_id": g["client_id"], "client_secret": g["client_secret"],
                                                  "refresh_token": g["refresh_token"], "grant_type": "refresh_token"})
    if r.status_code != 200:
        if "invalid_grant" in r.text:
            await save_gdrive(refresh_token="", last_status="failed",
                              last_message="Google access was removed or expired. Please connect Google Drive again.")
            raise HTTPException(400, "Google access expired. Please connect Google Drive again.")
        raise HTTPException(502, f"Google token error: {r.text[:200]}")
    return r.json()["access_token"]


async def gdrive_folder(hc: httpx.AsyncClient, token: str, g: dict) -> str:
    H = {"Authorization": f"Bearer {token}"}
    if g["folder_id"]:
        r = await hc.get(f"{GOOGLE_API}/drive/v3/files/{g['folder_id']}", headers=H, params={"fields": "id,trashed"})
        if r.status_code == 200 and not r.json().get("trashed"):
            return g["folder_id"]
    q = f"name='{GDRIVE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
    r = await hc.get(f"{GOOGLE_API}/drive/v3/files", headers=H, params={"q": q, "fields": "files(id)"})
    files = r.json().get("files", []) if r.status_code == 200 else []
    if files:
        fid = files[0]["id"]
    else:
        r = await hc.post(f"{GOOGLE_API}/drive/v3/files", headers=H, params={"fields": "id"},
                          json={"name": GDRIVE_FOLDER, "mimeType": "application/vnd.google-apps.folder"})
        if r.status_code >= 300:
            raise HTTPException(502, f"Could not create Drive folder: {r.text[:200]}")
        fid = r.json()["id"]
    await save_gdrive(folder_id=fid)
    return fid


async def export_data() -> dict:
    out = {"app": "paragon-attendance", "version": 1, "at": now_ist().isoformat(timespec="seconds")}
    for c in BACKUP_COLLECTIONS:
        q = {"key": {"$ne": "gdrive"}} if c == "app_settings" else {}
        out[c] = [clean(d) async for d in db[c].find(q)]
    return out


async def run_drive_backup(reason: str, force: bool = False) -> dict:
    async with _backup_lock:
        g = await get_gdrive()
        if not g["refresh_token"]:
            return {"status": "skipped", "message": "Google Drive is not connected"}
        data = await export_data()
        body = json.dumps({k: v for k, v in data.items() if k != "at"}, sort_keys=True, default=str)
        digest = hashlib.sha256(body.encode()).hexdigest()
        if not force and digest == g["last_hash"]:
            return {"status": "unchanged", "message": "No changes since the last backup"}
        try:
            token = await google_access_token(g)
            async with httpx.AsyncClient(timeout=120) as hc:
                folder = await gdrive_folder(hc, token, g)
                name = f"Paragon-Backup-{now_ist().strftime('%Y-%m-%d_%H%M')}.json.gz"
                payload = gzip.compress(json.dumps(data, default=str).encode())
                boundary = "paragon" + uuid.uuid4().hex
                meta = json.dumps({"name": name, "parents": [folder], "description": f"Paragon Attendance backup ({reason})"})
                mp = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n"
                      f"--{boundary}\r\nContent-Type: application/gzip\r\n\r\n").encode() + payload + f"\r\n--{boundary}--\r\n".encode()
                r = await hc.post(f"{GOOGLE_API}/upload/drive/v3/files",
                                  params={"uploadType": "multipart", "fields": "id,name,size,createdTime,webViewLink"},
                                  headers={"Authorization": f"Bearer {token}", "Content-Type": f"multipart/related; boundary={boundary}"},
                                  content=mp)
                if r.status_code >= 300:
                    raise HTTPException(502, f"Upload failed: {r.text[:200]}")
                f = r.json()
                # keep only the newest N backups
                lr = await hc.get(f"{GOOGLE_API}/drive/v3/files", headers={"Authorization": f"Bearer {token}"},
                                  params={"q": f"'{folder}' in parents and trashed=false", "orderBy": "createdTime desc",
                                          "fields": "files(id,name)", "pageSize": 1000})
                olds = [x for x in lr.json().get("files", []) if x["name"].startswith("Paragon-Backup-")] if lr.status_code == 200 else []
                for x in olds[max(int(g["keep_backups"] or 30), 1):]:
                    await hc.delete(f"{GOOGLE_API}/drive/v3/files/{x['id']}", headers={"Authorization": f"Bearer {token}"})
            await save_gdrive(last_backup_at=now_ist().isoformat(timespec="seconds"), last_status="ok",
                              last_message=f"Backed up ({reason})", last_file=f["name"], last_hash=digest)
            return {"status": "ok", "file": f, "message": f"Saved {f['name']} to Google Drive"}
        except HTTPException as e:
            await save_gdrive(last_status="failed", last_message=str(e.detail)[:300],
                              last_backup_at=now_ist().isoformat(timespec="seconds"))
            return {"status": "failed", "message": str(e.detail)}
        except Exception as e:
            await save_gdrive(last_status="failed", last_message=str(e)[:300],
                              last_backup_at=now_ist().isoformat(timespec="seconds"))
            return {"status": "failed", "message": str(e)[:300]}


class GdriveSettingsIn(BaseModel):
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    backup_on_exit: bool = True
    daily_backup: bool = True
    daily_backup_time: str = Field("21:00", pattern=r"^\d{2}:\d{2}$")
    keep_backups: int = Field(30, ge=1, le=365)


@api.get("/gdrive/status", dependencies=AUTH)
async def gdrive_status():
    g = gdrive_public(await get_gdrive())
    if not is_admin():
        g = {k: g[k] for k in ("connected", "backup_on_exit", "last_backup_at", "last_status")}
    return g


@api.put("/gdrive/settings", dependencies=AUTH)
async def gdrive_settings(body: GdriveSettingsIn):
    upd = body.model_dump(exclude={"client_id", "client_secret"})
    if body.client_id is not None:
        upd["client_id"] = body.client_id.strip()
    if body.client_secret and not body.client_secret.startswith("•"):
        upd["client_secret"] = body.client_secret.strip()
    await save_gdrive(**upd)
    return gdrive_public(await get_gdrive())


@api.get("/gdrive/auth-url", dependencies=AUTH)
async def gdrive_auth_url(api_base: str, return_to: str):
    g = await get_gdrive()
    if not (g["client_id"] and g["client_secret"]):
        raise HTTPException(400, "Enter the Google OAuth Client ID and Client Secret first")
    redirect_uri = api_base.rstrip("/") + "/api/gdrive/callback"
    state = sign_state(f"{int(time.time()) + 900}|{redirect_uri}|{return_to}")
    from urllib.parse import urlencode
    url = GOOGLE_AUTH_URL + "?" + urlencode({"client_id": g["client_id"], "redirect_uri": redirect_uri,
                                             "response_type": "code", "scope": GDRIVE_SCOPE, "access_type": "offline",
                                             "prompt": "consent", "include_granted_scopes": "true", "state": state})
    return {"url": url, "redirect_uri": redirect_uri}


@api.get("/gdrive/callback")
async def gdrive_callback(state: str = "", code: str = "", error: str = ""):
    data = read_state(state)
    if not data:
        return HTMLResponse("<h3>Invalid or expired link. Please try Connect Google Drive again.</h3>", 400)
    exp, redirect_uri, return_to = data.split("|", 2)
    back = return_to.rstrip("/") + "/?gdrive="
    if int(exp) < time.time():
        return RedirectResponse(back + "expired")
    if error or not code:
        return RedirectResponse(back + "cancelled")
    g = await get_gdrive()
    async with httpx.AsyncClient(timeout=30) as hc:
        r = await hc.post(GOOGLE_TOKEN_URL, data={"code": code, "client_id": g["client_id"], "client_secret": g["client_secret"],
                                                  "redirect_uri": redirect_uri, "grant_type": "authorization_code"})
    if r.status_code != 200:
        log.warning("gdrive token exchange failed: %s", r.text[:300])
        return RedirectResponse(back + "failed")
    tok = r.json()
    email = ""
    try:
        part = tok.get("id_token", "").split(".")[1]
        email = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))).get("email", "")
    except Exception:
        pass
    upd = {"email": email, "folder_id": "", "last_hash": ""}
    if tok.get("refresh_token"):
        upd["refresh_token"] = tok["refresh_token"]
    elif not g["refresh_token"]:
        return RedirectResponse(back + "norefresh")
    await save_gdrive(**upd)
    return RedirectResponse(back + "connected")


@api.post("/gdrive/disconnect", dependencies=AUTH)
async def gdrive_disconnect():
    g = await get_gdrive()
    if g["refresh_token"]:
        try:
            async with httpx.AsyncClient(timeout=15) as hc:
                await hc.post("https://oauth2.googleapis.com/revoke", data={"token": g["refresh_token"]})
        except Exception:
            pass
    await save_gdrive(refresh_token="", email="", folder_id="", last_hash="")
    return gdrive_public(await get_gdrive())


class BackupIn(BaseModel):
    reason: str = "manual"
    force: bool = False


@api.post("/gdrive/backup", dependencies=AUTH)
async def gdrive_backup(body: BackupIn):
    return await run_drive_backup(body.reason[:30], force=body.force and is_admin())


@api.post("/gdrive/backup-beacon")
async def gdrive_backup_beacon(request: Request, bg: BackgroundTasks):
    """Called by the browser (navigator.sendBeacon) when the app window is closed."""
    try:
        token = json.loads((await request.body()).decode() or "{}").get("token", "")
    except Exception:
        token = ""
    if not check_token(token):
        raise HTTPException(401, "Not logged in")
    g = await get_gdrive()
    if g["refresh_token"] and g["backup_on_exit"]:
        if SERVERLESS:
            await run_drive_backup("app closed")
        else:
            bg.add_task(run_drive_backup, "app closed")
    return {"ok": True}


@api.get("/gdrive/backups", dependencies=AUTH)
async def gdrive_backups():
    g = await get_gdrive()
    token = await google_access_token(g)
    async with httpx.AsyncClient(timeout=60) as hc:
        folder = await gdrive_folder(hc, token, g)
        r = await hc.get(f"{GOOGLE_API}/drive/v3/files", headers={"Authorization": f"Bearer {token}"},
                         params={"q": f"'{folder}' in parents and trashed=false", "orderBy": "createdTime desc",
                                 "fields": "files(id,name,size,createdTime,webViewLink)", "pageSize": 200})
    if r.status_code >= 300:
        raise HTTPException(502, f"Could not list backups: {r.text[:200]}")
    return [f for f in r.json().get("files", []) if f["name"].startswith("Paragon-Backup-")]


class RestoreIn(BaseModel):
    file_id: str


async def import_data(data: dict):
    if data.get("app") != "paragon-attendance":
        raise HTTPException(400, "This is not a Paragon Attendance backup file")
    for c in BACKUP_COLLECTIONS:
        rows = data.get(c)
        if not isinstance(rows, list):
            continue
        if c == "app_settings":
            await db.app_settings.delete_many({"key": {"$ne": "gdrive"}})
            rows = [r for r in rows if r.get("key") != "gdrive"]
        else:
            await db[c].delete_many({})
        if rows:
            await db[c].insert_many([dict(r) for r in rows])
    await db.notify_queue.delete_many({})


@api.post("/gdrive/restore", dependencies=AUTH)
async def gdrive_restore(body: RestoreIn):
    g = await get_gdrive()
    token = await google_access_token(g)
    async with httpx.AsyncClient(timeout=120) as hc:
        r = await hc.get(f"{GOOGLE_API}/drive/v3/files/{body.file_id}", params={"alt": "media"},
                         headers={"Authorization": f"Bearer {token}"})
    if r.status_code >= 300:
        raise HTTPException(502, f"Could not download backup: {r.text[:200]}")
    raw = r.content
    try:
        data = json.loads(gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw)
    except Exception:
        raise HTTPException(400, "Backup file is damaged")
    await run_drive_backup("before restore", force=True)  # safety copy of current data
    await import_data(data)
    await save_gdrive(last_hash="")
    return {"ok": True, "restored_from": data.get("at")}


@api.get("/backup", dependencies=AUTH)
async def backup_download():
    return await export_data()


# ================================================================ misc
@api.get("/calc")
async def calc_preview(monthly_salary: float, days: float, year: int, paid_holidays: int = DEFAULT_PAID_HOLIDAYS):
    c = year_calc({"year": year, "paid_holidays": paid_holidays})
    r = daily_rate(monthly_salary, c["working_days"])
    return {**c, "annual_salary": monthly_salary * 12, "daily_rate": round(r, 2), "days": days,
            "month_salary": round(days * r)}


@api.get("/")
async def root():
    return {"app": "Paragon Attendance & Payroll", "status": "ok", "time_ist": now_ist().isoformat()}


# ================================================================ scheduler
async def run_once_per(key: str) -> bool:
    if await db.jobs.find_one({"key": key}):
        return False
    await db.jobs.insert_one({"key": key, "at": now_ist().isoformat()})
    return True


async def scheduler_tick(daily: bool = False):
    """daily=True: the once-a-day Vercel cron - run every job that is due today regardless of its set time."""
    await process_queue()
    s = await get_app_settings()
    now = now_ist()
    hm = "23:59" if daily else now.strftime("%H:%M")
    today = now.date().isoformat()
    if s["owner_summary"] and s["owner_numbers"].strip() and hm >= s["summary_time"]:
        if await run_once_per(f"summary-{today}"):
            await send_owner_summary(today)
    g = await get_gdrive()
    if g["refresh_token"] and g["daily_backup"] and hm >= g["daily_backup_time"]:
        if await run_once_per(f"gbackup-{today}"):
            await run_drive_backup("daily")
    if s["auto_generate"] and now.day == int(s["salary_day"]) and hm >= s["salary_time"]:
        last = prev_month(now.strftime("%Y-%m"))
        if await run_once_per(f"salary-{last}"):
            await generate_slips(last, [], {}, True, skip_empty=True)


async def scheduler_loop():
    while True:
        try:
            await scheduler_tick()
        except Exception:
            log.exception("scheduler error")
        await asyncio.sleep(20)


def _cron_ok(request: Request, key: str) -> bool:
    if not CRON_SECRET:
        return False
    auth = request.headers.get("authorization", "")
    return hmac.compare_digest(auth, f"Bearer {CRON_SECRET}") or hmac.compare_digest(key or "", CRON_SECRET)


@api.get("/cron/tick")
async def cron_tick(request: Request, key: str = ""):
    """Call every 1-5 minutes from a free external scheduler (e.g. cron-job.org) for on-time messages."""
    if not _cron_ok(request, key):
        raise HTTPException(403, "Bad or missing cron key (set CRON_SECRET)")
    await scheduler_tick()
    return {"ok": True, "time_ist": now_ist().isoformat(timespec="seconds")}


@api.get("/cron/daily")
async def cron_daily(request: Request, key: str = ""):
    """Vercel Cron (Hobby plan allows once a day): runs everything due today."""
    if not _cron_ok(request, key):
        raise HTTPException(403, "Bad or missing cron key (set CRON_SECRET)")
    await scheduler_tick(daily=True)
    return {"ok": True, "time_ist": now_ist().isoformat(timespec="seconds")}


class RestoreFileIn(BaseModel):
    data: dict


@api.post("/restore-file", dependencies=AUTH)
async def restore_file(body: RestoreFileIn):
    """Restore from an uploaded backup file (e.g. moving from the office PC to the online version)."""
    g = await get_gdrive()
    if g["refresh_token"]:
        await run_drive_backup("before restore", force=True)
    await import_data(body.data)
    await save_gdrive(last_hash="")
    await ensure_admin_user()
    return {"ok": True, "restored_from": body.data.get("at"),
            "counts": {c: len(body.data.get(c) or []) for c in ("employees", "attendance", "slips", "advances", "users")}}


@app.on_event("startup")
async def startup():
    if not DISABLE_SCHEDULER:
        asyncio.create_task(scheduler_loop())


app.include_router(api)


# ---------- Live sync: every saved change bumps a counter; open screens poll /api/sync ----------
SYNC_SKIP = ("/api/login", "/api/sync", "/api/gdrive/backup-beacon")


@app.middleware("http")
async def live_sync_middleware(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/api"):
        response.headers["Cache-Control"] = "no-store"
        if request.method in ("POST", "PUT", "PATCH", "DELETE") and response.status_code < 400 \
                and not path.startswith(SYNC_SKIP):
            try:
                await db.sync_state.update_one(
                    {"_id": "changes"}, {"$inc": {"v": 1}, "$set": {"at": datetime.now(timezone.utc).isoformat()}},
                    upsert=True)
            except Exception as e:  # never fail a save because of the sync counter
                logging.warning("sync counter: %s", e)
    return response


@app.get("/api/sync")
async def sync_version(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer ") or not token_user(authorization[7:]):
        raise HTTPException(401, "Not logged in")
    doc = await db.sync_state.find_one({"_id": "changes"}) or {}
    return {"v": doc.get("v", 0), "at": doc.get("at")}
app.add_middleware(CORSMiddleware, allow_credentials=True,
                   allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
                   allow_methods=["*"], allow_headers=["*"])


@app.on_event("shutdown")
async def shutdown():
    if isinstance(db, _LazyDB):
        db.close()

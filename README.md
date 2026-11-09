# Paragon Attendance & Payroll (v2)

React frontend + FastAPI backend + MongoDB. WhatsApp through Interakt.

## Salary rule
- x1 Working days in the year = days in year (365, or 366 in a leap year) − actual Sundays (counted from the calendar) − paid holidays (24 by default)
- x2 Yearly salary = monthly salary × 12
- x3 Daily salary = x2 ÷ x1
- x4 Month salary = days worked × x3 (half day = 0.5)
- **Fixed** employees always get their full monthly salary.
- Salary month = 1st to last day of the month. Salary day = 5th of the next month (can be changed).

Example for 2026: 365 − 52 − 24 = 289 · ₹15,000 × 12 = ₹1,80,000 · ÷ 289 = ₹622.84/day · 26 days = ₹16,194

## Screens
- **Today**: admin marks each employee Present, Half day or Absent. About a minute later the employee gets a WhatsApp message; a quick correction only sends the final status. Buttons: "Mark unmarked as Present", "Send pending messages now" and "Send owner summary".
- **Attendance**: monthly grid, a "Days override" box to type days worked directly, and a 🔒 lock once the slip is generated.
- **Salary**: the month's salary sheet. The advance deduction can be edited for each employee before generating. "Generate slips" saves them and sends each slip on WhatsApp with full details and the calculation. You can view or print each slip, send it again, or cancel it (this unlocks attendance so you can regenerate). Excel (CSV) export is included.
- **Advances**: give an advance with a recovery plan (fixed amount every month, full amount in one month, or manual) and a start month. Recovery is FIFO across that employee's advances.
- **Employees**: add or edit employees. **Change salary** applies a new salary from a chosen month, earlier months keep the old salary, and salary history is kept. **Ledger** shows advances given, salary generated, deductions, net paid and the running advance balance.
- **Holidays & Year**: number of paid holidays, holiday dates (★ on the sheet) and a salary calculator.
- **WhatsApp**: Interakt API key, template code names, on/off switches, salary day and time, owner numbers, daily summary time, a test send, and a message log.

## Google Drive backup
- **Backup** tab: enter a Google OAuth Client ID and Secret (type Web application, scope `drive.file`), then click Connect Google Drive. The step-by-step guide is inside the app.
- Redirect URI to register: `<backend URL>/api/gdrive/callback`. For example, use `https://your-domain/api/gdrive/callback` on Emergent, or `http://localhost:8001/api/gdrive/callback` on Windows.
- Backups are saved as `Paragon-Backup-YYYY-MM-DD_HHMM.json.gz` in the Drive folder "Paragon Attendance Backups":
  - on **Backup & Exit**
  - when the app window is closed
  - every day at the set time
  - with "Back up now"
- A backup is skipped when nothing has changed. Only the last N backups are kept. You can restore any backup from the list, and a safety backup is taken first.
- Optional env vars `GDRIVE_CLIENT_ID` / `GDRIVE_CLIENT_SECRET` (FastAPI), or `google_client_id` / `google_client_secret` in config.json (Windows), pre-fill the client.
- In the consent screen, set the app to **In production**. Otherwise Google expires the connection after 7 days.

## Automatic jobs (backend, India time)
- Every 20 seconds it sends queued attendance messages.
- Every day at the summary time (default 8:00 PM) it sends owners a WhatsApp with Present, Half day, Absent and Not marked counts, plus the names of absent employees.
- On the salary day at the salary time (default 5th, 10:00 AM) it generates last month's slips that aren't generated yet, using the deductions saved on the Salary page, and sends them. Employees with zero attendance are skipped.

The backend must run as an always-on server (Emergent, a VPS or a PC). Serverless hosting such as Vercel functions cannot run these timers.

## Interakt setup
1. In Interakt → Settings → Developer Setting, copy the Secret Key and paste it in the app under WhatsApp → Interakt API key.
2. Create 3 templates (category **Utility**, language **English**). Their exact texts are on the WhatsApp page with a Copy button: attendance (4 variables), salary slip (14), owner summary (8).
3. After approval, enter each template's code name and send a test message.

## Windows / LAN edition (.exe)
See `desktop/` — `desktop/server` is a Node.js port of the same API with a built-in file database (no MongoDB/Python needed). `desktop/installer/build.sh` builds `Paragon-Attendance-Setup.exe` with NSIS (bundles the official Windows Node.js runtime, registers a start-up task, opens port 8001 in the firewall). Details for users: `desktop/installer/README.txt`.

## Run locally
```
cd backend && cp .env.example .env && pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8001
cd frontend && cp .env.example .env && npm install && npm start
```
Default login: `admin` / `paragon@123` (change it in backend/.env).

## Emergent deploy prompt (no testing)
> Deploy this project exactly as provided. Do NOT run any tests and do not rewrite or refactor the code. Just copy the files, install dependencies, build and deploy.
> - Backend: copy `backend/server.py` and `backend/requirements.txt` to /app/backend and run `pip install -r requirements.txt` (adds httpx). Keep the existing MONGO_URL, DB_NAME and CORS_ORIGINS in backend/.env, and add ADMIN_USERNAME=admin, ADMIN_PASSWORD=<choose>, SECRET_KEY=<long random string>. The backend starts its own background scheduler on startup, so keep a single always-on backend process.
> - Frontend: replace /app/frontend/src with the provided `frontend/src` folder (App.js, App.css, api.js, index.js, components.js, pages/*) and /app/frontend/public/index.html. Keep the existing REACT_APP_BACKEND_URL in frontend/.env. If the existing frontend uses craco or yarn, keep that setup; the app only needs react and react-dom.
> - All backend routes are under /api. Restart backend and frontend, then deploy.

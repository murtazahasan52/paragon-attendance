# Deploy Paragon Attendance on Vercel (free) + MongoDB Atlas (free)

One Vercel project serves the web app **and** the API (`/api/*`, Python FastAPI).
Data lives in MongoDB Atlas. The Android app just opens your Vercel address.

## 1. MongoDB Atlas (5 min)
1. Go to cloud.mongodb.com, create a **Free (M0)** cluster, and pick the Mumbai region (closest to Nagpur).
2. **Database Access** → Add user, e.g. `paragon`, with a strong password and **Read and write to any database**.
3. **Network Access** → Add IP → **Allow access from anywhere (0.0.0.0/0)**. Vercel has no fixed IP.
4. **Connect → Drivers** → copy the string, e.g.
   `mongodb+srv://paragon:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`

## 2. Put the code on GitHub
Upload this whole folder to a new **private** GitHub repository.
The `desktop/` and `android/` folders are ignored by Vercel through `.vercelignore`.

## 3. Vercel
1. vercel.com → **Add New → Project** → import the repository.
2. Framework preset: **Other**. Leave the build settings alone, because `vercel.json` sets them.
3. **Environment Variables**:

| Name | Value |
|---|---|
| `MONGO_URL` | the Atlas string from step 1 |
| `DB_NAME` | `paragon_attendance` |
| `ADMIN_USERNAME` | `admin` |
| `ADMIN_PASSWORD` | first admin password (change it later in the app) |
| `SECRET_KEY` | any long random text, 40+ characters |
| `CRON_SECRET` | another long random text, used by the scheduled jobs |
| `GDRIVE_CLIENT_ID` / `GDRIVE_CLIENT_SECRET` | optional, to pre-fill Google Drive backup |

4. **Deploy**. You get e.g. `https://paragon-attendance.vercel.app`. Open it and log in.

## 4. WhatsApp messages: how they go out
- **Attendance:** sent the moment the admin or accountant taps Present, Half day or Absent, for today or yesterday. No setup needed.
- **Daily summary to the admin:** Vercel sends it once a day between 8 and 9 PM IST (the free plan's built-in daily job). Enter the admin's WhatsApp number under **WhatsApp → Admin WhatsApp number(s)**.
- **Salary slips:** sent only when the admin clicks **Generate** on the Salary page, after checking each advance deduction.
- **Advances:** the admin decides how much to deduct each month on the Salary page. A fixed monthly plan is still available if wanted.

## 5. Google Drive backup (optional)
In Google Cloud, add the redirect URI `https://YOUR-APP.vercel.app/api/gdrive/callback`, then **Backup → Connect Google Drive**.
Because it's https, you can connect from any computer or phone.

## 6. Android app
The app has the server address **https://paragon-attendance.vercel.app** built in, so it opens straight to the username and password screen.
- Name your Vercel project **paragon-attendance**, so the address matches.
- If Vercel gives a different address (for example `paragon-attendance-xyz.vercel.app`), send it and the app is rebuilt in a minute. Or rebuild it yourself with `SERVER_URL=https://your-address ./android/build.sh`.
- If the address is ever wrong, the "can't reach" screen has a small **Server settings** button to type it.

## 7. Move data from the office PC (optional)
On the PC version, go to **This PC → Download backup**.
On Vercel, go to **Backup → Restore from a backup file** and choose that file.

## Logins
- **Admin:** everything, including **Setup → Logins** to add people.
- **Accountant:** only Today and Attendance. They can mark Present, Half day or Absent, and can't see salaries.

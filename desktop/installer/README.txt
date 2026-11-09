PARAGON ATTENDANCE & PAYROLL - Windows / LAN edition
=====================================================

OPEN THE APP
  On this PC:        double-click "Paragon Attendance" on the desktop
                     (or open http://localhost:8001 in Chrome/Edge)
  Other laptops/phones on the same Wi-Fi or LAN:
                     http://<this-PC-IP>:8001
                     The exact address is shown on the "This PC" tab in the app.

LOGIN
  Username: admin
  Password: paragon@123   -> change it on the "This PC" tab.

HOW IT RUNS
  - The server starts by itself whenever this PC is switched on (even before
    anyone logs in) through Windows Task Scheduler ("Paragon Attendance Server").
  - Keep this PC switched on during office hours. Other laptops, the 8 PM owner
    summary and the salary-day WhatsApp messages all need it running.
  - Ask your network person to give this PC a fixed IP address (DHCP reservation
    in the router), so the LAN address does not change.
  - Port 8001 is opened in Windows Firewall by the installer.

YOUR DATA
  C:\ProgramData\ParagonAttendance\
     db\           all data (employees, attendance, advances, slips)
     config.json   port and admin login
     server.log    server log
  Use "Download backup" on the "This PC" tab regularly and keep the file safe.
  To move to a new PC: install there, stop the server, copy the db folder over,
  then use Start menu > Paragon Attendance > Restart Server.

GOOGLE DRIVE BACKUP
  Backup tab > enter your Google OAuth Client ID + Secret > Connect Google Drive.
  Do this ON THIS PC (http://localhost:8001) - Google only allows localhost/https.
  Redirect URI to add in Google Cloud: http://localhost:8001/api/gdrive/callback
  After that the app backs up to Drive folder "Paragon Attendance Backups":
   - when anyone clicks "Backup & Exit" or closes the app window
   - every day at the set time (default 9 PM)
  Restore any backup from the Backup tab.

IF THE APP DOES NOT OPEN
  Start menu > Paragon Attendance > Restart Server
  (right-click > Run as administrator if asked).
  If you changed the port in config.json, open the new port in the firewall.

UNINSTALL
  Windows Settings > Apps > Paragon Attendance > Uninstall.
  You will be asked whether to keep the data (choose Keep).

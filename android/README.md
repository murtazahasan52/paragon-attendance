# Paragon Attendance - Android app (.apk)

A small native app (about 30 KB) that opens the Paragon web app full-screen.

- First launch: enter the server address
  - office Wi-Fi: `192.168.1.10:8001`, as shown on the "This PC" tab
  - online: `paragon.yourdomain.com`
- The app checks the server and remembers the address. To change it later, use ⚙ in the top bar, "Change server address" on the login screen, or the offline screen.
- Excel/CSV and backup downloads are saved to **Downloads/Paragon**.
- Print and slip buttons open Android printing, which can also **Save as PDF**.
- Google Drive and other outside links open in the phone's browser.
- Works on Android 7 (API 24) and newer. Plain http on the LAN is allowed.

## Build (Linux, no Gradle)
Needs JDK 17+ and Android build-tools 35 + platform android-35 (see `build.sh`).
```
./build.sh   # -> Paragon-Attendance.apk
```
## IMPORTANT: signing key
`paragon-release.jks` (password `paragon@hayat`, alias `paragon`) signs the app.
Keep it safe and **use the same file for every future version**. Android only installs an update
over the old app when the signature matches. If the key is lost, users must uninstall and reinstall.
For each new version, raise `android:versionCode` (and `versionName`) in AndroidManifest.xml and in build.sh.

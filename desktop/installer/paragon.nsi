; Paragon Attendance & Payroll - Windows installer (NSIS 3)
; Build:  makensis paragon.nsi   (expects ./stage prepared by build.sh)

Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"

!define APPNAME   "Paragon Attendance"
!define COMPANY   "Hayat Enterprises"
!define VERSION   "1.3.0"
!define PORT      "8001"
!define TASKNAME  "Paragon Attendance Server"
!define SERVEREXE "paragon-server.exe"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ParagonAttendance"

Name "${APPNAME}"
OutFile "Paragon-Attendance-Setup.exe"
InstallDir "$PROGRAMFILES64\${APPNAME}"
InstallDirRegKey HKLM "${UNINSTKEY}" "InstallLocation"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
BrandingText "${APPNAME} ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "CompanyName" "${COMPANY}"
VIAddVersionKey "FileDescription" "${APPNAME} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "${COMPANY}"

!define MUI_ICON "paragon.ico"
!define MUI_UNICON "paragon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Paragon Attendance & Payroll"
!define MUI_WELCOMEPAGE_TEXT "This installs Paragon Attendance & Payroll on this PC.$\r$\n$\r$\nEverything it needs is included, so you don't have to install anything else.$\r$\n$\r$\n- The app runs in the background whenever this PC is on.$\r$\n- Other laptops and phones on the same Wi-Fi or LAN can open it in a browser.$\r$\n- WhatsApp messages (Interakt) are sent from this PC.$\r$\n$\r$\nClick Next to continue."
!define MUI_FINISHPAGE_TITLE "Paragon Attendance is ready"
!define MUI_FINISHPAGE_TEXT "The app is running on this PC at http://localhost:${PORT}$\r$\n$\r$\nTo open it on other laptops or phones, use the address shown on the 'This PC' tab in the app (for example http://192.168.1.10:${PORT}).$\r$\n$\r$\nDefault login: admin / paragon@123. Please change the password on the 'This PC' tab."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open Paragon Attendance now"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenApp

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Paragon Attendance needs 64-bit Windows 10 or 11."
    Abort
  ${EndIf}
  SetRegView 64
FunctionEnd

Function OpenApp
  ExecShell "open" "http://localhost:${PORT}"
FunctionEnd

!macro StopServer
  nsExec::Exec 'schtasks /End /TN "${TASKNAME}"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM ${SERVEREXE}'
  Pop $0
  Sleep 1000
!macroend

Section "Install"
  SetShellVarContext all
  !insertmacro StopServer

  SetOutPath "$INSTDIR"
  File "paragon.ico"
  File "stage\README.txt"
  SetOutPath "$INSTDIR\bin"
  File "stage\bin\${SERVEREXE}"
  SetOutPath "$INSTDIR\app"
  RMDir /r "$INSTDIR\app\public"
  File /r "stage\app\*.*"

  ; ---- background server: Windows Task Scheduler, runs as SYSTEM at start-up,
  ;      no time limit, works on battery, re-checked every 5 minutes
  FileOpen $1 "$INSTDIR\server-task.xml" w
  FileWriteUTF16LE /BOM $1 '<?xml version="1.0" encoding="UTF-16"?>$\r$\n'
  FileWriteUTF16LE $1 '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">$\r$\n'
  FileWriteUTF16LE $1 '<RegistrationInfo><Description>Runs the Paragon Attendance and Payroll server in the background.</Description></RegistrationInfo>$\r$\n'
  FileWriteUTF16LE $1 '<Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger>'
  FileWriteUTF16LE $1 '<TimeTrigger><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>$\r$\n'
  FileWriteUTF16LE $1 '<Principals><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>$\r$\n'
  FileWriteUTF16LE $1 '<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>6</Priority><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>$\r$\n'
  FileWriteUTF16LE $1 '<Actions Context="Author"><Exec><Command>$INSTDIR\bin\${SERVEREXE}</Command><Arguments>"$INSTDIR\app\server\index.js"</Arguments><WorkingDirectory>$INSTDIR\app\server</WorkingDirectory></Exec></Actions>$\r$\n'
  FileWriteUTF16LE $1 '</Task>$\r$\n'
  FileClose $1

  DetailPrint "Registering background server…"
  nsExec::ExecToLog 'schtasks /Create /TN "${TASKNAME}" /XML "$INSTDIR\server-task.xml" /F'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "Could not register the background server task (code $0).$\r$\nThe app will be started now, but may not start automatically after a restart."
  ${EndIf}

  ; ---- allow other laptops on the LAN to connect
  DetailPrint "Opening port ${PORT} in Windows Firewall…"
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${APPNAME}"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${APPNAME}" dir=in action=allow protocol=TCP localport=${PORT} profile=any'
  Pop $0

  ; ---- start it now
  nsExec::ExecToLog 'schtasks /Run /TN "${TASKNAME}"'
  Pop $0
  Sleep 3000

  ; ---- shortcuts (open the app in the default browser)
  WriteINIStr "$INSTDIR\Paragon Attendance.url" "InternetShortcut" "URL" "http://localhost:${PORT}"
  WriteINIStr "$INSTDIR\Paragon Attendance.url" "InternetShortcut" "IconFile" "$INSTDIR\paragon.ico"
  WriteINIStr "$INSTDIR\Paragon Attendance.url" "InternetShortcut" "IconIndex" "0"
  CopyFiles /SILENT "$INSTDIR\Paragon Attendance.url" "$DESKTOP\Paragon Attendance.url"
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CopyFiles /SILENT "$INSTDIR\Paragon Attendance.url" "$SMPROGRAMS\${APPNAME}\Paragon Attendance.url"

  ; restart helper (needs admin)
  FileOpen $1 "$INSTDIR\Restart Server.cmd" w
  FileWrite $1 '@echo off$\r$\nnet session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -FilePath $\'%~f0$\' -Verb RunAs" & exit /b)$\r$\necho Restarting Paragon Attendance server...$\r$\nschtasks /End /TN "${TASKNAME}" >nul 2>&1$\r$\ntaskkill /F /T /IM ${SERVEREXE} >nul 2>&1$\r$\ntimeout /t 2 >nul$\r$\nschtasks /Run /TN "${TASKNAME}"$\r$\ntimeout /t 3 >nul$\r$\nstart "" http://localhost:${PORT}$\r$\n'
  FileClose $1
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Restart Server.lnk" "$INSTDIR\Restart Server.cmd" "" "$INSTDIR\paragon.ico"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Data folder.lnk" "$APPDATA\ParagonAttendance"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Uninstall.lnk" "$INSTDIR\Uninstall.exe"

  ; ---- uninstall info
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTKEY}" "Publisher" "${COMPANY}"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\paragon.ico"
  WriteRegStr HKLM "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoRepair" 1
SectionEnd

Function un.onInit
  SetRegView 64
FunctionEnd

Section "Uninstall"
  SetShellVarContext all
  !insertmacro StopServer
  nsExec::Exec 'schtasks /Delete /TN "${TASKNAME}" /F'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${APPNAME}"'
  Pop $0
  Delete "$DESKTOP\Paragon Attendance.url"
  RMDir /r "$SMPROGRAMS\${APPNAME}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${UNINSTKEY}"
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also DELETE all attendance, salary and employee data?$\r$\n$\r$\nChoose No to keep the data (recommended), so it is still there if you install again." IDNO keep
    RMDir /r "$APPDATA\ParagonAttendance"
  keep:
SectionEnd

; ============================================================
; SecurePrint — NSIS Custom Installer Script
; This runs during installation to register:
;   1. "Print with SecurePrint" right-click context menu for ALL files
;   2. File associations for the "printto" verb
;   3. Auto-start on Windows login (scheduled task for every user, restarts the blocker if stopped)
;   4. USB printer blocking via registry
;   5. Remove legacy firewall rules that block network printers
; ============================================================

!macro customInstall
  ; ─── 1. Add "Print with SecurePrint" to right-click context menu ───
  ; This appears when you right-click ANY file in Windows Explorer
  WriteRegStr HKCR "*\shell\SecurePrint" "" "Print with SecurePrint"
  WriteRegStr HKCR "*\shell\SecurePrint" "Icon" "$INSTDIR\SecurePrint.exe,0"
  WriteRegStr HKCR "*\shell\SecurePrint" "Position" "Top"
  WriteRegStr HKCR "*\shell\SecurePrint\command" "" '"$INSTDIR\SecurePrint.exe" "--print-file=%1"'

  ; ─── 2. Register "Print with SecurePrint" for specific file types ───

  ; PDF files
  WriteRegStr HKCR "SystemFileAssociations\.pdf\shell\SecurePrint" "" "Print with SecurePrint"
  WriteRegStr HKCR "SystemFileAssociations\.pdf\shell\SecurePrint" "Icon" "$INSTDIR\SecurePrint.exe,0"
  WriteRegStr HKCR "SystemFileAssociations\.pdf\shell\SecurePrint\command" "" '"$INSTDIR\SecurePrint.exe" "--print-file=%1"'

  ; Word documents
  WriteRegStr HKCR "SystemFileAssociations\.docx\shell\SecurePrint" "" "Print with SecurePrint"
  WriteRegStr HKCR "SystemFileAssociations\.docx\shell\SecurePrint" "Icon" "$INSTDIR\SecurePrint.exe,0"
  WriteRegStr HKCR "SystemFileAssociations\.docx\shell\SecurePrint\command" "" '"$INSTDIR\SecurePrint.exe" "--print-file=%1"'

  WriteRegStr HKCR "SystemFileAssociations\.doc\shell\SecurePrint" "" "Print with SecurePrint"
  WriteRegStr HKCR "SystemFileAssociations\.doc\shell\SecurePrint" "Icon" "$INSTDIR\SecurePrint.exe,0"
  WriteRegStr HKCR "SystemFileAssociations\.doc\shell\SecurePrint\command" "" '"$INSTDIR\SecurePrint.exe" "--print-file=%1"'

  ; Excel spreadsheets
  WriteRegStr HKCR "SystemFileAssociations\.xlsx\shell\SecurePrint" "" "Print with SecurePrint"
  WriteRegStr HKCR "SystemFileAssociations\.xlsx\shell\SecurePrint" "Icon" "$INSTDIR\SecurePrint.exe,0"
  WriteRegStr HKCR "SystemFileAssociations\.xlsx\shell\SecurePrint\command" "" '"$INSTDIR\SecurePrint.exe" "--print-file=%1"'

  WriteRegStr HKCR "SystemFileAssociations\.xls\shell\SecurePrint" "" "Print with SecurePrint"
  WriteRegStr HKCR "SystemFileAssociations\.xls\shell\SecurePrint" "Icon" "$INSTDIR\SecurePrint.exe,0"
  WriteRegStr HKCR "SystemFileAssociations\.xls\shell\SecurePrint\command" "" '"$INSTDIR\SecurePrint.exe" "--print-file=%1"'

  ; PowerPoint presentations
  WriteRegStr HKCR "SystemFileAssociations\.pptx\shell\SecurePrint" "" "Print with SecurePrint"
  WriteRegStr HKCR "SystemFileAssociations\.pptx\shell\SecurePrint" "Icon" "$INSTDIR\SecurePrint.exe,0"
  WriteRegStr HKCR "SystemFileAssociations\.pptx\shell\SecurePrint\command" "" '"$INSTDIR\SecurePrint.exe" "--print-file=%1"'

  WriteRegStr HKCR "SystemFileAssociations\.ppt\shell\SecurePrint" "" "Print with SecurePrint"
  WriteRegStr HKCR "SystemFileAssociations\.ppt\shell\SecurePrint" "Icon" "$INSTDIR\SecurePrint.exe,0"
  WriteRegStr HKCR "SystemFileAssociations\.ppt\shell\SecurePrint\command" "" '"$INSTDIR\SecurePrint.exe" "--print-file=%1"'

  ; RTF documents
  WriteRegStr HKCR "SystemFileAssociations\.rtf\shell\SecurePrint" "" "Print with SecurePrint"
  WriteRegStr HKCR "SystemFileAssociations\.rtf\shell\SecurePrint" "Icon" "$INSTDIR\SecurePrint.exe,0"
  WriteRegStr HKCR "SystemFileAssociations\.rtf\shell\SecurePrint\command" "" '"$INSTDIR\SecurePrint.exe" "--print-file=%1"'

  ; Text files
  WriteRegStr HKCR "SystemFileAssociations\.txt\shell\SecurePrint" "" "Print with SecurePrint"
  WriteRegStr HKCR "SystemFileAssociations\.txt\shell\SecurePrint" "Icon" "$INSTDIR\SecurePrint.exe,0"
  WriteRegStr HKCR "SystemFileAssociations\.txt\shell\SecurePrint\command" "" '"$INSTDIR\SecurePrint.exe" "--print-file=%1"'

  WriteRegStr HKCR "SystemFileAssociations\.csv\shell\SecurePrint" "" "Print with SecurePrint"
  WriteRegStr HKCR "SystemFileAssociations\.csv\shell\SecurePrint" "Icon" "$INSTDIR\SecurePrint.exe,0"
  WriteRegStr HKCR "SystemFileAssociations\.csv\shell\SecurePrint\command" "" '"$INSTDIR\SecurePrint.exe" "--print-file=%1"'

  ; Image files
  WriteRegStr HKCR "SystemFileAssociations\.jpg\shell\SecurePrint" "" "Print with SecurePrint"
  WriteRegStr HKCR "SystemFileAssociations\.jpg\shell\SecurePrint" "Icon" "$INSTDIR\SecurePrint.exe,0"
  WriteRegStr HKCR "SystemFileAssociations\.jpg\shell\SecurePrint\command" "" '"$INSTDIR\SecurePrint.exe" "--print-file=%1"'

  WriteRegStr HKCR "SystemFileAssociations\.jpeg\shell\SecurePrint" "" "Print with SecurePrint"
  WriteRegStr HKCR "SystemFileAssociations\.jpeg\shell\SecurePrint" "Icon" "$INSTDIR\SecurePrint.exe,0"
  WriteRegStr HKCR "SystemFileAssociations\.jpeg\shell\SecurePrint\command" "" '"$INSTDIR\SecurePrint.exe" "--print-file=%1"'

  WriteRegStr HKCR "SystemFileAssociations\.png\shell\SecurePrint" "" "Print with SecurePrint"
  WriteRegStr HKCR "SystemFileAssociations\.png\shell\SecurePrint" "Icon" "$INSTDIR\SecurePrint.exe,0"
  WriteRegStr HKCR "SystemFileAssociations\.png\shell\SecurePrint\command" "" '"$INSTDIR\SecurePrint.exe" "--print-file=%1"'

  WriteRegStr HKCR "SystemFileAssociations\.bmp\shell\SecurePrint" "" "Print with SecurePrint"
  WriteRegStr HKCR "SystemFileAssociations\.bmp\shell\SecurePrint" "Icon" "$INSTDIR\SecurePrint.exe,0"
  WriteRegStr HKCR "SystemFileAssociations\.bmp\shell\SecurePrint\command" "" '"$INSTDIR\SecurePrint.exe" "--print-file=%1"'

  WriteRegStr HKCR "SystemFileAssociations\.gif\shell\SecurePrint" "" "Print with SecurePrint"
  WriteRegStr HKCR "SystemFileAssociations\.gif\shell\SecurePrint" "Icon" "$INSTDIR\SecurePrint.exe,0"
  WriteRegStr HKCR "SystemFileAssociations\.gif\shell\SecurePrint\command" "" '"$INSTDIR\SecurePrint.exe" "--print-file=%1"'

  WriteRegStr HKCR "SystemFileAssociations\.tiff\shell\SecurePrint" "" "Print with SecurePrint"
  WriteRegStr HKCR "SystemFileAssociations\.tiff\shell\SecurePrint" "Icon" "$INSTDIR\SecurePrint.exe,0"
  WriteRegStr HKCR "SystemFileAssociations\.tiff\shell\SecurePrint\command" "" '"$INSTDIR\SecurePrint.exe" "--print-file=%1"'

  ; ─── 3. Auto-start SecurePrint on Windows login (background mode) ───
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SecurePrint" '"$INSTDIR\SecurePrint.exe" --background'

  ; ─── 4. Remove USB printer restrictions left by older SecurePrint versions ───
  ; Restore the Windows USB printer and storage drivers to their normal demand-start state.
  WriteRegDWORD HKLM "SYSTEM\CurrentControlSet\Services\usbprint" "Start" 3
  WriteRegDWORD HKLM "SYSTEM\CurrentControlSet\Services\USBSTOR" "Start" 3
  ; Remove only the SecurePrint USB printer-class restriction value, if present.
  ReadRegStr $0 HKLM "SOFTWARE\Policies\Microsoft\Windows\DeviceInstall\Restrictions\DenyDeviceClasses" "1"
  StrCmp $0 "{28d78fad-5a12-11d1-ae5b-0000f803a8c2}" 0 +2
    DeleteRegValue HKLM "SOFTWARE\Policies\Microsoft\Windows\DeviceInstall\Restrictions\DenyDeviceClasses" "1"

  ; ─── 5. Remove legacy rules that also block ordinary network-printer traffic ───
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="SecurePrint-Block-RAW-9100"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="SecurePrint-Block-LPR-515"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="SecurePrint-Block-IPP-631"'

  ; ─── 5b. Keep the blocker running: scheduled task for EVERY user ───
  ; Starts SecurePrint in background mode (no window, no SecurePrint login needed) at every Windows
  ; logon, and again every 5 minutes if it was stopped. A task is used because Windows silently
  ; skips administrator-level programs listed in the normal "Run" start-up list.
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$a = New-ScheduledTaskAction -Execute '$INSTDIR\SecurePrint.exe' -Argument '--background'; $$t1 = New-ScheduledTaskTrigger -AtLogOn; $$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650); $$p = New-ScheduledTaskPrincipal -GroupId 'BUILTIN\Users' -RunLevel Highest; $$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0); Register-ScheduledTask -TaskName 'SecurePrint Enforcer' -Action $$a -Trigger @($$t1,$$t2) -Principal $$p -Settings $$s -Force"`

  ; ─── 6. Refresh Windows Explorer to show context menu immediately ───
  nsExec::ExecToLog 'ie4uinit.exe -show'

!macroend

; ============================================================
; Uninstall — Clean up everything
; ============================================================

!macro customUnInstall
  ; ─── Remove context menu entries ───
  DeleteRegKey HKCR "*\shell\SecurePrint"
  DeleteRegKey HKCR "SystemFileAssociations\.pdf\shell\SecurePrint"
  DeleteRegKey HKCR "SystemFileAssociations\.docx\shell\SecurePrint"
  DeleteRegKey HKCR "SystemFileAssociations\.doc\shell\SecurePrint"
  DeleteRegKey HKCR "SystemFileAssociations\.xlsx\shell\SecurePrint"
  DeleteRegKey HKCR "SystemFileAssociations\.xls\shell\SecurePrint"
  DeleteRegKey HKCR "SystemFileAssociations\.pptx\shell\SecurePrint"
  DeleteRegKey HKCR "SystemFileAssociations\.ppt\shell\SecurePrint"
  DeleteRegKey HKCR "SystemFileAssociations\.rtf\shell\SecurePrint"
  DeleteRegKey HKCR "SystemFileAssociations\.txt\shell\SecurePrint"
  DeleteRegKey HKCR "SystemFileAssociations\.csv\shell\SecurePrint"
  DeleteRegKey HKCR "SystemFileAssociations\.jpg\shell\SecurePrint"
  DeleteRegKey HKCR "SystemFileAssociations\.jpeg\shell\SecurePrint"
  DeleteRegKey HKCR "SystemFileAssociations\.png\shell\SecurePrint"
  DeleteRegKey HKCR "SystemFileAssociations\.bmp\shell\SecurePrint"
  DeleteRegKey HKCR "SystemFileAssociations\.gif\shell\SecurePrint"
  DeleteRegKey HKCR "SystemFileAssociations\.tiff\shell\SecurePrint"

  ; ─── Remove auto-start ───
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SecurePrint"

  ; ─── Restore USB printer and storage drivers ───
  WriteRegDWORD HKLM "SYSTEM\CurrentControlSet\Services\usbprint" "Start" 3
  WriteRegDWORD HKLM "SYSTEM\CurrentControlSet\Services\USBSTOR" "Start" 3
  ReadRegStr $0 HKLM "SOFTWARE\Policies\Microsoft\Windows\DeviceInstall\Restrictions\DenyDeviceClasses" "1"
  StrCmp $0 "{28d78fad-5a12-11d1-ae5b-0000f803a8c2}" 0 +2
    DeleteRegValue HKLM "SOFTWARE\Policies\Microsoft\Windows\DeviceInstall\Restrictions\DenyDeviceClasses" "1"

  ; ─── Remove the logon/watchdog scheduled task ───
  nsExec::ExecToLog 'schtasks /delete /tn "SecurePrint Enforcer" /f'

  ; ─── Remove firewall rules ───
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="SecurePrint-Block-RAW-9100"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="SecurePrint-Block-LPR-515"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="SecurePrint-Block-IPP-631"'

!macroend

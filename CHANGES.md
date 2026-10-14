# SecurePrint — loophole fixes (version 1.0.1)

## What was fixed

| # | Loophole | Fix | Where |
|---|----------|-----|-------|
| 1 | Cancel happened after the job had started (a job could print first) | Every new job is **paused inside the running watcher** the moment Windows reports it. The app then resumes SecurePrint's own jobs and deletes everything else. The slow cancel is kept only as a backup. | `print-enforcer.js` |
| 2 | Approval matched by partial document name | SecurePrint prints a **private copy with a random, unguessable name**. The approval is the **exact** name, for **one printer**, for **at most 3 jobs**, for **60 seconds**. No "contains" matching. | `print-enforcer.js`, `main.js` |
| 3 | Virtual-printer skip could be tricked by renaming a printer | Skipped by **port and driver**, not by name. | `print-enforcer.js` |
| 4 | Blocking only worked if the app happened to be running | Installer creates a **scheduled task for every user**: starts SecurePrint in background mode at logon and **every 5 minutes** if it was stopped. Closing the window no longer stops blocking. Background relaunches never pop up a window. | `installer.nsh`, `main.js` |
| 5 | App was "administrator only", so it could silently fail to start for standard users | App manifest is now `asInvoker`. The scheduled task runs with the highest rights each user has. (The installer still asks for admin.) | `package.json` |
| 6 | A held job could be resumed by hand in the Windows print queue | The watcher **re-holds** any job it was holding that gets resumed by hand, and the app deletes it. | `print-enforcer.js` |
| 7 | New printers had up to 30 seconds without protection | Printer list is refreshed every **5 seconds**. | `print-enforcer.js` |
| 8 | Protection could fail silently | The app tells the user when the monitor cannot start (3 failures in a row). If the monitor's command channel is silent it restarts in the other launch mode. | `print-enforcer.js`, `main.js` |
| 9 | Blocked attempts were never recorded | Saved locally, sent to the server (audit log, action `print_blocked`) when a user signs in. | `blocked-attempt-queue.js`, `main.js`, `printController.js`, `routes/print.js` |
| 10 | Monitor script was written to the temp folder and run from there | Script now travels **inside the command** (compressed), so no file exists to tamper with. A script file is used only as an automatic fallback. | `print-enforcer.js` |
| 11 | Launch command was too long for Windows (`-EncodedCommand`) | Fixed (your `-File` change was right); the inline command is now about 18 KB, limit 32 KB. | `print-enforcer.js` |
| 12 | Firewall rules (not needed for USB printers; the app's own rule was wrong) | Removed; old rules are cleaned up on start, install and uninstall. | `print-enforcer.js`, `installer.nsh` |
| 13 | A page range outside the document counted as ALL pages | Now counts 0 and the print is refused. | `printPages.js`, `faculty-dashboard.html`, `printController.js` |
| 14 | `print-enforcer.js.bak` was being packed into the .exe | Deleted. | — |

## Limits that remain (cannot be fixed in this program)
- Nothing runs **before anyone logs in to Windows**. That needs a Windows service (a bigger redesign).
- If client users are **local administrators**, they can still end the app or remove the task. The watchdog restarts it within 5 minutes; standard (non-admin) accounts are the real fix.
- Computers **without SecurePrint installed**, and printers shared over the network, are not covered.
- Virtual printers on `PORTPROMPT:`, `FILE:`, `nul:`, `SHRFAX:` (Print to PDF, XPS, OneNote, Fax) are skipped on purpose.
- `GUIDE.md` was not edited and may describe the older behaviour.

## What was verified before this zip was made
- Automated tests: 8 suites, 42 tests pass (`npx jest`).
- The Windows watcher (C#) was **compiled** and the full PowerShell script **parsed** with a real compiler and parser.
- The inline launch command was decoded in PowerShell and matches the script byte for byte.
- The stdin command channel was exercised under both launch modes.
- The installer's scheduled-task command was parsed by PowerShell.
- NOT run on Windows by me: printing, pausing, deleting, the scheduled task and the installer. Use the plan below.

## Windows test plan (do this before rolling out)
1. `npm install`, then in an **Admin PowerShell**: `npx electron . --background`
2. Terminal should show: `Native Windows printer watcher initialized`, `Command channel verified`, `event subscriptions active`.
3. Print from Notepad to your test printer (file port `C:\Temp\testblock.prn`): expect `UNAUTHORIZED (held)` then `DELETE ... done`; the .prn file must **not** appear.
4. Print through SecurePrint: expect `AUTHORIZED (held)` then `RESUME ... done`; the .prn file **appears**.
5. Print a file from Notepad whose name looks like an approved one: still blocked.
6. Hold a job from the Windows print queue, then resume it by hand: it is held again and deleted.
7. Print to Microsoft Print to PDF: saved normally, no log lines.
8. Start `npm run backend`, sign in: terminal shows `Reported N blocked print attempt(s)`; the audit log shows `print_blocked`.
9. Build (`npm run build:win`), install on one PC, run `Get-ScheduledTask 'SecurePrint Enforcer'`, restart, and repeat step 3 **without opening SecurePrint**. End `SecurePrint.exe` in Task Manager and confirm it returns within 5 minutes.

# SecurePrint / Academic Print Monitoring System — Comprehensive Deployment & Operations Guide

> **Important Notice:** This guide documents the exact architecture, verified source code, deployment steps, and security mechanisms of the SecurePrint project.
> All commands in this guide are categorized by machine role:
> - `[SERVER]` — Commands to run only on the central server machine hosting the backend and MySQL.
> - `[CLIENT]` — Commands to run only on client Windows PCs connected to physical printers.
> - `[DEVELOPMENT COMPUTER]` — Commands to run on your development computer to build installers or run test suites.

---

## Table of Contents
1. [System Architecture & Machine Roles](#1-system-architecture--machine-roles)
2. [Server Deployment Guide](#2-server-deployment-guide)
3. [Configuration & URL Audit (Code/Config Changes)](#3-configuration--url-audit-codeconfig-changes)
4. [Client Executable (.exe) Build & Installation](#4-client-executable-exe-build--installation)
5. [Pre-Deployment Local Testing Procedures](#5-pre-deployment-local-testing-procedures)
6. [Safety, System Modifications & Rollback Procedures](#6-safety-system-modifications--rollback-procedures)
7. [Troubleshooting, Verification Checklists & Edge Cases](#7-troubleshooting-verification-checklists--edge-cases)

---

## 1. System Architecture & Machine Roles

SecurePrint implements a **hub-and-spoke security architecture** designed for academic institutions, libraries, and laboratories. It guarantees that all physical prints are authenticated, accounted for, and audited against departmental quotas and user profiles.

```
+-----------------------------------------------------------------------------------+
|                            CENTRAL SERVER MACHINE                                 |
|                                                                                   |
|   +----------------------------+             +--------------------------------+   |
|   |   Node.js / Express API    | <---------> |        MySQL (XAMPP)           |   |
|   |      (Port 3010 TCP)       |  Sequelize  |  Database: monitor_print       |   |
|   |  [backend/server.js]       |             |  [database/schema.sql]         |   |
|   +----------------------------+             +--------------------------------+   |
|                 ^                                                                 |
|                 | REST API / JSON over HTTP/HTTPS                                 |
|                 | (Authentication, Print Logs, Reports, Audits)                   |
+-----------------|-----------------------------------------------------------------+
                  |
        LAN / Wi-Fi Network (e.g. 192.168.1.0/24)
                  |
+-----------------|-----------------------------------------------------------------+
|                 v          CLIENT WINDOWS WORKSTATION                             |
|                                                                                   |
|   +---------------------------------------------------------------------------+   |
|   |                       SecurePrint Electron Client                         |   |
|   |  - UI: Login, Intercept & Print Dialog (frontend/pages/print-intercept.html)   |
|   |  - IPC Bridge (electron/preload.js <-> electron/main.js)                  |   |
|   |  - Durable Outbox Queue (%APPDATA%/SecurePrint/print-log-outbox.json)     |   |
|   |  - Document Converter (Word/Excel/PPT/Images -> PDF via file-converter.js) |   |
|   +---------------------------------------------------------------------------+   |
|                 |                                             |                   |
|                 | Whitelist Job & Print                       | Spooler & Port    |
|                 v                                             v Blocking          |
|   +----------------------------+             +--------------------------------+   |
|   | Windows Print Spooler      |             | Print Enforcer Background Svc  |   |
|   | (winspool.drv / Spoolsv)   | <---------- | - C# / PowerShell Event Watcher|   |
|   +----------------------------+   Cancels   | - Windows Firewall Port Blocker|   |
|                 |               Unauthorized |   (RAW 9100, LPR 515, IPP 631) |   |
|                 v                  Jobs      | [electron/services/            |   |
|   +----------------------------+             |  print-enforcer.js]            |   |
|   | Physical Printer           |             +--------------------------------+   |
|   | (USB or Network IP)        |                                                  |
|   +----------------------------+                                                  |
+-----------------------------------------------------------------------------------+
```

### Strict Machine Separation Rules

| Component / Function | Central Server | Client Workstation | Rationale |
| :--- | :---: | :---: | :--- |
| **Node.js Express Backend** (`backend/server.js`) | **YES** | **NO** | Centralized API, JWT verification, and audit trail collection. |
| **MySQL Database** (`monitor_print`) | **YES** | **NO** | Central single-source-of-truth for user quotas and logs. |
| **Physical Printer Attached** | **NO** | **YES** | Printers reside in faculty rooms, computer labs, or offices. |
| **SecurePrint Desktop Client** (`SecurePrint.exe`) | **NO** | **YES** | Electron client provides the UI for local users. |
| **Print Spooler Event Watcher** (`print-enforcer.js`) | **NEVER** | **YES** | **CRITICAL:** If run on the server, it would disrupt server spoolers and apply unnecessary firewall rules. |
| **Firewall Outbound Port Blocks** (9100, 515, 631) | **NEVER** | **YES** | Must only be applied on client PCs to prevent direct IP bypass. |

> [!CAUTION]
> **RULE OF THUMB:** Never install or run `SecurePrint.exe` or `print-enforcer.js` on the server machine. The server must remain purely a web API and database host.

---

## 2. Server Deployment Guide

### 2.1 Prerequisites
The central server requires:
1. **Operating System:** Windows Server 2016/2019/2022 or Windows 10/11 Pro (64-bit).
2. **Node.js:** Node.js v18.x, v20.x, or v22.x LTS (verified with Node v22.16.0).
3. **Database:** XAMPP (Apache + MySQL / MariaDB 10.4+) or standalone MySQL Server 8.0+.
4. **Network:** Static local IP address (e.g., `192.168.1.100`) or DHCP reservation on the institutional LAN.

---

### 2.2 Finding & Configuring the Server Static LAN IP

On the server machine, open PowerShell and retrieve the current network configuration:

```powershell
# [SERVER] Check IP address
ipconfig
```

Identify your Ethernet or Wi-Fi IPv4 address (e.g., `192.168.1.100`).

*(Optional but recommended)* Set a static IP via PowerShell to prevent IP changes across reboots:
```powershell
# [SERVER] (Run as Administrator) Set static IP on interface 'Ethernet'
# Replace values with your actual network gateway and subnet
New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress "192.168.1.100" -PrefixLength 24 -DefaultGateway "192.168.1.1"
Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ServerAddresses ("1.1.1.1", "8.8.8.8")
```

---

### 2.3 Database Setup (XAMPP / MySQL)

The backend connects to a database named `monitor_print` using parameters defined in `.env`.

#### Step 1: Start MySQL in XAMPP
1. Open **XAMPP Control Panel**.
2. Click **Start** next to **MySQL** (and optionally **Apache** if using phpMyAdmin).
3. Ensure port `3306` is displayed in green.

#### Step 2: Create & Populate the Schema
Run the schema file `database/schema.sql` using one of the three following methods:

**Method A: Using MySQL Command Line (Recommended)**
```powershell
# [SERVER] Import schema directly using XAMPP MySQL client
& "C:\xampp\mysql\bin\mysql.exe" -u root -p -e "source c:/xampp/htdocs/Print_Monitor_blocked_button/database/schema.sql"
```
*(If prompted for password and root has no password, press Enter).*

**Method B: Using phpMyAdmin**
1. Open a browser on the server and navigate to `http://localhost/phpmyadmin`.
2. Click the **Import** tab.
3. Browse to `c:\xampp\htdocs\Print_Monitor_blocked_button\database\schema.sql`.
4. Click **Import** at the bottom.

**Method C: Using the built-in PHP script**
1. Open `http://localhost/Print_Monitor_blocked_button/database/import.php` in a web browser.
2. Confirm the success message: `✓ Database schema created successfully!`.

#### Step 3: Verify the Database Tables
Verify that all four required tables are created:
```powershell
# [SERVER] Verify created tables
& "C:\xampp\mysql\bin\mysql.exe" -u root -e "USE monitor_print; SHOW TABLES;"
```
Expected output:
```text
Tables_in_monitor_print
audit_logs
print_logs
reports
users
```

---

### 2.4 Server Configuration (`.env`)

In the project root on the server, create or update the `.env` file with production values:

```ini
# ============================================================
# SecurePrint Server Configuration
# Location: .env (Project Root)
# ============================================================

# Server Port
PORT=3010

# IMPORTANT: Keep 'development' unless you have configured an HTTPS reverse proxy (e.g. Nginx with SSL)
# Setting NODE_ENV=production enforces an HTTP-to-HTTPS redirect that will block plain LAN HTTP traffic.
NODE_ENV=development

# MySQL Database (XAMPP)
DB_HOST=localhost
DB_PORT=3306
DB_NAME=monitor_print
DB_USER=root
DB_PASS=

# JWT Authentication
# Replace with a strong random string (minimum 32 characters)
JWT_SECRET=SecurePrint_Production_Secret_Key_987654321_Auth
JWT_EXPIRES_IN=8h

# Inactivity Timeout (milliseconds) - 15 minutes
INACTIVITY_TIMEOUT=900000

# App Name & URLs
APP_NAME=SecurePrint
# Must point to the server's LAN IP so password reset links sent via email are reachable from client PCs
APP_BASE_URL=http://192.168.1.100:3010
RESET_TOKEN_EXPIRES_MS=900000

# SMTP / Email Configuration (For password reset & alerts)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_institution_email@gmail.com
SMTP_PASS=your_app_specific_password
SMTP_FROM="SecurePrint Admin <your_institution_email@gmail.com>"

# Security & Lockout
MAX_FAILED_LOGINS=5
LOCKOUT_MINUTES=15

# Default Super Admin Seed
# Automatically created on first server startup if no superadmin exists in the database
SUPER_ADMIN_USERNAME=superadmin
SUPER_ADMIN_EMAIL=superadmin@institution.edu
SUPER_ADMIN_PASSWORD=SuperAdmin@Secure2026!
SUPER_ADMIN_SECRET_CODE=SuperAdmin@Secure2026!
```

---

### 2.5 Installing Backend Dependencies & Starting the Service

1. Open PowerShell on the server in the project directory:
```powershell
# [SERVER] Navigate to project root
cd c:\xampp\htdocs\Print_Monitor_blocked_button

# [SERVER] Install production dependencies
npm install --omit=dev
```

2. Test run the server to confirm database connectivity and superadmin seeding:
```powershell
# [SERVER] Start backend
npm run backend
```
Expected console output:
```text
✅ MySQL (XAMPP) connected successfully.
✅ Database tables synchronized.
[SEED] Default superadmin created. (or Super admin already exists.)

🖨️  SecurePrint Server running on http://localhost:3010
📊 Admin Panel: Open Electron app
```

3. Configure continuous operation (daemon/service):
To prevent the server from exiting when the command prompt is closed, use **PM2**:
```powershell
# [SERVER] Install PM2 globally
npm install -g pm2

# [SERVER] Start backend process with PM2
pm2 start backend/server.js --name secureprint-backend

# [SERVER] Save PM2 process list so it restarts on system reboot
pm2 save

# [SERVER] Setup PM2 Windows service autostart
npm install -g pm2-windows-service
pm2-service-install
```

---

### 2.6 Server Firewall Configuration

By default, Windows Firewall blocks incoming connections on non-standard ports. You must open port `3010` for inbound traffic from the LAN:

```powershell
# [SERVER] (Run as Administrator in PowerShell)
New-NetFirewallRule -DisplayName "SecurePrint-Backend-Port-3010" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 3010 `
  -Action Allow `
  -Profile Any
```

---

### 2.7 Verifying Server Connectivity

#### Local Verification (On the Server):
```powershell
# [SERVER]
Invoke-RestMethod -Uri "http://localhost:3010/api/health" -Method Get
```
Expected response:
```json
{"success": true, "message": "SecurePrint API is running", "time": "2026-10-09T..."}
```

#### Remote Verification (From a Client Computer on the same LAN):
Open PowerShell on a separate client machine and test connectivity to the server's LAN IP:
```powershell
# [CLIENT] Test connection to the central server
Invoke-RestMethod -Uri "http://192.168.1.100:3010/api/health" -Method Get
```
If this command succeeds and returns the JSON payload, the server is ready to accept client connections.

---

## 3. Configuration & URL Audit (Code/Config Changes)

This section details every file where `localhost`, URLs, IP addresses, ports, or protocols are configured, and explains how to configure them for production.

### Detailed Audit Table

| File Path | Setting / Line | Default Value | Production Change Required |
| :--- | :--- | :--- | :--- |
| [electron/client-config.json](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/electron/client-config.json#L2) | Line 2: `"apiBaseUrl"` | `"http://localhost:3010"` | **Change to server LAN URL**, e.g.: `"http://192.168.1.100:3010"`. Required before packaging the client `.exe`. |
| [.env](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/.env#L2-L40) | Line 2: `PORT` | `3010` | Port for Express API. Must match firewall rules and client URL port. |
| [.env](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/.env#L3) | Line 3: `NODE_ENV` | `development` | **Leave as `development`** unless full HTTPS with SSL certificate is implemented. If set to `production`, `server.js` redirects all HTTP traffic to HTTPS (see warning below). |
| [.env](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/.env#L30) | Line 30: `APP_BASE_URL` | `http://localhost:3010` | **Change to server LAN URL**, e.g.: `http://192.168.1.100:3010`. Used by `authController.js` to create password reset email links. |
| [.env](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/.env#L13) | Line 13: `JWT_SECRET` | `your_super_secret...` | **Change to a strong, high-entropy secret.** |
| [backend/server.js](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/backend/server.js#L21) | Line 21: `cors` | `['http://localhost:*', 'file://']` | If accessing the API from external web browsers, set `CORS_ORIGIN` in `.env` (e.g. `CORS_ORIGIN=http://192.168.1.100:3010,http://192.168.1.100`). Electron requests use origin `file://` or have no origin header, which is already permitted. |
| [backend/server.js](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/backend/server.js#L34-L39) | Lines 34–39: `NODE_ENV === 'production'` HTTPS redirect | `res.redirect(301, 'https://...')` | Enforces HTTPS when `NODE_ENV=production`. If you are running an internal LAN server without SSL, **do not** set `NODE_ENV=production` or client requests will fail with 301 redirect errors. |
| [backend/controllers/authController.js](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/backend/controllers/authController.js#L12) | Line 12: `APP_BASE_URL` | `process.env.APP_BASE_URL \|\| 'http://localhost:3010'` | Reads `APP_BASE_URL` from `.env`. Must point to server IP so password reset links function on client computers. |
| [database/import.php](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/database/import.php#L3) | Line 3: `$servername` | `"localhost"` | Leave as `"localhost"` because PHP runs directly on the server alongside MySQL. |

---

### How Electron Preload and IPC Resolve Server URLs

The frontend UI in SecurePrint does **not** hardcode API URLs inside HTML pages. Instead, it uses a decoupled IPC architecture:

1. **Resolution** ([electron/client-config.js](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/electron/client-config.js)):
   ```javascript
   function resolveApiBaseUrl() {
     // 1. Checks environment variable first (allows dynamic override without recompiling)
     let configuredUrl = process.env.SECUREPRINT_API_URL;
     // 2. Falls back to electron/client-config.json
     if (!configuredUrl) {
       const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
       configuredUrl = config.apiBaseUrl;
     }
     ...
     return normalizedUrl;
   }
   ```
2. **IPC Handler** ([electron/main.js](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/electron/main.js#L272-L279)):
   The main process handles the `get-client-config` IPC channel:
   ```javascript
   ipcMain.handle('get-client-config', () => {
     return { apiBaseUrl: resolveApiBaseUrl(), apiConfigError: '' };
   });
   ```
3. **Preload Context Bridge** ([electron/preload.js](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/electron/preload.js#L3-L5)):
   The preload script safely exposes this configuration to the renderer world without compromising Node.js security:
   ```javascript
   contextBridge.exposeInMainWorld('securePrintConfig', {
     get: () => ipcRenderer.invoke('get-client-config')
   });
   ```
4. **Renderer Consumption** ([frontend/assets/js/app.js](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/frontend/assets/js/app.js#L2-L20)):
   The `api` object resolves the promise before each network request:
   ```javascript
   const securePrintConfig = await securePrintConfigPromise;
   const apiBase = `${securePrintConfig.apiBaseUrl}/api`;
   const res = await fetch(`${apiBase}${endpoint}`, opts);
   ```

### Overriding the Server URL on Packaged Clients Without Rebuilding
If the server IP changes after the client `.exe` has been installed, you do not need to recompile the installer. Simply set the system environment variable on the client computer:
```powershell
# [CLIENT] (Run as Administrator) Change central server URL at runtime
[Environment]::SetEnvironmentVariable("SECUREPRINT_API_URL", "http://192.168.1.150:3010", "Machine")
```
Restart SecurePrint, and it will immediately route all requests to the new server IP.

---

## 4. Client Executable (.exe) Build & Installation

### 4.1 Packaging the Client Application

The client installer is built on your development machine using `electron-builder`.

#### Step 1: Set the Target Server URL
Open [electron/client-config.json](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/electron/client-config.json) on your development machine and specify the server IP:
```json
{
  "apiBaseUrl": "http://192.168.1.100:3010"
}
```

#### Step 2: Run the Build Command
```powershell
# [DEVELOPMENT COMPUTER] In project root
npm run build:win
```
*(Alternatively, `npm run dist`)*.

#### Step 3: Verify the Build Artifacts
Upon completion, the installers will be located in the `dist/` directory:
- `dist/SecurePrintClient-1.0.0-Setup.exe` — Full Windows NSIS Installer (Elevated installer containing context menu integration and auto-start services).
- `dist/SecurePrint 1.0.0.exe` — Portable executable.
- `dist/win-unpacked/SecurePrint.exe` — Raw unpacked binary folder.

---

### 4.2 Installing on Client Workstations

1. Copy `SecurePrintClient-1.0.0-Setup.exe` to the target client computer (via USB drive or network share).
2. **Right-click the setup file and select "Run as administrator"**.
   - Admin rights are required by NSIS (`requestedExecutionLevel: "requireAdministrator"`) to write shell registry entries and create Windows Firewall rules.
3. Follow the installation wizard. SecurePrint will install to:
   `C:\Program Files\SecurePrint\`

#### What the Installer Automatically Configures:
According to [electron/installer.nsh](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/electron/installer.nsh):
1. **Context Menu:** Registers `"Print with SecurePrint"` under `HKCR\*\shell\SecurePrint` and for 16 specific document file types (`.pdf`, `.docx`, `.doc`, `.xlsx`, `.xls`, `.pptx`, `.ppt`, `.rtf`, `.txt`, `.csv`, `.jpg`, `.jpeg`, `.png`, `.bmp`, `.gif`, `.tiff`).
2. **Auto-Start:** Adds `SecurePrint.exe --background` to `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
3. **USB Printer Support:** Restores Windows `usbprint` and `USBSTOR` service start types to demand-start (`Start = 3`) to prevent device driver conflicts.
4. **Firewall Lockdown Rules:** Creates outbound Windows Firewall rules to block direct network printing:
   - `SecurePrint-Block-RAW-9100` (TCP Port 9100)
   - `SecurePrint-Block-LPR-515` (TCP Port 515)
   - `SecurePrint-Block-IPP-631` (TCP Port 631)

---

### 4.3 Verifying Client Background Service Execution

When the client logs in to Windows, SecurePrint launches silently in the background:
```powershell
# [CLIENT] Verify SecurePrint is running
Get-Process -Name "SecurePrint"
```
The application will also display its tray icon and run the PowerShell spooler monitor in the background.

---

## 5. Pre-Deployment Local Testing Procedures

Follow this sequential test matrix to ensure the system is operational before rolling it out to faculty and lab workstations.

### 5.1 Test 1: Central Server Health Check
- **Action:** From the client workstation, open a browser or PowerShell:
  ```powershell
  # [CLIENT]
  Invoke-RestMethod -Uri "http://192.168.1.100:3010/api/health"
  ```
- **Expected Result:** HTTP 200 with `{ "success": true, "message": "SecurePrint API is running" }`.

---

### 5.2 Test 2: Role-Based Authentication Testing

Open `SecurePrint` on the client computer:
1. **Faculty Login:**
   - Account: `samiksha@gmail.com` / Password: (faculty password).
   - Expected: Navigates to `faculty-dashboard.html`. Quota and history cards load.
2. **Admin Portal Login:**
   - Click "Admin Login" in the top-right corner of the login screen.
   - Account: `chandana@gmail.com` / Password: (admin password) / Secret Code: (assigned admin code).
   - Expected: Navigates to `admin-dashboard.html`. Department reports and faculty lists load.
3. **Super Admin Login:**
   - Account: `superadmin@institution.edu` (or `superadmin@gmail.com`) / Password: `superadmin@1234` / Secret Code: `superadmin@1234`.
   - Expected: Navigates to `super-admin-dashboard.html`. Full institution controls load.

---

### 5.3 Test 3: Authorized Printing via SecurePrint

#### Method A: Via Application UI
1. Launch SecurePrint and log in as faculty.
2. Click **Browse File** and select a test document (`test.docx` or `sample.pdf`).
3. Select the attached physical printer from the dropdown.
4. Configure copies (e.g. 1) and click **Print Now**.

#### Method B: Via Windows Explorer Context Menu
1. Locate any file in File Explorer (e.g. on Desktop).
2. Right-click the file and click **"Print with SecurePrint"**.
3. The SecurePrint print intercept window (`print-intercept.html`) appears with document metadata and page count.
4. If not signed in, log in; if signed in, click **Print Now**.

#### Expected Results:
1. Document is automatically converted to PDF if necessary via `file-converter.js`.
2. `printEnforcer.whitelistJob(docName)` temporarily whitelists the job name for 60 seconds.
3. `pdf-to-printer` sends the print job to the spooler.
4. The physical printer prints the page.
5. SecurePrint outbox logs the record and uploads it to `POST /api/print/log`.
6. Verify in MySQL on the server:
   ```sql
   -- [SERVER] Check latest log
   SELECT id, user_id, file_name, total_sheets, printer_name, status, created_at 
   FROM print_logs 
   ORDER BY id DESC LIMIT 1;
   ```

---

### 5.4 Test 4: Direct-Print Blocking Verification

Test direct print attempts from standard Windows applications to verify that unauthorized printing is blocked.

Before testing, run `npm start` on the client and confirm these messages in its terminal output:

1. `[PrintEnforcer] Native Windows printer watcher initialized.`
2. `[PrintEnforcer] Native ADD_JOB event subscriptions active for N printers: ...`, where `N` is greater than zero and the target physical printer is listed.

The first message confirms the persistent PowerShell/Win32 watcher started; the second confirms it subscribed to printer job events. Do not repeat the direct-print test until both appear. The monitor starts independently of SecurePrint user sign-in, so this check is valid before the logged-out test.

With SecurePrint open on its login screen (logged out), send a test job directly to a physical printer. SecurePrint should bring its window forward if hidden or minimized and show the warning toast: **“Print Blocked. All printing must go through SecurePrint.”** Repeated warnings are throttled to avoid flooding the UI.

| Application Tested | Test Procedure | Expected Result | Technical Behavior |
| :--- | :--- | :--- | :--- |
| **Microsoft Word** | Open Word, press `Ctrl + P`, select the physical printer, click **Print**. | **BLOCKED:** Print job is instantly deleted from the queue; SecurePrint displays the blocked-print warning toast. | `SecurePrintChangeWatcher` detects `PRINTER_CHANGE_ADD_JOB`; document is not in `whitelistedJobs`; the Electron UI is notified over IPC and the job is deleted. |
| **Microsoft Excel** | Open `.xlsx`, press `Ctrl + P`, click **Print**. | **BLOCKED:** Job cancelled; notification shown. | Same as above. |
| **Microsoft PowerPoint** | Open `.pptx`, press `Ctrl + P`, click **Print**. | **BLOCKED:** Job cancelled; notification shown. | Same as above. |
| **PDF Readers** (Acrobat / Edge) | Open PDF in Adobe Acrobat or Edge, press `Ctrl + P`, click **Print**. | **BLOCKED:** Spooler cancels the job; printer does not output pages. | Same as above. |
| **Web Browsers** (Chrome / Edge) | Press `Ctrl + P` on any web page, select physical printer, click **Print**. | **BLOCKED:** Job cancelled in print queue. | Same as above. |
| **Notepad** | Open `test.txt`, select File > Print, click **Print**. | **BLOCKED:** Job cancelled in queue. | See race condition note below. |

---

### 5.5 Understanding the Print-Blocking Mechanism & Limitations

To ensure realistic expectations, administrators must understand the technical characteristics of the print-blocking service:

1. **How the Interceptor Operates:**
   The service launches a persistent PowerShell script from a temporary `.ps1` file (avoiding Windows command-line length limits), which compiles a C# listener ([electron/services/print-enforcer.js](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/electron/services/print-enforcer.js#L103-L200)) that calls native Win32 APIs:
   - `OpenPrinter()`
   - `FindFirstPrinterChangeNotification(PRINTER_CHANGE_ADD_JOB)`
   - `WaitForMultipleObjects()`
   When an application spools a document, Windows fires this native event. The watcher extracts the print job details and checks if the document name exists in SecurePrint's memory whitelist (`whitelistedJobs`). If not, it executes:
   ```powershell
   Get-CimInstance Win32_PrintJob | Where-Object { $_.Name -eq $jobName } | Invoke-CimMethod -MethodName Delete
   ```

2. **The Fast-Spooler Race Condition:**
   - Because the event watcher operates at the user-mode spooler notification level rather than as a kernel-level print monitor driver, there is an asynchronous window of approximately **100ms to 300ms** between when a job enters the spooler and when PowerShell issues the `Delete` CIM command.
   - **Small vs Large Documents:** For large documents (multi-page PDFs, Word documents, PowerPoint presentations), the spooler takes several seconds to render and transmit data to the printer; the enforcer catches and cancels these reliably.
   - **Tiny Documents on High-Speed USB Printers:** If a user prints a 1-line Notepad text file directly to a fast local USB laser printer, raw data may begin transmitting to the printer buffer before the CIM delete command finishes. In such cases, line 426 of `print-enforcer.js` logs:
     `Could not cancel unauthorized job: it was no longer in the spooler.`
3. **Network Printers:**
   Direct IP bypass (bypassing the spooler by opening raw sockets to port 9100) is blocked by the Windows Firewall outbound rules created during installation.

---

## 6. Safety, System Modifications & Rollback Procedures

### 6.1 Inventory of System-Level Modifications
SecurePrint modifies the following system components on the **client computer**:

1. **Windows Registry:**
   - `HKCR\*\shell\SecurePrint` (Context menu for all files)
   - `HKCR\SystemFileAssociations\<ext>\shell\SecurePrint` (16 extension associations)
   - `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\SecurePrint` (Auto-start at user logon)
   - `HKLM\SYSTEM\CurrentControlSet\Services\usbprint` (Start DWORD set to 3)
   - `HKLM\SYSTEM\CurrentControlSet\Services\USBSTOR` (Start DWORD set to 3)
2. **Windows Firewall Outbound Rules:**
   - `SecurePrint-Block-RAW-9100` (Blocks outbound TCP 9100)
   - `SecurePrint-Block-LPR-515` (Blocks outbound TCP 515)
   - `SecurePrint-Block-IPP-631` (Blocks outbound TCP 631)
3. **Print Spooler:**
   - Issues `Delete` method on unauthorized `Win32_PrintJob` instances.

---

### 6.2 Pre-Testing Backup Procedures

Before installing the client on a production workstation, run this backup script:

```powershell
# [CLIENT] (Run as Administrator) Create pre-installation backup
New-Item -ItemType Directory -Path "C:\SecurePrint_Backup" -Force

# 1. Backup Windows Firewall configuration
netsh advfirewall export "C:\SecurePrint_Backup\firewall_backup.wfw"

# 2. Backup Current User Run registry key
reg export "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" "C:\SecurePrint_Backup\Run_Key_Backup.reg" /y

# 3. Export list of currently installed printers and drivers
Get-Printer | Select-Object Name, DriverName, PortName, Shared | Export-CliXml "C:\SecurePrint_Backup\Printers_Backup.xml"

Write-Host "✅ System state backed up to C:\SecurePrint_Backup\" -ForegroundColor Green
```

---

### 6.3 Standard Clean Uninstallation

To uninstall SecurePrint cleanly:
1. Open **Windows Settings > Apps > Installed Apps**.
2. Find **SecurePrint** and click **Uninstall**.
3. The NSIS `customUnInstall` macro ([electron/installer.nsh](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/electron/installer.nsh#L118-L153)) automatically:
   - Deletes all context menu registry keys.
   - Deletes the auto-start entry in `HKCU\...\Run`.
   - Restores `usbprint` and `USBSTOR` driver start configurations.
   - Deletes all three firewall block rules (`netsh advfirewall firewall delete rule`).
   - Removes the installed files from `C:\Program Files\SecurePrint`.

---

### 6.4 Emergency Manual Rollback Script

If a workstation is left in a locked state (e.g. application closed ungracefully, network printing blocked, or context menu items remaining), run this standalone recovery script in PowerShell as Administrator:

```powershell
# ============================================================
# [CLIENT] SecurePrint Emergency Rollback & Restoration Script
# Run as Administrator in PowerShell
# ============================================================

Write-Host "🔄 Initiating SecurePrint complete system rollback..." -ForegroundColor Cyan

# 1. Terminate any running SecurePrint processes and PowerShell monitors
Get-Process -Name "SecurePrint", "electron" -ErrorAction SilentlyContinue | Stop-Process -Force
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*SecurePrintChangeWatcher*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host "✓ Terminated all background SecurePrint processes." -ForegroundColor Green

# 2. Remove Windows Firewall Port Blocking Rules
netsh advfirewall firewall delete rule name="SecurePrint-Block-RAW-9100" | Out-Null
netsh advfirewall firewall delete rule name="SecurePrint-Block-LPR-515" | Out-Null
netsh advfirewall firewall delete rule name="SecurePrint-Block-IPP-631" | Out-Null
Write-Host "✓ Deleted outbound firewall blocking rules (9100, 515, 631)." -ForegroundColor Green

# 3. Remove Registry Context Menu Keys
$regKeys = @(
    "HKCR:\*\shell\SecurePrint",
    "HKCR:\SystemFileAssociations\.pdf\shell\SecurePrint",
    "HKCR:\SystemFileAssociations\.docx\shell\SecurePrint",
    "HKCR:\SystemFileAssociations\.doc\shell\SecurePrint",
    "HKCR:\SystemFileAssociations\.xlsx\shell\SecurePrint",
    "HKCR:\SystemFileAssociations\.xls\shell\SecurePrint",
    "HKCR:\SystemFileAssociations\.pptx\shell\SecurePrint",
    "HKCR:\SystemFileAssociations\.ppt\shell\SecurePrint",
    "HKCR:\SystemFileAssociations\.rtf\shell\SecurePrint",
    "HKCR:\SystemFileAssociations\.txt\shell\SecurePrint",
    "HKCR:\SystemFileAssociations\.csv\shell\SecurePrint",
    "HKCR:\SystemFileAssociations\.jpg\shell\SecurePrint",
    "HKCR:\SystemFileAssociations\.jpeg\shell\SecurePrint",
    "HKCR:\SystemFileAssociations\.png\shell\SecurePrint",
    "HKCR:\SystemFileAssociations\.bmp\shell\SecurePrint",
    "HKCR:\SystemFileAssociations\.gif\shell\SecurePrint",
    "HKCR:\SystemFileAssociations\.tiff\shell\SecurePrint"
)
foreach ($key in $regKeys) {
    if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force }
}
Write-Host "✓ Removed Windows Explorer context menu entries." -ForegroundColor Green

# 4. Remove Windows Auto-Start Registry Entry
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "SecurePrint" -ErrorAction SilentlyContinue
Write-Host "✓ Removed auto-start logon entry." -ForegroundColor Green

# 5. Restart Windows Print Spooler Service
Restart-Service -Name Spooler -Force
Write-Host "✓ Restarted Windows Print Spooler service." -ForegroundColor Green

# 6. Refresh Windows Explorer shell
& ie4uinit.exe -show

Write-Host "✅ System rollback completed successfully! Standard printing restored." -ForegroundColor Green
```

---

## 7. Troubleshooting, Verification Checklists & Edge Cases

### 7.1 Final Deployment Checklists

#### Checklist 1: Server / Client Separation
- [ ] Backend runs on the Central Server only (`PORT=3010`).
- [ ] MySQL database `monitor_print` is active on the server.
- [ ] Firewall port 3010 is open for inbound connections on the server.
- [ ] No client installer (`SecurePrintClient-Setup.exe`) was run on the server.
- [ ] No printer blocking rules exist on the server.

#### Checklist 2: Client Workstation Readiness
- [ ] Server IP is reachable from the client workstation (`/api/health` test succeeds).
- [ ] Client `.exe` was installed with Administrator privileges.
- [ ] Physical printer driver is installed, powered on, and shows as "Ready".
- [ ] Right-click context menu "Print with SecurePrint" appears in File Explorer.
- [ ] SecurePrint tray/background process starts on user logon.

#### Checklist 3: Print Accounting & Database Integrity
- [ ] Faculty user can log in and view their historical prints.
- [ ] An authorized print increments `num_pages` and `total_sheets` in `print_logs`.
- [ ] Direct print attempts show the “Print Blocked. All printing must go through SecurePrint.” toast, including while logged out.
- [ ] Admin user can view and export departmental Excel reports.

---

### 7.2 Common Errors & Solutions

#### 1. Server Error: `EADDRINUSE: 3010`
- **Cause:** Another process or previous node instance is already bound to port 3010.
- **Fix:**
  ```powershell
  # [SERVER] Find PID using port 3010
  Get-Process -Id (Get-NetTCPConnection -LocalPort 3010).OwningProcess | Stop-Process -Force
  ```

#### 2. Client Connection Fails: `Cannot connect to server` / `FetchError`
- **Causes:**
  1. Incorrect server LAN IP in [electron/client-config.json](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/electron/client-config.json).
  2. Windows Firewall on the server is blocking inbound port 3010.
  3. Client and server are on separate isolated VLANs or guest Wi-Fi.
- **Fix:**
  - Verify server firewall rule: `netsh advfirewall firewall show rule name="SecurePrint-Backend-Port-3010"`.
  - Override server URL on client:
    ```powershell
    [Environment]::SetEnvironmentVariable("SECUREPRINT_API_URL", "http://<SERVER_IP>:3010", "Machine")
    ```

#### 3. Client Requests Fail with HTTP 301 Redirect Loop
- **Cause:** `NODE_ENV=production` is set in [.env](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/.env) on the server, triggering lines 34–39 of [backend/server.js](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/backend/server.js) which redirect all HTTP requests to HTTPS. If no SSL certificate/port 443 is configured, requests will fail.
- **Fix:** Keep `NODE_ENV=development` in `.env` for standard LAN HTTP deployments.

#### 4. Database Connection Fails: `ECONNREFUSED 3306`
- **Cause:** MySQL is not running in XAMPP or is bound to a different port.
- **Fix:** Open XAMPP Control Panel and start MySQL. Check that `DB_HOST=localhost` and `DB_PORT=3306` in [.env](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/.env).

#### 5. Unauthorized Print Not Blocked (Fast Spooler Race Condition)
- **Cause:** Document is very small (e.g. 1-page plain text file) and spooled directly to a fast USB printer before PowerShell issues the delete command.
- **Fix:**
  - In Windows printer properties, navigate to **Advanced** tab.
  - Select **"Start printing after last page is spooled"** rather than "Start printing immediately". This holds the print job in the spooler while rendering, allowing SecurePrint's watcher to reliably detect and delete it.

#### 6. Document Conversion Fails in SecurePrint
- **Cause:** Converting `.docx`, `.xlsx`, or `.pptx` relies on Microsoft Office COM automation or LibreOffice headless mode ([electron/services/file-converter.js](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/electron/services/file-converter.js)).
- **Fix:** Ensure either Microsoft Office (Word/Excel/PowerPoint) or LibreOffice is installed on the client machine. For machines without Office, convert files to PDF before printing.

#### 7. Offline / Queued Print Logs Not Syncing
- **Behavior:** If the server is offline when a print occurs, SecurePrint's durable outbox ([electron/services/print-log-outbox.js](file:///c:/xampp/htdocs/Print_Monitor_blocked_button/electron/services/print-log-outbox.js)) stores the job in `%APPDATA%\SecurePrint\print-log-outbox.json`.
- **Resolution:** As soon as the client workstation reconnects to the network and a user signs in, `app.js` calls `syncQueuedPrintLogs()` to automatically flush and record all pending logs on the server.

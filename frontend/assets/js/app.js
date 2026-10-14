// ===================== API Client =====================
const securePrintConfigPromise = window.securePrintConfig?.get
  ? window.securePrintConfig.get()
  : Promise.resolve({
    apiBaseUrl: '',
    apiConfigError: 'Central SecurePrint configuration is unavailable.'
  });

const api = {
  async request(method, endpoint, data = null, auth = true) {
    const securePrintConfig = await securePrintConfigPromise;
    const apiBase = securePrintConfig.apiBaseUrl
      ? `${securePrintConfig.apiBaseUrl}/api`
      : '';
    if (!apiBase) {
      return {
        success: false,
        message: securePrintConfig.apiConfigError || 'Central SecurePrint server is not configured.'
      };
    }
    const headers = { 'Content-Type': 'application/json' };
    if (auth) {
      const token = secureStorage.get('token');
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    const opts = { method, headers };
    if (data && method !== 'GET') opts.body = JSON.stringify(data);

    console.log(`[API] ${method} ${endpoint}`, data);
    const res = await fetch(`${apiBase}${endpoint}`, opts);
    console.log(`[API] Response status:`, res.status);
    const json = await res.json().catch(() => { console.error('[API] JSON parse error'); return { success: false, message: 'Invalid response' }; });
    console.log(`[API] Response body:`, json);
    if (auth && !res.ok && res.status === 401) {
      secureStorage.clear();
      electronAPI.navigate('login');
    }
    return json;
  },
  get: (endpoint, auth = true) => api.request('GET', endpoint, null, auth),
  post: (endpoint, data, auth = true) => api.request('POST', endpoint, data, auth),
  put: (endpoint, data, auth = true) => api.request('PUT', endpoint, data, auth),
  delete: (endpoint, auth = true) => api.request('DELETE', endpoint, null, auth)
};

// ===================== Auth Helpers =====================
const Auth = {
  getUser() {
    try { return JSON.parse(secureStorage.get('user') || 'null'); } catch { return null; }
  },
  getToken() { return secureStorage.get('token'); },
  isLoggedIn() { return !!this.getToken() && !!this.getUser(); },
  save(token, user) {
    secureStorage.set('token', token);
    secureStorage.set('user', JSON.stringify(user));
    secureStorage.set('lastActivity', Date.now().toString());
    syncQueuedPrintLogs(token);
  },
  setToken(token) {
    secureStorage.set('token', token);
    syncQueuedPrintLogs(token);
  },
  setUser(user) {
    secureStorage.set('user', JSON.stringify(user));
  },
  logout() {
    secureStorage.clear();
    electronAPI.clearPrintLogToken();
    electronAPI.navigate('login');
  },
  requireAuth(roles = null) {
    if (!this.isLoggedIn()) { electronAPI.navigate('login'); return null; }
    const user = this.getUser();
    if (roles) {
      const allowed = Array.isArray(roles) ? roles : [roles];
      if (!allowed.includes(user.role)) {
        electronAPI.navigate(user.role === 'faculty' ? 'faculty' : 'admin');
        return null;
      }
    }
    return user;
  },
  updateActivity() { secureStorage.set('lastActivity', Date.now().toString()); }
};

// ===================== Inactivity Logout =====================
const INACTIVITY_MS = 15 * 60 * 1000; // 15 min
let inactivityTimer;

function resetInactivityTimer() {
  Auth.updateActivity();
  clearTimeout(inactivityTimer);
  if (Auth.isLoggedIn()) {
    inactivityTimer = setTimeout(() => {
      Toast.warning('Session expired due to inactivity.');
      setTimeout(() => Auth.logout(), 1500);
    }, INACTIVITY_MS);
  }
}

['click','mousemove','keydown','scroll','touchstart'].forEach(ev => {
  document.addEventListener(ev, resetInactivityTimer, { passive: true });
});

// ===================== Toast System =====================
const Toast = {
  container: null,
  init() {
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
  },
  show(msg, type = 'success', duration = 4000) {
    if (!this.container) this.init();
    const icons = { success: '✓', error: '✕', warning: '⚠' };
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<span>${icons[type] || '•'}</span><span>${msg}</span>`;
    this.container.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(() => t.remove(), 300); }, duration);
  },
  success: (msg) => Toast.show(msg, 'success'),
  error: (msg) => Toast.show(msg, 'error'),
  warning: (msg) => Toast.show(msg, 'warning')
};

if (window.electronAPI?.onPrintBlocked) {
  window.electronAPI.onPrintBlocked((message) => Toast.warning(message));
}

function syncQueuedPrintLogs(token) {
  if (!token || !window.electronAPI?.syncPrintLogs) return;
  electronAPI.syncPrintLogs(token).then(result => {
    if (!result.success) {
      console.error('[PrintLog] Could not sync queued print logs:', result.message);
      return;
    }
    if (result.status?.uncertain?.length) {
      Toast.warning(`${result.status.uncertain.length} print job outcome(s) need review after an application interruption; they were not reported as successful.`);
    }
    if (result.status?.pending) {
      console.warn(`[PrintLog] ${result.status.pending} successful print log(s) remain queued for server delivery.`);
    }
  }).catch(error => {
    console.error('[PrintLog] Could not sync queued print logs:', error.message);
  });
}

syncQueuedPrintLogs(Auth.getToken());

// ===================== Utility Helpers =====================
function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatMonth(month, year) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[month - 1]} ${year}`;
}

function setLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn._orig = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span> Loading...';
    btn.disabled = true;
  } else {
    btn.innerHTML = btn._orig || 'Submit';
    btn.disabled = false;
  }
}

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return [...document.querySelectorAll(sel)]; }

// Init toast on load
document.addEventListener('DOMContentLoaded', () => Toast.init());

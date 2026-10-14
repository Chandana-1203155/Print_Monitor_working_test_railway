const fs = require('fs');
const path = require('path');

function resolveApiBaseUrl() {
  const configPath = path.join(__dirname, 'client-config.json');
  let configuredUrl = process.env.SECUREPRINT_API_URL;

  if (!configuredUrl) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    configuredUrl = config.apiBaseUrl;
  }

  if (typeof configuredUrl !== 'string' || !configuredUrl.trim()) {
    throw new Error('Set apiBaseUrl in electron/client-config.json to the central SecurePrint server URL.');
  }

  const normalizedUrl = configuredUrl.trim().replace(/\/+$/, '');
  let parsedUrl;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    throw new Error('The central SecurePrint API URL is invalid.');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error('The central SecurePrint API URL must use HTTP or HTTPS and must not contain credentials.');
  }

  return normalizedUrl;
}

module.exports = { resolveApiBaseUrl };

// Talks to a Pixelhue processor (P80 etc.) over its HTTP API.
// Builds the JWT the same way Bitfocus's companion-module-pixelhue-switcher does,
// and rebuilds it once if a call fails (e.g. after the processor reboots).

const crypto = require('crypto');

const BASE_PATH = '/unico/v1';

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// HS256 JWT, payload {"SN": sn}, no timestamp, secret = startTime.
function buildToken(sn, startTime) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ SN: sn }));
  const signature = crypto
    .createHmac('sha256', String(startTime))
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${header}.${payload}.${signature}`;
}

class ApiError extends Error {
  constructor(message, { status, code, path } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

function createPixelhueClient({ ip, port = 8088, timeoutMs = 4000 }) {
  const baseUrl = `http://${ip}:${port}${BASE_PATH}`;
  let token = null;
  let deviceInfo = null;

  async function rawRequest(method, path, body, useToken) {
    const headers = { 'Content-Type': 'application/json' };
    if (useToken && token) headers.Authorization = token;
    let res;
    try {
      res = await fetch(baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ApiError(`Can't reach processor at ${ip}:${port} (${err.cause?.code || err.name})`, { path });
    }
    let json;
    try {
      json = await res.json();
    } catch {
      throw new ApiError(`Processor sent a non-JSON reply (HTTP ${res.status})`, { status: res.status, path });
    }
    if (!res.ok || (typeof json.code === 'number' && json.code !== 0)) {
      throw new ApiError(`Processor error on ${path}: ${json.message || 'HTTP ' + res.status} (code ${json.code})`, {
        status: res.status,
        code: json.code,
        path,
      });
    }
    return json;
  }

  async function connect() {
    const detail = await rawRequest('GET', '/node/open-detail', undefined, false);
    const d = detail.data || {};
    if (!d.sn || d.startTime === undefined) {
      throw new ApiError('open-detail did not return sn/startTime', { path: '/node/open-detail' });
    }
    token = buildToken(d.sn, d.startTime);
    deviceInfo = d;
    return d;
  }

  // Authenticated call. If it fails for any reason other than "unreachable",
  // rebuild the token and try exactly once more.
  async function request(method, path, body) {
    if (!token) await connect();
    try {
      return await rawRequest(method, path, body, true);
    } catch (err) {
      if (err.status === undefined && err.code === undefined) throw err; // network problem, retry won't help
      if (err.status === 404) throw err; // wrong endpoint, not an auth problem
      await connect();
      return rawRequest(method, path, body, true);
    }
  }

  return {
    mode: 'live',
    ip,
    port,
    connect,
    getDeviceInfo: () => deviceInfo,
    get: (path) => request('GET', path),
    put: (path, body) => request('PUT', path, body),
  };
}

module.exports = { createPixelhueClient, buildToken, ApiError };

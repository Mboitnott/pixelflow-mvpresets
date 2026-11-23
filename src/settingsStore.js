// Processor address set from the web page. Saved to data/settings.json so it
// survives a restart; falls back to PIXELHUE_IP / PIXELHUE_PORT from .env.

const fs = require('fs');
const path = require('path');

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function createSettingsStore(filePath, defaults) {
  function read() {
    try {
      return { ...defaults, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
    } catch (err) {
      if (err.code === 'ENOENT') return { ...defaults };
      throw err;
    }
  }

  function write(next) {
    const ip = String(next.ip ?? '').trim();
    const port = Number(next.port || 8088);
    if (ip && !IPV4.test(ip)) {
      const e = new Error('That is not a valid IP address (example: 10.0.0.58)');
      e.status = 400;
      throw e;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      const e = new Error('Port must be a number between 1 and 65535');
      e.status = 400;
      throw e;
    }
    const value = { ip, port };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
    return value;
  }

  return { read, write };
}

module.exports = { createSettingsStore };

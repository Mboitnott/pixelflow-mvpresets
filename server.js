// PixelFlow MVR Presets: local web server.
// Start with:  npm start

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { createPixelhueClient } = require('./src/pixelhueClient');
const { createSampleClient } = require('./src/sampleClient');
const { readOverview } = require('./src/processorService');
const { recallPreset } = require('./src/recallService');
const { createPresetStore } = require('./src/presetStore');
const { createSettingsStore } = require('./src/settingsStore');
const { buildPreset, captureDraft, presetToDraft } = require('./src/presetBuilder');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SAMPLES_DIR = path.join(__dirname, 'samples');

const store = createPresetStore(path.join(DATA_DIR, 'presets.json'));
const settings = createSettingsStore(path.join(DATA_DIR, 'settings.json'), {
  ip: (process.env.PIXELHUE_IP || '').trim(),
  port: Number(process.env.PIXELHUE_PORT || 8088),
});

// ---- processor connection (swappable when the IP changes from the web page)
let client = null;
function connectTo({ ip, port }) {
  client = ip ? createPixelhueClient({ ip, port }) : createSampleClient({ samplesDir: SAMPLES_DIR });
}
connectTo(settings.read());

// ---- helpers
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      data += chunk;
      if (data.length > 1e6) {
        // Over 1 MB: stop reading, drop the connection, and give up once.
        tooBig = true;
        data = '';
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new HttpError(400, 'Body must be JSON'));
      }
    });
    req.on('error', (err) => {
      if (!tooBig) reject(err);
    });
  });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 404, { error: 'Not found' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

// The address Companion should call: the Mac's IP on the same network as the processor.
function companionBase() {
  const { ip } = settings.read();
  const addrs = lanAddresses();
  const prefix = ip.split('.').slice(0, 3).join('.') + '.';
  const best = addrs.find((a) => ip && a.startsWith(prefix)) || addrs[0] || 'localhost';
  return `http://${best}:${PORT}`;
}

// ---- recall (one at a time)
let recallQueue = Promise.resolve();
let lastRecall = null;
function queueRecall(preset) {
  const run = recallQueue.then(() => recallPreset(client, preset));
  recallQueue = run.catch(() => {});
  return run.then(
    (result) => {
      lastRecall = { ...result, name: preset.name, at: new Date().toISOString() };
      console.log(`[recall] ${preset.id}: ${result.ok ? 'OK' : 'with problems'} in ${result.ms} ms` + (result.skipped.length ? `, skipped ${result.skipped.length}` : ''));
      return result;
    },
    (err) => {
      lastRecall = { ok: false, preset: preset.id, name: preset.name, error: err.message, at: new Date().toISOString() };
      throw err;
    }
  );
}

function getPreset(id) {
  const preset = store.get(decodeURIComponent(id));
  if (!preset) throw new HttpError(404, `No preset called "${decodeURIComponent(id)}"`);
  return preset;
}

// ---- routes
const routes = [
  ['GET', /^\/api\/overview$/, async () => ({ ...(await readOverview(client)), companionBase: companionBase() })],

  ['GET', /^\/api\/settings$/, () => ({ ...settings.read(), mode: client.mode, companionBase: companionBase(), lanAddresses: lanAddresses() })],
  [
    'PUT',
    /^\/api\/settings$/,
    async (req) => {
      const saved = settings.write(await readBody(req));
      connectTo(saved);
      return { ...saved, mode: client.mode, companionBase: companionBase() };
    },
  ],

  ['GET', /^\/api\/presets$/, () => store.list()],
  ['GET', /^\/api\/presets\/([^/]+)\/draft$/, (req, m) => presetToDraft(getPreset(m[1]))],
  [
    'POST',
    /^\/api\/presets$/,
    async (req) => {
      const body = await readBody(req);
      const state = await readOverview(client);
      if (body.id && !store.get(body.id)) throw new HttpError(404, 'That preset no longer exists');
      const preset = buildPreset(body, state);
      return store.save(preset);
    },
  ],
  [
    'DELETE',
    /^\/api\/presets\/([^/]+)$/,
    (req, m) => {
      if (!store.remove(decodeURIComponent(m[1]))) throw new HttpError(404, 'Preset not found');
      return { deleted: decodeURIComponent(m[1]) };
    },
  ],
  ['POST', /^\/api\/presets\/([^/]+)\/recall$/, (req, m) => queueRecall(getPreset(m[1]))],
  ['GET', /^\/api\/capture\/(\d+)$/, async (req, m) => captureDraft(Number(m[1]), await readOverview(client))],

  // Companion: a Generic HTTP GET button pointing at this URL.
  ['GET', /^\/recall\/([^/]+)$/, (req, m) => queueRecall(getPreset(m[1]))],
  ['GET', /^\/status$/, () => ({ lastRecall })],
];

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];
  let match = null;
  const route = routes.find(([method, re]) => method === req.method && (match = urlPath.match(re)));
  if (!route) {
    if (req.method === 'GET') return serveStatic(req, res);
    return sendJson(res, 404, { error: 'Not found' });
  }
  try {
    sendJson(res, 200, await route[2](req, match));
  } catch (err) {
    const status = err.status || 502;
    if (status >= 500) console.error(`[${req.method} ${urlPath}]`, err.message);
    sendJson(res, status, { error: err.message });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`Port ${PORT} is already in use. The app (or something else) is probably already running.`);
    console.error(`  To find it:   lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
    console.error('  To stop it:   kill <the number under PID>');
    console.error('  Or close the other Terminal window running the app, then run npm start again.');
    console.error('');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  const { ip, port } = settings.read();
  console.log('');
  console.log('PixelFlow MVR Presets is running.');
  console.log(`  On this Mac:     http://localhost:${PORT}`);
  for (const addr of lanAddresses()) console.log(`  From iPad/LAN:   http://${addr}:${PORT}`);
  console.log(
    ip
      ? `  Processor:       ${ip}:${port}`
      : `  Processor:       none set yet. Open the page and click "Processor…"${client.available ? ' (showing sample files for now)' : ''}`
  );
  console.log('  Stop it with Ctrl+C.');
  console.log('');
});

// Builds a shareable zip in dist/ for Mac and Windows.
// Only files on the INCLUDE list go in, so .env, presets, settings, logs,
// samples (serial number, token) and the PixelFlow manual never ship.
//
// Run: node tools/package.js

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NAME = 'mvr-presets';
const INCLUDE = [
  'README.md',
  'package.json',
  '.env.example',
  'server.js',
  'start.command',
  'start.bat',
  'src',
  'public',
  'tools/probeMvr.js',
  'tools/testPlanner.js',
];

const { version } = require(path.join(ROOT, 'package.json'));
const distDir = path.join(ROOT, 'dist');
const stageDir = path.join(distDir, NAME);
const zipPath = path.join(distDir, `${NAME}-${version}.zip`);

fs.rmSync(stageDir, { recursive: true, force: true });
fs.rmSync(zipPath, { force: true });
fs.mkdirSync(stageDir, { recursive: true });

for (const rel of INCLUDE) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) throw new Error(`Missing ${rel}`);
  fs.cpSync(src, path.join(stageDir, rel), { recursive: true });
}
fs.chmodSync(path.join(stageDir, 'start.command'), 0o755);

// zip keeps the executable bit on start.command so it double-clicks on a Mac.
execFileSync('zip', ['-r', '-X', '-q', zipPath, NAME], { cwd: distDir });
fs.rmSync(stageDir, { recursive: true, force: true });

const kb = Math.round(fs.statSync(zipPath).size / 1024);
console.log(`Built ${path.relative(ROOT, zipPath)} (${kb} KB)`);

// Step 2 probe: answers the open API questions on a real processor.
// Only touches ONE multiviewer (default MVR screenId 2) and restores its layout at the end.
//
// Run:  node --env-file=.env tools/probeMvr.js [mvrScreenId]

const fs = require('fs');
const path = require('path');
const { createPixelhueClient } = require('../src/pixelhueClient');
const model = require('../src/mvrModel');

const MVR_ID = Number(process.argv[2] || 2);
const PAUSE_MS = 3000;
const ip = process.env.PIXELHUE_IP;
if (!ip) throw new Error('Set PIXELHUE_IP in .env');
const client = createPixelhueClient({ ip, port: Number(process.env.PIXELHUE_PORT || 8088) });

const logDir = path.join(__dirname, '..', 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `probe-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log(line);
  fs.appendFileSync(logFile, line + '\n');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readMvrScreen() {
  const screens = model.normalizeScreens(await client.get('/screen/list-detail'));
  return screens.find((s) => s.screenId === MVR_ID);
}

async function readBoxes() {
  const json = await client.get(`/layers/list-detail?attachScreenId=${MVR_ID}`);
  return model.normalizeMvrLayers(json, MVR_ID);
}

async function waitForBoxes(expected, timeoutMs = 6000) {
  const t0 = Date.now();
  let boxes = await readBoxes();
  const immediate = boxes.length;
  while (boxes.length !== expected && Date.now() - t0 < timeoutMs) {
    await sleep(100);
    boxes = await readBoxes();
  }
  return { boxes, immediate, ms: Date.now() - t0 };
}

function selectBody(tpl, variant) {
  return {
    templateId: variant === 'id' ? tpl.id : tpl.templateId,
    templateType: tpl.templateType,
    screenId: MVR_ID,
    sceneType: 2,
    moduleType: 0,
    locked: 0,
  };
}

async function recall(tpl, variant) {
  const body = selectBody(tpl, variant);
  log(`  PUT /layers/template/select`, body);
  try {
    const r = await client.put('/layers/template/select', body);
    log(`  -> code ${r.code} ${r.message}`);
    return true;
  } catch (e) {
    log(`  -> FAILED: ${e.message}`);
    return false;
  }
}

function sortedCells(tpl) {
  return [...tpl.cells].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

function srcBrief(s) {
  return `${{ 2: 'IN', 3: 'PGM', 4: 'PVW' }[s.sourceType] || 'T' + s.sourceType}:${s.sourceId}(${s.name})`;
}

async function main() {
  log(`Probe on ${ip}, MVR screenId ${MVR_ID}. Log: ${logFile}`);
  await client.connect();

  const templates = model.normalizeTemplates(await client.get('/layers/template?moduleType=0'));
  const byKey = Object.fromEntries(templates.map((t) => [t.key, t]));
  const inputs = model.normalizeInputs(await client.get('/interface/list-detail'));
  const inputById = Object.fromEntries(inputs.map((i) => [i.interfaceId, i]));

  const start = await readMvrScreen();
  if (!start || !start.isMvr) throw new Error(`screenId ${MVR_ID} is not a multiviewer`);
  const original = byKey[start.currentTemplate];
  const startBoxes = await readBoxes();
  log(`Start: ${start.name} on ${start.currentTemplate} (${original?.label}), ${startBoxes.length} boxes`);

  const tplA = byKey['1:0'];
  const tplB = byKey['1:1'];
  const results = {};

  // ---- 1. Which ID does template/select want?
  log('\n[1] Recall Built-in 0 using templateId + templateType');
  await recall(tplA, 'templateId');
  await sleep(500);
  let scr = await readMvrScreen();
  log(`  screen now reports template ${scr.currentTemplate}`);
  if (scr.currentTemplate === tplA.key) {
    results.templateField = 'templateId + templateType';
  } else {
    log('  Did not take. Trying the id field instead.');
    await recall(tplA, 'id');
    await sleep(500);
    scr = await readMvrScreen();
    log(`  screen now reports template ${scr.currentTemplate}`);
    results.templateField = scr.currentTemplate === tplA.key ? 'id + templateType' : 'NEITHER WORKED';
  }
  if (results.templateField === 'NEITHER WORKED') throw new Error('Layout recall failed both ways, stopping.');
  const variant = results.templateField.startsWith('id') ? 'id' : 'templateId';

  // ---- 3. Wait needed?
  log('\n[2/3] Reading boxes after recall');
  let w = await waitForBoxes(tplA.cells.length);
  log(`  boxes right away: ${w.immediate}, after ${w.ms} ms: ${w.boxes.length} (template has ${tplA.cells.length})`);
  results.boxesImmediately = w.immediate;
  results.msUntilBoxesReady = w.ms;
  const idsA1 = w.boxes.map((b) => b.layerId);
  log('  boxes:', w.boxes.map((b) => `${b.layerId}@${b.rect.x},${b.rect.y} ${srcBrief(b.source)}`));

  // match boxes to template cells by sorted position
  const cellsA = sortedCells(tplA);
  log('  cell types (sorted):', cellsA.map((c) => ({ 2: 'IN', 3: 'PGM', 4: 'PVW' }[c.sourceType])));
  await sleep(PAUSE_MS);

  // ---- 4. Set sources incl. PGM/PVW in one call
  log('\n[4] Setting all boxes in one call');
  const pgmScreens = [5, 8, 9, 10];
  const inputPool = [1, 11, 9, 3, 7, 13, 2, 10];
  const groupScreen = {};
  let gi = 0;
  let ii = 0;
  const plan = w.boxes.map((box, i) => {
    const cell = cellsA[i];
    if (cell.sourceType === 3 || cell.sourceType === 4) {
      if (!(cell.group in groupScreen)) groupScreen[cell.group] = pgmScreens[gi++ % pgmScreens.length];
      return { layerId: box.layerId, source: { general: { sourceId: groupScreen[cell.group], sourceType: cell.sourceType, connectorType: 0 } } };
    }
    const inp = inputById[inputPool[ii++ % inputPool.length]];
    return { layerId: box.layerId, source: { general: { sourceId: inp.interfaceId, sourceType: 2, connectorType: inp.connectorType } } };
  });
  log('  PUT /layers/source', plan.map((p) => `${p.layerId}=>T${p.source.general.sourceType}:${p.source.general.sourceId}`));
  try {
    const r = await client.put('/layers/source', plan);
    log(`  -> code ${r.code} ${r.message}`);
  } catch (e) {
    log(`  -> FAILED: ${e.message}`);
  }
  await sleep(300);
  let after = await readBoxes();
  const mismatches = plan.filter((p) => {
    const b = after.find((x) => x.layerId === p.layerId);
    return !b || b.source.sourceType !== p.source.general.sourceType || b.source.sourceId !== p.source.general.sourceId;
  });
  log('  read back:', after.map((b) => srcBrief(b.source)));
  results.sourcesAllApplied = mismatches.length === 0;
  results.pgmPvwWork = plan
    .filter((p) => p.source.general.sourceType !== 2)
    .every((p) => !mismatches.includes(p));
  log(`  mismatches: ${mismatches.length}`);
  await sleep(PAUSE_MS);

  // ---- extra: can an input go into a PGM-type box (and PGM into an input box)?
  log('\n[extra] Input into a PGM-type cell, and PVW into an input-type cell');
  const pgmIdx = cellsA.findIndex((c) => c.sourceType === 3);
  const inIdx = cellsA.findIndex((c) => c.sourceType === 2);
  const swap = [];
  if (pgmIdx >= 0) swap.push({ layerId: w.boxes[pgmIdx].layerId, source: { general: { sourceId: 11, sourceType: 2, connectorType: inputById[11].connectorType } } });
  if (inIdx >= 0) swap.push({ layerId: w.boxes[inIdx].layerId, source: { general: { sourceId: 10, sourceType: 4, connectorType: 0 } } });
  try {
    const r = await client.put('/layers/source', swap);
    log(`  -> code ${r.code} ${r.message}`);
  } catch (e) {
    log(`  -> FAILED: ${e.message}`);
  }
  await sleep(300);
  after = await readBoxes();
  const swapOk = swap.map((p) => {
    const b = after.find((x) => x.layerId === p.layerId);
    return b && b.source.sourceType === p.source.general.sourceType && b.source.sourceId === p.source.general.sourceId;
  });
  results.inputInPgmCell = swapOk[0];
  results.pvwInInputCell = swapOk[1];
  log('  read back:', after.map((b) => srcBrief(b.source)));
  await sleep(PAUSE_MS);

  // ---- 2. Do IDs change across recalls? Do sources survive?
  log('\n[2] Recall Built-in 1, then Built-in 0 again, comparing box IDs');
  await recall(tplB, variant);
  w = await waitForBoxes(tplB.cells.length);
  const idsB = w.boxes.map((b) => b.layerId);
  log(`  Built-in 1: ${w.boxes.length} boxes after ${w.ms} ms, ids ${idsB.join(',')}`);
  log('  sources:', w.boxes.map((b) => srcBrief(b.source)));
  await sleep(PAUSE_MS);

  await recall(tplA, variant);
  w = await waitForBoxes(tplA.cells.length);
  const idsA2 = w.boxes.map((b) => b.layerId);
  log(`  Built-in 0 again: ${w.boxes.length} boxes after ${w.ms} ms, ids ${idsA2.join(',')}`);
  log('  sources:', w.boxes.map((b) => srcBrief(b.source)));
  results.idsSameAfterReRecall = JSON.stringify(idsA1) === JSON.stringify(idsA2);
  results.idsReusedAcrossLayouts = idsB.some((id) => idsA1.includes(id));
  results.idsA1 = idsA1;
  results.idsA2 = idsA2;
  results.idsB = idsB;
  await sleep(PAUSE_MS);

  // ---- restore
  log(`\n[restore] Recalling original layout ${original.key}`);
  await recall(original, variant);
  await sleep(800);
  scr = await readMvrScreen();
  const endBoxes = await readBoxes();
  log(`  ${scr.name} now on ${scr.currentTemplate}, ${endBoxes.length} boxes`, endBoxes.map((b) => srcBrief(b.source)));
  results.restored = scr.currentTemplate === original.key;

  log('\n=== RESULTS ===');
  log(results);
}

main().catch((e) => {
  log('PROBE STOPPED:', e.message);
  process.exitCode = 1;
});

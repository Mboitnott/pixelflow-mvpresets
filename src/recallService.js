// Recalls a saved preset on the processor:
//   1. switch the MVR to the preset's layout (skipped if it's already on it)
//   2. wait for the processor to create and auto-fill the boxes
//   3. move sources into place in a safe order (see recallPlanner.js), one call per box
//   4. read back and report what landed, what was skipped and why

const model = require('./mvrModel');
const { planRecall } = require('./recallPlanner');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readState(client) {
  const [screensJson, layersJson, templatesJson, inputsJson] = await Promise.all([
    client.get('/screen/list-detail'),
    client.get('/layers/list-detail'),
    client.get('/layers/template?moduleType=0'),
    client.get('/interface/list-detail'),
  ]);
  const screens = model.normalizeScreens(screensJson);
  return {
    screens,
    pickable: model.pickableScreens(screens),
    templates: model.normalizeTemplates(templatesJson),
    inputs: model.normalizeInputs(inputsJson),
    layersJson,
  };
}

async function readBoxes(client, mvrScreenId) {
  return model.normalizeMvrLayers(await client.get(`/layers/list-detail?attachScreenId=${mvrScreenId}`), mvrScreenId);
}

// Boxes appear almost at once, but wait until the count stops changing to be safe.
async function waitForBoxes(client, mvrScreenId, expected, timeoutMs = 3000) {
  const t0 = Date.now();
  let last = -1;
  let stableReads = 0;
  let boxes = [];
  while (Date.now() - t0 < timeoutMs) {
    boxes = await readBoxes(client, mvrScreenId);
    if (boxes.length === expected) return boxes;
    stableReads = boxes.length === last ? stableReads + 1 : 0;
    if (stableReads >= 3) return boxes;
    last = boxes.length;
    await sleep(100);
  }
  return boxes;
}

// Find the layout to recall: the one the preset names, or any built-in/custom layout with the same boxes.
function findLayout(templates, preset) {
  const byKey = templates.find((t) => t.key === preset.layout.key && model.isPickableLayout(t));
  if (byKey && model.sameCells(byKey.cells, preset.cells)) return byKey;
  return templates.find((t) => model.isPickableLayout(t) && model.sameCells(t.cells, preset.cells)) || null;
}

function describeSource(sourceType, sourceId, state) {
  if (sourceType === model.SOURCE_INPUT) return state.inputs.find((i) => i.interfaceId === sourceId)?.name || `Input ${sourceId}`;
  const name = state.screens.find((s) => s.screenId === sourceId)?.name || `Screen ${sourceId}`;
  return `${name} ${sourceType === model.SOURCE_PGM ? 'PGM' : 'PVW'}`;
}

async function recallPreset(client, preset) {
  const t0 = Date.now();
  await client.connect();
  let state = await readState(client);

  const mvr = state.screens.find((s) => s.screenId === preset.mvrScreenId && s.isMvr);
  if (!mvr) throw new Error(`Multiviewer screenId ${preset.mvrScreenId} not found`);

  // The MVR's own slot (screen template) holds a copy of whatever layout it's showing.
  const slot = state.templates.find((t) => t.key === mvr.currentTemplate);
  const alreadyOnLayout = !!slot && model.sameCells(slot.cells, preset.cells);
  const layout = alreadyOnLayout ? findLayout(state.templates, preset) || { label: preset.layout.label } : findLayout(state.templates, preset);
  if (!layout) throw new Error(`Layout "${preset.layout.label}" is no longer on the processor`);

  let boxes;
  if (alreadyOnLayout) {
    boxes = await readBoxes(client, mvr.screenId);
  } else {
    await client.put('/layers/template/select', {
      templateId: layout.templateId,
      templateType: layout.templateType,
      screenId: mvr.screenId,
      sceneType: 2,
      moduleType: 0,
      locked: 0,
    });
    boxes = await waitForBoxes(client, mvr.screenId, layout.cells.length);
    state = await readState(client); // other MVRs' usage may matter, refresh everything
  }

  const otherUsed = new Set();
  for (const s of state.screens.filter((x) => x.isMvr && x.screenId !== mvr.screenId)) {
    for (const b of model.normalizeMvrLayers(state.layersJson, s.screenId)) otherUsed.add(model.sourceKey(b.source.sourceType, b.source.sourceId));
  }

  const available = {
    [model.SOURCE_INPUT]: state.inputs.filter((i) => i.enabled).map((i) => model.sourceKey(model.SOURCE_INPUT, i.interfaceId)),
    [model.SOURCE_PGM]: state.pickable.map((s) => model.sourceKey(model.SOURCE_PGM, s.screenId)),
    [model.SOURCE_PVW]: state.pickable.map((s) => model.sourceKey(model.SOURCE_PVW, s.screenId)),
  };

  const wanted = new Map(preset.cells.filter((c) => c.source).map((c) => [c.index, c.source]));
  const pairs = model.matchBoxesToCells(preset.cells, boxes);
  const { steps, skipped } = planRecall({ pairs, wanted, otherUsed, available });

  const failed = [];
  for (const step of steps) {
    try {
      await client.put('/layers/source', [
        {
          layerId: step.layerId,
          source: {
            general: {
              sourceId: step.sourceId,
              sourceType: step.sourceType,
              connectorType:
                step.sourceType === model.SOURCE_INPUT ? state.inputs.find((i) => i.interfaceId === step.sourceId)?.connectorType || 0 : 0,
            },
          },
        },
      ]);
    } catch (err) {
      failed.push({ ...step, error: err.message });
    }
  }

  // Read back and check every wanted box.
  const finalBoxes = await readBoxes(client, mvr.screenId);
  const finalPairs = model.matchBoxesToCells(preset.cells, finalBoxes);
  const skippedCells = new Set(skipped.map((s) => s.cellIndex));
  const mismatched = [];
  for (const { cell, box } of finalPairs) {
    const want = wanted.get(cell.index);
    if (!want || skippedCells.has(cell.index)) continue;
    if (!box || box.source.sourceType !== want.sourceType || box.source.sourceId !== want.sourceId) {
      mismatched.push({ cellIndex: cell.index, wanted: describeSource(want.sourceType, want.sourceId, state), got: box ? describeSource(box.source.sourceType, box.source.sourceId, state) : 'no box' });
    }
  }

  return {
    ok: mismatched.length === 0 && failed.length === 0,
    preset: preset.id,
    mvr: mvr.name,
    layout: layout.label,
    layoutChanged: !alreadyOnLayout,
    changes: steps.length,
    temporarySwaps: steps.filter((s) => s.temporary).length,
    skipped: skipped.map((s) => ({ box: s.cellIndex + 1, source: describeSource(s.sourceType, s.sourceId, state), reason: s.reason })),
    failed: failed.map((f) => ({ box: f.cellIndex + 1, source: describeSource(f.sourceType, f.sourceId, state), error: f.error })),
    mismatched,
    ms: Date.now() - t0,
  };
}

module.exports = { recallPreset };

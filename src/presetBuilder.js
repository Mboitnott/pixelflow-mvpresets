// Builds preset objects: from the editor's choices, or by capturing what an MVR shows now.
// Pure functions over normalized processor data (see mvrModel.js).

const model = require('./mvrModel');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function sourceName(source, state) {
  if (source.sourceType === model.SOURCE_INPUT) {
    return state.inputs.find((i) => i.interfaceId === source.sourceId)?.name || `Input ${source.sourceId}`;
  }
  const screen = state.screens.find((s) => s.screenId === source.sourceId);
  return `${screen?.name || 'Screen ' + source.sourceId} ${source.sourceType === model.SOURCE_PGM ? 'PGM' : 'PVW'}`;
}

function isKnownSource(source, state) {
  if (source.sourceType === model.SOURCE_INPUT) return state.inputs.some((i) => i.interfaceId === source.sourceId && i.enabled);
  if (source.sourceType === model.SOURCE_PGM || source.sourceType === model.SOURCE_PVW) {
    return state.screens.some((s) => s.screenId === source.sourceId);
  }
  return false;
}

// input: { id?, name, mvrScreenId, layoutKey, sources: { [cellIndex]: { sourceType, sourceId } } }
// state: { templates, inputs, screens (pickable), mvrs }
function buildPreset(input, state) {
  const name = String(input.name || '').trim();
  if (!name) throw new ValidationError('Give the preset a name');
  if (name.length > 60) throw new ValidationError('Name is too long (60 characters max)');

  const mvrScreenId = Number(input.mvrScreenId);
  if (!state.mvrs.some((m) => m.screenId === mvrScreenId)) throw new ValidationError('Pick a multiviewer');

  const layout = state.templates.find((t) => t.key === input.layoutKey && model.isPickableLayout(t));
  if (!layout) throw new ValidationError('Pick a layout');

  const sources = input.sources || {};
  const seen = new Set();
  const cells = layout.cells.map((cell) => {
    const raw = sources[cell.index];
    let source = null;
    if (raw) {
      source = { sourceType: Number(raw.sourceType), sourceId: Number(raw.sourceId) };
      if (!model.cellAccepts(cell, source.sourceType)) throw new ValidationError(`Box ${cell.index + 1}: wrong kind of source for this box`);
      if (!isKnownSource(source, state)) throw new ValidationError(`Box ${cell.index + 1}: that source isn't available`);
      const key = model.sourceKey(source.sourceType, source.sourceId);
      if (seen.has(key)) throw new ValidationError(`${sourceName(source, state)} is in more than one box`);
      seen.add(key);
      source.name = sourceName(source, state);
    }
    return { index: cell.index, sourceType: cell.sourceType, rect: cell.rect, source };
  });

  return {
    id: input.id || undefined,
    name,
    mvrScreenId,
    layout: { templateId: layout.templateId, templateType: layout.templateType, key: layout.key, label: layout.label },
    cells,
  };
}

// What an MVR shows right now, as editor input (not saved yet).
function captureDraft(mvrScreenId, state) {
  const mvr = state.mvrs.find((m) => m.screenId === Number(mvrScreenId));
  if (!mvr) throw new ValidationError('Multiviewer not found');
  const layout = model.detectLayout(state.templates, mvr.currentTemplate);
  if (!layout) {
    throw new ValidationError(
      `${mvr.name}'s current layout doesn't match any built-in or custom layout, so it can't be recalled. ` +
        'Pick a layout in PixelFlow (or save it as a custom layout) and capture again.'
    );
  }
  const sources = {};
  for (const { cell, box } of model.matchBoxesToCells(layout.cells, mvr.boxes)) {
    if (box) sources[cell.index] = { sourceType: box.source.sourceType, sourceId: box.source.sourceId };
  }
  return { name: '', mvrScreenId: mvr.screenId, layoutKey: layout.key, sources };
}

// Editor input from a saved preset (for Edit / Duplicate).
function presetToDraft(preset) {
  const sources = {};
  for (const c of preset.cells) if (c.source) sources[c.index] = { sourceType: c.source.sourceType, sourceId: c.source.sourceId };
  return { id: preset.id, name: preset.name, mvrScreenId: preset.mvrScreenId, layoutKey: preset.layout.key, sources };
}

module.exports = { buildPreset, captureDraft, presetToDraft, ValidationError };

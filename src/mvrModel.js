// Turns raw processor JSON into the simple shapes the app uses.
// Pure functions: no network, no UI.

const CANVAS_W = 1920;
const CANVAS_H = 1080;

const SCREEN_TYPE_MVR = 8;
const LAYER_TYPE_MVR = 8;
const INTERFACE_TYPE_INPUT = 2;

const SOURCE_INPUT = 2;
const SOURCE_PGM = 3;
const SOURCE_PVW = 4;

const TEMPLATE_TYPE_NAMES = { 1: 'Built-in', 2: 'Custom', 3: 'Aging test', 4: 'Screen template' };

function templateKey(templateType, templateId) {
  return `${templateType}:${templateId}`;
}

function listOf(json) {
  const d = json?.data;
  if (Array.isArray(d)) return d;
  return d?.list || [];
}

function normalizeScreens(json) {
  return listOf(json).map((s) => ({
    screenId: s.screenId,
    name: s.general?.name || '',
    type: s.screenIdObj?.type,
    isMvr: s.screenIdObj?.type === SCREEN_TYPE_MVR,
    currentTemplate: s.template && s.template.type ? templateKey(s.template.type, s.template.id) : null,
  }));
}

// Screens whose PGM/PVW can go in a box (everything named that isn't an MVR).
function pickableScreens(screens) {
  return screens.filter((s) => !s.isMvr && s.name);
}

function normalizeInputs(json) {
  return listOf(json)
    .filter((i) => i.auxiliaryInfo?.connectorInfo?.interfaceType === INTERFACE_TYPE_INPUT)
    .map((i) => ({
      interfaceId: i.interfaceId,
      name: i.general?.name || `Input ${i.interfaceId}`,
      connectorType: i.auxiliaryInfo.connectorInfo.type,
      // workMode 2 = disabled (manual 3.1). Disabled inputs can't go in a box.
      enabled: i.auxiliaryInfo.connectorInfo.workMode !== 2,
    }));
}

function cellRect(cell, template) {
  if (cell.widthCoefficient > 0 && cell.heightCoefficient > 0) {
    return { x: cell.xCoefficient, y: cell.yCoefficient, w: cell.widthCoefficient, h: cell.heightCoefficient };
  }
  // Grid-only custom templates: lay cells on layout[0].row x column inside the margins.
  const grid = (template.layout && template.layout[0]) || { row: 1, column: 1 };
  const m = template.margin || { top: 0, bottom: 0, left: 0, right: 0 };
  const cw = (CANVAS_W - m.left - m.right) / (grid.column || 1);
  const ch = (CANVAS_H - m.top - m.bottom) / (grid.row || 1);
  return {
    x: Math.round(m.left + cell.column * cw),
    y: Math.round(m.top + cell.row * ch),
    w: Math.round((cell.columnSpan || 1) * cw),
    h: Math.round((cell.rowSpan || 1) * ch),
  };
}

function normalizeTemplates(json) {
  return listOf(json).map((t) => {
    const cells = (t.cells || []).map((c, index) => ({
      index,
      sourceType: c.sourceType,
      group: c.group,
      rect: cellRect(c, t),
    }));
    const typeName = TEMPLATE_TYPE_NAMES[t.templateType] || `Type ${t.templateType}`;
    return {
      key: templateKey(t.templateType, t.templateId),
      id: t.id,
      templateId: t.templateId,
      templateType: t.templateType,
      label: `${typeName} ${t.templateId} (${cells.length} box${cells.length === 1 ? '' : 'es'})`,
      cells,
    };
  });
}

function normalizeMvrLayers(json, mvrScreenId) {
  return listOf(json)
    .filter((l) => l.layerIdObj?.type === LAYER_TYPE_MVR && l.layerIdObj?.attachScreenId === mvrScreenId)
    .map((l) => {
      const g = l.source?.general || {};
      return {
        layerId: l.layerId,
        rect: { x: l.window.x, y: l.window.y, w: l.window.width, h: l.window.height },
        source: { sourceType: g.sourceType, sourceId: g.sourceId, connectorType: g.connectorType, name: g.sourceName || '' },
      };
    })
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

function sourceKey(sourceType, sourceId) {
  return `${sourceType}:${sourceId}`;
}

function sameRect(a, b, tolerance = 4) {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.w - b.w) <= tolerance &&
    Math.abs(a.h - b.h) <= tolerance
  );
}

// Two layouts are "the same" if they have the same boxes in the same places with the same kinds.
function sameCells(cellsA, cellsB) {
  if (cellsA.length !== cellsB.length) return false;
  const used = new Set();
  return cellsA.every((a) => {
    const i = cellsB.findIndex((b, j) => !used.has(j) && b.sourceType === a.sourceType && sameRect(a.rect, b.rect));
    if (i < 0) return false;
    used.add(i);
    return true;
  });
}

function centerInside(box, rect) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
}

// For each cell, the box (layer) sitting in it, or null if the P80 didn't create one.
// Exact position first; otherwise a box whose center falls inside the cell (grid-only
// custom layouts can end up a few pixels off from the computed cell).
function matchBoxesToCells(cells, boxes) {
  const free = new Set(boxes.map((b) => b.layerId));
  const result = cells.map((cell) => {
    const box = boxes.find((b) => free.has(b.layerId) && sameRect(cell.rect, b.rect));
    if (box) free.delete(box.layerId);
    return { cell, box: box || null };
  });
  for (const pair of result) {
    if (pair.box) continue;
    const box = boxes.find((b) => free.has(b.layerId) && centerInside(b.rect, pair.cell.rect));
    if (box) {
      free.delete(box.layerId);
      pair.box = box;
    }
  }
  return result;
}

// Kind 0 cells (some custom layouts) take any source; others only their own kind.
function cellAccepts(cell, sourceType) {
  return !cell.sourceType || cell.sourceType === sourceType;
}

// Layouts people can pick: built-in and custom. (Type 3 is an aging test, type 4 is each MVR's own slot.)
function isPickableLayout(t) {
  return t.templateType === 1 || t.templateType === 2;
}

// Which pickable layout an MVR is showing, by comparing its slot copy to the real layouts.
function detectLayout(templates, slotKey) {
  const slot = templates.find((t) => t.key === slotKey);
  if (!slot) return null;
  return templates.find((t) => isPickableLayout(t) && sameCells(t.cells, slot.cells)) || null;
}

module.exports = {
  CANVAS_W,
  CANVAS_H,
  SOURCE_INPUT,
  SOURCE_PGM,
  SOURCE_PVW,
  templateKey,
  normalizeScreens,
  pickableScreens,
  normalizeInputs,
  normalizeTemplates,
  normalizeMvrLayers,
  sourceKey,
  sameRect,
  sameCells,
  matchBoxesToCells,
  cellAccepts,
  isPickableLayout,
  detectLayout,
};

// MVR Presets web page: preset list, editor, live view, settings.

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const KIND = { 0: 'any', 2: 'input', 3: 'pgm', 4: 'pvw' };
const KIND_LABEL = { 0: 'Any-source box', 2: 'Input box', 3: 'PGM box', 4: 'PVW box' };

const state = {
  overview: null, // from /api/overview
  presets: [],
  draft: null, // { id?, name, mvrScreenId, layoutKey, sources: {cellIndex: {sourceType, sourceId}} }
  pickerCell: null,
  lastRecallId: null,
};

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

// ---------- lookups
const keyOf = (s) => `${s.sourceType}:${s.sourceId}`;
const templatesByKey = () => Object.fromEntries(state.overview.templates.map((t) => [t.key, t]));
const pickableLayouts = () => state.overview.templates.filter((t) => t.templateType === 1 || t.templateType === 2);
const mvrName = (id) => state.overview?.mvrs.find((m) => m.screenId === id)?.name || `MVR ${id}`;

function sourceName(src) {
  if (!src) return '';
  if (src.sourceType === 2) return state.overview?.inputs.find((i) => i.interfaceId === src.sourceId)?.name || src.name || `Input ${src.sourceId}`;
  const scr = state.overview?.screens.find((s) => s.screenId === src.sourceId);
  return scr?.name || src.name?.replace(/ (PGM|PVW)$/, '') || `Screen ${src.sourceId}`;
}

// sourceKey -> name of the MVR currently showing it
function usageMap() {
  const map = {};
  for (const m of state.overview?.mvrs || []) for (const b of m.boxes) map[keyOf(b.source)] = m;
  return map;
}

// ---------- drawing
function placeBox(rect, cls, content, attrs = {}) {
  return el(
    'div',
    {
      class: `box ${cls}`,
      style: {
        left: `${(rect.x / CANVAS_W) * 100}%`,
        top: `${(rect.y / CANVAS_H) * 100}%`,
        width: `${(rect.w / CANVAS_W) * 100}%`,
        height: `${(rect.h / CANVAS_H) * 100}%`,
      },
      ...attrs,
    },
    content
  );
}

function boxContent(src) {
  if (!src) return [];
  if (src.sourceType === 3 || src.sourceType === 4) return [el('span', { class: 'tag' }, src.sourceType === 3 ? 'PGM' : 'PVW'), sourceName(src)];
  return [sourceName(src)];
}

function drawLayoutThumb(cells, sourcesByIndex = {}) {
  const canvas = el('div', { class: 'canvas' });
  for (const c of cells) {
    const src = sourcesByIndex[c.index];
    canvas.append(placeBox(c.rect, `${KIND[src ? src.sourceType : c.sourceType] || 'empty'}${src ? '' : ' unset'}`, ''));
  }
  return canvas;
}

// ---------- status + toast
function renderStatus(device, error) {
  const s = $('status');
  s.replaceChildren();
  if (error) {
    s.className = 'status bad';
    s.append(el('span', { class: 'dot' }), `Not connected: ${error}`);
    return;
  }
  const sample = device.mode === 'sample';
  s.className = `status ${sample ? 'sample' : 'ok'}`;
  s.append(
    el('span', { class: 'dot' }),
    `${device.model} · SN ${device.sn} · ${device.firmware} · ${sample ? 'SAMPLE DATA (set the processor IP)' : device.address}`
  );
}

let toastTimer = null;
function toast(kind, title, items = []) {
  const t = $('toast');
  t.className = `toast ${kind}`;
  t.replaceChildren(el('div', {}, title), items.length ? el('ul', {}, items.map((i) => el('li', {}, i))) : null);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), items.length ? 9000 : 3500);
}
$('toast').addEventListener('click', () => ($('toast').hidden = true));

// ---------- copy (works over plain http on an iPad too)
async function copyText(text) {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

// ---------- preset list
function presetUrl(p) {
  return `${state.overview?.companionBase || location.origin}/recall/${encodeURIComponent(p.id)}`;
}

function renderPresets() {
  const wrap = $('presets');
  wrap.replaceChildren();
  if (!state.presets.length) {
    wrap.append(el('div', { class: 'empty-note' }, 'No presets yet. Press "+ New preset", or "Capture" on a multiviewer below to save what it shows now.'));
    return;
  }
  for (const p of state.presets) {
    const sources = Object.fromEntries(p.cells.filter((c) => c.source).map((c) => [c.index, c.source]));
    const used = p.cells.filter((c) => c.source).length;
    const urlInput = el('input', { readonly: true, value: presetUrl(p), onfocus: (e) => e.target.select() });
    wrap.append(
      el('div', { class: `preset${state.lastRecallId === p.id ? ' last' : ''}` }, [
        el('div', { class: 'top' }, [
          el('div', { class: 'thumb' }, drawLayoutThumb(p.cells, sources)),
          el('div', { class: 'info' }, [
            el('div', { class: 'name' }, p.name),
            el('div', { class: 'meta' }, `${mvrName(p.mvrScreenId)} · ${p.layout.label}`),
            el('div', { class: 'meta' }, `${used} of ${p.cells.length} boxes set`),
          ]),
        ]),
        el('div', { class: 'url' }, [
          urlInput,
          el(
            'button',
            {
              onclick: async () => {
                const ok = await copyText(urlInput.value);
                if (ok) toast('ok', 'Companion URL copied');
                else {
                  urlInput.focus();
                  urlInput.select();
                  toast('warn', 'Copy blocked by the browser. The URL is selected, copy it manually.');
                }
              },
            },
            'Copy'
          ),
        ]),
        el('div', { class: 'row' }, [
          el('button', { class: 'primary big', onclick: (e) => recall(p, e.currentTarget) }, 'Recall'),
          el('button', { onclick: () => openEditorFor(p.id, false) }, 'Edit'),
          el('button', { onclick: () => openEditorFor(p.id, true) }, 'Duplicate'),
          el('span', { class: 'spacer' }),
          el('button', { class: 'danger', onclick: () => removePreset(p) }, 'Delete'),
        ]),
      ])
    );
  }
}

async function recall(p, button) {
  if (button) button.disabled = true;
  try {
    const r = await api('POST', `/api/presets/${encodeURIComponent(p.id)}/recall`);
    state.lastRecallId = p.id;
    const problems = [
      ...r.skipped.map((s) => `Box ${s.box} (${s.source}): ${s.reason}`),
      ...r.failed.map((f) => `Box ${f.box} (${f.source}): ${f.error}`),
      ...r.mismatched.map((m) => `Box ${m.cellIndex + 1}: wanted ${m.wanted}, shows ${m.got}`),
    ];
    toast(problems.length ? 'warn' : 'ok', `Recalled "${p.name}" on ${r.mvr} in ${r.ms} ms${problems.length ? ' with notes:' : ''}`, problems);
    renderPresets();
    loadOverview();
  } catch (err) {
    toast('bad', `Recall failed: ${err.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

async function removePreset(p) {
  if (!confirm(`Delete "${p.name}"? Companion buttons using its URL will stop working.`)) return;
  try {
    await api('DELETE', `/api/presets/${encodeURIComponent(p.id)}`);
    await loadPresets();
    toast('ok', `Deleted "${p.name}"`);
  } catch (err) {
    toast('bad', err.message);
  }
}

// ---------- live view
function renderMvrs() {
  const tpls = templatesByKey();
  const wrap = $('mvrs');
  wrap.replaceChildren();
  for (const mvr of state.overview.mvrs) {
    const layout = tpls[mvr.layoutKey];
    const canvas = el('div', { class: 'canvas' });
    // Cells the processor left without a box show as grey "empty" underneath the real boxes.
    for (const c of tpls[mvr.currentTemplate]?.cells || []) canvas.append(placeBox(c.rect, 'empty', 'empty'));
    for (const b of mvr.boxes) canvas.append(placeBox(b.rect, KIND[b.source.sourceType] || 'empty', boxContent(b.source)));
    wrap.append(
      el('div', { class: 'mvr-card' }, [
        el('div', { class: 'head' }, [
          el('h3', { style: { margin: 0 } }, mvr.name),
          el('button', { onclick: () => capture(mvr.screenId), disabled: !layout, title: layout ? 'Save what this multiviewer shows as a new preset' : 'Layout not recognised' }, 'Capture as preset'),
        ]),
        el('div', { class: 'meta' }, `${layout ? layout.label : 'Layout not matched to a built-in/custom layout'} · ${mvr.boxes.length} boxes`),
        canvas,
      ])
    );
  }
}

function renderDetails() {
  const ov = state.overview;
  const wrap = $('templates');
  wrap.replaceChildren();
  for (const t of ov.templates) {
    const on = ov.mvrs.filter((m) => m.layoutKey === t.key).map((m) => m.name);
    wrap.append(
      el('div', { class: 'template-card' }, [
        drawLayoutThumb(t.cells),
        el('div', { class: 'label' }, t.label),
        el('div', { class: 'sub' }, `templateId ${t.templateId} · type ${t.templateType}${on.length ? ' · on ' + on.join(', ') : ''}`),
      ])
    );
  }
  const inputs = $('inputs');
  inputs.replaceChildren(el('tr', {}, ['ID', 'Name', 'Status'].map((h) => el('th', {}, h))));
  for (const i of ov.inputs) inputs.append(el('tr', { class: i.enabled ? '' : 'off' }, [el('td', {}, i.interfaceId), el('td', {}, i.name), el('td', {}, i.enabled ? 'enabled' : 'disabled')]));
  const screens = $('screens');
  screens.replaceChildren(el('tr', {}, ['ID', 'Name'].map((h) => el('th', {}, h))));
  for (const s of ov.screens) screens.append(el('tr', {}, [el('td', {}, s.screenId), el('td', {}, s.name)]));
}

// ---------- editor
function openEditor(draft, title) {
  state.draft = { sources: {}, ...draft };
  $('editor-title').textContent = title;
  $('f-name').value = state.draft.name || '';
  $('f-mvr').replaceChildren(...state.overview.mvrs.map((m) => el('option', { value: m.screenId, selected: m.screenId === state.draft.mvrScreenId }, m.name)));
  $('f-layout').replaceChildren(...pickableLayouts().map((t) => el('option', { value: t.key, selected: t.key === state.draft.layoutKey }, t.label)));
  state.draft.mvrScreenId = Number($('f-mvr').value);
  state.draft.layoutKey = $('f-layout').value;
  $('editor-error').hidden = true;
  renderEditor();
  $('editor').showModal();
  if (!state.draft.name) $('f-name').focus();
}

async function openEditorFor(id, duplicate) {
  try {
    const draft = await api('GET', `/api/presets/${encodeURIComponent(id)}/draft`);
    if (duplicate) {
      delete draft.id;
      draft.name = `${draft.name} copy`;
    }
    openEditor(draft, duplicate ? 'Duplicate preset' : `Edit "${draft.name}"`);
  } catch (err) {
    toast('bad', err.message);
  }
}

async function capture(mvrScreenId) {
  try {
    await loadOverview();
    const draft = await api('GET', `/api/capture/${mvrScreenId}`);
    openEditor(draft, `Capture ${mvrName(mvrScreenId)}`);
  } catch (err) {
    toast('bad', err.message);
  }
}

function currentLayout() {
  return templatesByKey()[state.draft.layoutKey];
}

function renderEditor() {
  const layout = currentLayout();
  const canvas = $('editor-canvas');
  canvas.replaceChildren();
  const usage = usageMap();
  const warnings = [];
  if (!layout) return;
  for (const cell of layout.cells) {
    const src = state.draft.sources[cell.index];
    const onOther = src && usage[keyOf(src)] && usage[keyOf(src)].screenId !== state.draft.mvrScreenId ? usage[keyOf(src)] : null;
    if (onOther) warnings.push(`Box ${cell.index + 1}: ${sourceName(src)} is on ${onOther.name} right now, so it will be skipped while it's there.`);
    const cls = src ? KIND[src.sourceType] : `${KIND[cell.sourceType] || 'empty'} unset`;
    canvas.append(
      placeBox(
        cell.rect,
        `${cls}${onOther ? ' conflict' : ''}`,
        [el('span', { class: 'num' }, cell.index + 1), ...(src ? boxContent(src) : ['tap to pick'])],
        { onclick: () => openPicker(cell), role: 'button', tabindex: '0' }
      )
    );
  }
  const w = $('editor-warnings');
  w.replaceChildren(...warnings.map((t) => el('div', {}, t)));
}

$('f-name').addEventListener('input', (e) => (state.draft.name = e.target.value));
$('f-mvr').addEventListener('change', (e) => {
  state.draft.mvrScreenId = Number(e.target.value);
  renderEditor();
});
$('f-layout').addEventListener('change', (e) => {
  const had = Object.keys(state.draft.sources).length;
  if (had && !confirm('Changing the layout clears the boxes you picked. Continue?')) {
    e.target.value = state.draft.layoutKey;
    return;
  }
  state.draft.layoutKey = e.target.value;
  state.draft.sources = {};
  renderEditor();
});
$('clear-boxes').addEventListener('click', () => {
  state.draft.sources = {};
  renderEditor();
});
const closeEditor = () => $('editor').close();
$('editor-close').addEventListener('click', closeEditor);
$('editor-cancel').addEventListener('click', closeEditor);
$('editor-save').addEventListener('click', () => saveDraft(false));
$('editor-save-recall').addEventListener('click', () => saveDraft(true));

async function saveDraft(andRecall) {
  $('editor-error').hidden = true;
  try {
    const saved = await api('POST', '/api/presets', state.draft);
    closeEditor();
    await loadPresets();
    if (andRecall) await recall(saved);
    else toast('ok', `Saved "${saved.name}"`);
  } catch (err) {
    $('editor-error').textContent = err.message;
    $('editor-error').hidden = false;
  }
}

// ---------- source picker
function openPicker(cell) {
  state.pickerCell = cell;
  const kinds = cell.sourceType ? [cell.sourceType] : [2, 3, 4];
  const current = state.draft.sources[cell.index];
  const usage = usageMap();
  const inPreset = {};
  for (const [idx, s] of Object.entries(state.draft.sources)) if (Number(idx) !== cell.index) inPreset[keyOf(s)] = Number(idx) + 1;

  const list = $('picker-list');
  list.replaceChildren();
  list.append(
    el('button', { class: `opt${current ? '' : ' current'}`, onclick: () => pick(null) }, [
      el('span', { class: 'label' }, [el('span', { class: 'swatch', style: { background: 'var(--empty)' } }), 'Leave empty (processor decides)']),
    ])
  );

  const option = (src, label) => {
    const k = keyOf(src);
    const other = usage[k] && usage[k].screenId !== state.draft.mvrScreenId ? usage[k] : null;
    const takenHere = inPreset[k];
    const note = takenHere ? `already in box ${takenHere}` : other ? `on ${other.name} now` : '';
    return el(
      'button',
      { class: `opt${current && keyOf(current) === k ? ' current' : ''}`, disabled: !!takenHere, onclick: () => pick(src) },
      [el('span', { class: 'label' }, [el('span', { class: 'swatch', style: { background: `var(--${KIND[src.sourceType]})` } }), label]), note ? el('span', { class: 'note' }, note) : null]
    );
  };

  if (kinds.includes(2)) {
    list.append(el('h4', {}, 'Inputs'));
    for (const i of state.overview.inputs.filter((x) => x.enabled)) list.append(option({ sourceType: 2, sourceId: i.interfaceId }, i.name));
  }
  for (const kind of [3, 4]) {
    if (!kinds.includes(kind)) continue;
    list.append(el('h4', {}, kind === 3 ? 'Program (PGM)' : 'Preview (PVW)'));
    for (const s of state.overview.screens) list.append(option({ sourceType: kind, sourceId: s.screenId }, `${s.name} ${kind === 3 ? 'PGM' : 'PVW'}`));
  }

  $('picker-title').textContent = `Box ${cell.index + 1} · ${KIND_LABEL[cell.sourceType] || 'Box'}`;
  $('picker').showModal();
}

function pick(src) {
  const idx = state.pickerCell.index;
  if (src) state.draft.sources[idx] = src;
  else delete state.draft.sources[idx];
  $('picker').close();
  renderEditor();
}
$('picker-close').addEventListener('click', () => $('picker').close());

// ---------- settings
async function openSettings() {
  $('settings-error').hidden = true;
  try {
    const s = await api('GET', '/api/settings');
    $('s-ip').value = s.ip || '';
    $('s-port').value = s.port || 8088;
    $('s-companion').textContent = `Companion URLs start with ${s.companionBase}`;
  } catch (err) {
    $('settings-error').textContent = err.message;
    $('settings-error').hidden = false;
  }
  $('settings').showModal();
}
$('settings-btn').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', () => $('settings').close());
$('settings-save').addEventListener('click', async () => {
  $('settings-error').hidden = true;
  try {
    await api('PUT', '/api/settings', { ip: $('s-ip').value, port: $('s-port').value });
    $('settings').close();
    await loadOverview();
    renderPresets();
  } catch (err) {
    $('settings-error').textContent = err.message;
    $('settings-error').hidden = false;
  }
});

// ---------- loading
async function loadOverview() {
  try {
    state.overview = await api('GET', '/api/overview');
    renderStatus(state.overview.device);
    renderMvrs();
    renderDetails();
    $('new-btn').disabled = false;
  } catch (err) {
    renderStatus(null, err.message);
    if (!state.overview) $('new-btn').disabled = true;
  }
}

async function loadPresets() {
  state.presets = await api('GET', '/api/presets');
  renderPresets();
}

$('refresh').addEventListener('click', loadOverview);
$('new-btn').addEventListener('click', () => {
  if (!state.overview) return;
  const mvr = state.overview.mvrs[0];
  openEditor({ name: '', mvrScreenId: mvr?.screenId, layoutKey: mvr?.layoutKey || pickableLayouts()[0]?.key, sources: {} }, 'New preset');
});

(async () => {
  await loadOverview();
  try {
    await loadPresets();
  } catch (err) {
    toast('bad', err.message);
  }
  // Direct links: #capture=2 opens the editor with MVR 2 captured, #edit=<preset-id> opens a preset.
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('capture') && state.overview) capture(Number(hash.get('capture')));
  else if (hash.get('edit')) openEditorFor(hash.get('edit'), false);
})();

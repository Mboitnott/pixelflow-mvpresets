// Works out the order of source changes needed to put a preset's sources into an MVR's boxes.
// Pure logic: no network. Rules it works within (tested on a P80, fw V1.3.0):
//   - a source can be in only ONE multiviewer box across all MVRs
//   - a box can't be emptied and can't be set to the source it already has
//   - a batch call is checked box by box, so a straight swap is refused; swaps need a spare source
//   - final placements keep their own kind (PGM box -> PGM, PVW -> PVW, input box -> input),
//     but a box may hold any kind for a moment while parked during a swap
//
// Inputs:
//   pairs:       [{ cell, box }] for the target MVR (box null = P80 created no box there)
//   wanted:      Map(cellIndex -> { sourceType, sourceId }) from the preset
//   otherUsed:   Set of source keys in use on OTHER MVRs
//   available:   { 2: [keys of enabled inputs], 3: [PGM keys], 4: [PVW keys] }
// Output: { steps: [{ layerId, cellIndex, sourceType, sourceId, temporary }], skipped: [{ cellIndex, reason }] }

const { sourceKey, cellAccepts } = require('./mvrModel');

function parseKey(key) {
  const [t, id] = key.split(':').map(Number);
  return { sourceType: t, sourceId: id };
}

function planRecall({ pairs, wanted, otherUsed, available }) {
  const steps = [];
  const skipped = [];

  const current = new Map(); // layerId -> key
  const holder = new Map(); // key -> layerId (this MVR)
  const cellOf = new Map(); // layerId -> cellIndex
  for (const { cell, box } of pairs) {
    if (!box) continue;
    cellOf.set(box.layerId, cell.index);
    const k = sourceKey(box.source.sourceType, box.source.sourceId);
    current.set(box.layerId, k);
    holder.set(k, box.layerId);
  }

  const availableSets = Object.fromEntries(Object.entries(available).map(([t, keys]) => [t, new Set(keys)]));
  const desired = new Map(); // layerId -> key
  const claimed = new Set();

  for (const { cell, box } of pairs) {
    const want = wanted.get(cell.index);
    if (!want) continue;
    const key = sourceKey(want.sourceType, want.sourceId);
    const skip = (reason) => skipped.push({ cellIndex: cell.index, sourceType: want.sourceType, sourceId: want.sourceId, reason });
    if (!cellAccepts(cell, want.sourceType)) skip('wrong kind of source for this box');
    else if (!availableSets[want.sourceType]?.has(key)) skip('source not available (disabled or missing)');
    else if (otherUsed.has(key)) skip('source is in use on the other multiviewer');
    else if (claimed.has(key)) skip('source already used by another box in this preset');
    else if (!box) skip('no box: the processor had no free source to create this box');
    else {
      claimed.add(key);
      if (current.get(box.layerId) !== key) desired.set(box.layerId, key);
    }
  }

  function apply(layerId, key, temporary) {
    const old = current.get(layerId);
    if (old) holder.delete(old);
    current.set(layerId, key);
    holder.set(key, layerId);
    steps.push({ layerId, cellIndex: cellOf.get(layerId), ...parseKey(key), temporary });
  }

  const isFree = (key) => !holder.has(key) && !otherUsed.has(key) && !claimed.has(key);

  // A source that will stay in the box: must be the box's own kind.
  function freeKeyOfKind(sourceType) {
    return (available[sourceType] || []).find(isFree) || null;
  }

  // A parking spot for a split second during a swap: the P80 accepts any kind here
  // (tested: a PGM can sit in an input box), so prefer same kind, then anything free.
  function freeTempKey(sourceType) {
    const order = [sourceType, ...Object.keys(available).map(Number).filter((t) => t !== sourceType)];
    for (const t of order) {
      const key = freeKeyOfKind(t);
      if (key) return key;
    }
    return null;
  }

  const pending = new Set(desired.keys());
  while (pending.size) {
    let progress = false;
    for (const layerId of [...pending]) {
      const key = desired.get(layerId);
      if (!holder.has(key)) {
        apply(layerId, key, false);
        pending.delete(layerId);
        progress = true;
      }
    }
    if (progress) continue;

    // A wanted source is held by a box this preset doesn't need it in (e.g. auto-filled).
    // Move that box to any free source of its kind so the source is released.
    for (const layerId of pending) {
      const key = desired.get(layerId);
      const blocker = holder.get(key);
      if (pending.has(blocker)) continue;
      const filler = freeKeyOfKind(parseKey(key).sourceType);
      if (filler) {
        apply(blocker, filler, false);
      } else {
        pending.delete(layerId);
        skipped.push({ cellIndex: cellOf.get(layerId), ...parseKey(key), reason: 'source is held by another box here and no spare was free to move it' });
      }
      progress = true;
      break;
    }
    if (progress) continue;

    // Everything left is a loop (A wants B's source, B wants A's). Park one box on a spare source.
    const layerId = pending.values().next().value;
    const kind = parseKey(desired.get(layerId)).sourceType;
    const temp = freeTempKey(kind);
    if (temp) {
      apply(layerId, temp, true);
    } else {
      pending.delete(layerId);
      const want = parseKey(desired.get(layerId));
      skipped.push({ cellIndex: cellOf.get(layerId), ...want, reason: 'needed a spare source to swap with and none was free' });
    }
  }

  return { steps, skipped };
}

module.exports = { planRecall };

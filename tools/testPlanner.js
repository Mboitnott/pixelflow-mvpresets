// Offline checks for the recall planner. Run: node tools/testPlanner.js
// Simulates the processor's rules and makes sure every planned step is legal.

const assert = require('assert');
const { planRecall } = require('../src/recallPlanner');
const { sourceKey } = require('../src/mvrModel');

const rect = (i) => ({ x: i * 100, y: 0, w: 90, h: 90 });
function setup(cellKinds, current) {
  return cellKinds.map((kind, i) => ({
    cell: { index: i, sourceType: kind, rect: rect(i) },
    box: current[i] === null ? null : { layerId: 1000 + i, rect: rect(i), source: { sourceType: kind, sourceId: current[i] } },
  }));
}

// Replays steps under the processor's rules; throws if any step would be refused.
function simulate(pairs, steps, otherUsed) {
  const cur = new Map(pairs.filter((p) => p.box).map((p) => [p.box.layerId, sourceKey(p.box.source.sourceType, p.box.source.sourceId)]));
  for (const s of steps) {
    const k = sourceKey(s.sourceType, s.sourceId);
    assert(cur.get(s.layerId) !== k, `step sets box ${s.layerId} to the source it already has`);
    assert(![...cur.values()].includes(k), `step uses ${k} which is already in a box here`);
    assert(!otherUsed.has(k), `step uses ${k} which is on the other MVR`);
    cur.set(s.layerId, k);
  }
  return cur;
}

const inputs = (ids) => ids.map((id) => sourceKey(2, id));
const available = { 2: inputs([1, 2, 3, 4, 5, 6, 7]), 3: [sourceKey(3, 5), sourceKey(3, 10)], 4: [sourceKey(4, 5), sourceKey(4, 10)] };
let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log('ok  ', name);
}

test('simple: free sources go straight in', () => {
  const pairs = setup([2, 2], [1, 2]);
  const wanted = new Map([[0, { sourceType: 2, sourceId: 3 }], [1, { sourceType: 2, sourceId: 4 }]]);
  const r = planRecall({ pairs, wanted, otherUsed: new Set(), available });
  const end = simulate(pairs, r.steps, new Set());
  assert.equal(end.get(1000), '2:3');
  assert.equal(end.get(1001), '2:4');
  assert.equal(r.skipped.length, 0);
});

test('swap two boxes uses one spare', () => {
  const pairs = setup([2, 2], [1, 2]);
  const wanted = new Map([[0, { sourceType: 2, sourceId: 2 }], [1, { sourceType: 2, sourceId: 1 }]]);
  const r = planRecall({ pairs, wanted, otherUsed: new Set(), available });
  const end = simulate(pairs, r.steps, new Set());
  assert.equal(end.get(1000), '2:2');
  assert.equal(end.get(1001), '2:1');
  assert.equal(r.steps.filter((s) => s.temporary).length, 1);
});

test('three-way rotation', () => {
  const pairs = setup([2, 2, 2], [1, 2, 3]);
  const wanted = new Map([[0, { sourceType: 2, sourceId: 2 }], [1, { sourceType: 2, sourceId: 3 }], [2, { sourceType: 2, sourceId: 1 }]]);
  const r = planRecall({ pairs, wanted, otherUsed: new Set(), available });
  const end = simulate(pairs, r.steps, new Set());
  assert.deepEqual([end.get(1000), end.get(1001), end.get(1002)], ['2:2', '2:3', '2:1']);
});

test('source on the other MVR is skipped', () => {
  const pairs = setup([3, 2], [10, 1]);
  const other = new Set(['3:5']);
  const wanted = new Map([[0, { sourceType: 3, sourceId: 5 }], [1, { sourceType: 2, sourceId: 2 }]]);
  const r = planRecall({ pairs, wanted, otherUsed: other, available });
  simulate(pairs, r.steps, other);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /other multiviewer/);
});

test('wanted source held by a box the preset leaves alone gets released', () => {
  const pairs = setup([2, 2], [1, 2]); // box 1 holds input 2, preset only sets box 0
  const wanted = new Map([[0, { sourceType: 2, sourceId: 2 }]]);
  const r = planRecall({ pairs, wanted, otherUsed: new Set(), available });
  const end = simulate(pairs, r.steps, new Set());
  assert.equal(end.get(1000), '2:2');
  assert.notEqual(end.get(1001), '2:2');
});

test('wrong kind, missing box, disabled input, duplicate are all skipped', () => {
  const pairs = setup([3, 2, 2, 2], [10, 1, null, 3]);
  const wanted = new Map([
    [0, { sourceType: 2, sourceId: 4 }], // input in a PGM box
    [1, { sourceType: 2, sourceId: 99 }], // not available
    [2, { sourceType: 2, sourceId: 5 }], // no box
    [3, { sourceType: 2, sourceId: 6 }],
  ]);
  wanted.set(1, { sourceType: 2, sourceId: 6 }); // duplicate of box 3's wish
  const r = planRecall({ pairs, wanted, otherUsed: new Set(), available });
  simulate(pairs, r.steps, new Set());
  assert.equal(r.skipped.length, 3);
});

test('swap with no spare available reports instead of looping', () => {
  const pairs = setup([2, 2], [1, 2]);
  const wanted = new Map([[0, { sourceType: 2, sourceId: 2 }], [1, { sourceType: 2, sourceId: 1 }]]);
  const r = planRecall({ pairs, wanted, otherUsed: new Set(), available: { 2: inputs([1, 2]), 3: [], 4: [] } });
  simulate(pairs, r.steps, new Set());
  assert.equal(r.skipped.length, 2);
});

test('input swap with no spare input parks on a free PGM', () => {
  const pairs = setup([2, 2], [1, 2]);
  const wanted = new Map([[0, { sourceType: 2, sourceId: 2 }], [1, { sourceType: 2, sourceId: 1 }]]);
  const r = planRecall({ pairs, wanted, otherUsed: new Set(), available: { 2: inputs([1, 2]), 3: ['3:11'], 4: [] } });
  const end = simulate(pairs, r.steps, new Set());
  assert.deepEqual([end.get(1000), end.get(1001)], ['2:2', '2:1']);
  assert.equal(r.steps.find((s) => s.temporary).sourceType, 3);
});

test('a box released for the preset never ends up with the wrong kind', () => {
  const pairs = setup([2, 2], [1, 2]); // preset wants input 2 in box 0 only; no spare inputs
  const wanted = new Map([[0, { sourceType: 2, sourceId: 2 }]]);
  const r = planRecall({ pairs, wanted, otherUsed: new Set(), available: { 2: inputs([1, 2]), 3: ['3:11'], 4: [] } });
  const end = simulate(pairs, r.steps, new Set());
  for (const v of end.values()) assert(v.startsWith('2:'), 'input box left holding ' + v);
});

test('PGM/PVW boxes swap screens', () => {
  const pairs = setup([3, 4, 3, 4], [5, 5, 10, 10]);
  const wanted = new Map([[0, { sourceType: 3, sourceId: 10 }], [1, { sourceType: 4, sourceId: 10 }], [2, { sourceType: 3, sourceId: 5 }], [3, { sourceType: 4, sourceId: 5 }]]);
  const r = planRecall({ pairs, wanted, otherUsed: new Set(), available: { ...available, 3: ['3:5', '3:10', '3:7'], 4: ['4:5', '4:10', '4:7'] } });
  const end = simulate(pairs, r.steps, new Set());
  assert.deepEqual([...end.values()], ['3:10', '4:10', '3:5', '4:5']);
});

console.log(`\n${n} planner tests passed`);

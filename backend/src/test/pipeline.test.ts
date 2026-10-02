import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWithRules } from '../pipeline/extract/rules';
import { generateBpmn } from '../pipeline/generator';
import { validateBpmn } from '../pipeline/validator';
import { repairModel } from '../pipeline/repair';
import { analyze } from '../pipeline/analyzer';
import { SAMPLES } from '../samples';
import { ProcessModel } from '../pipeline/types';

for (const s of SAMPLES) {
  test(`sample "${s.title}" yields valid BPMN with lanes and decisions`, async () => {
    const m = extractWithRules(s.text);
    const v = await validateBpmn(generateBpmn(m));
    assert.deepEqual(v.issues.filter((i) => i.severity === 'error'), []);
    assert.ok(m.actors.length >= 3, 'actors become lanes');
    assert.ok(m.nodes.filter((n) => n.type === 'task').length >= 6);
    assert.ok(m.nodes.some((n) => n.type === 'xor'), 'If/Otherwise becomes an exclusive gateway');
  });
}

test('extractor: parallel work becomes AND split + join', () => {
  const m = extractWithRules('The IT team provisions the laptop while the facilities team prepares the desk. The manager welcomes the new hire.');
  const ands = m.nodes.filter((n) => n.type === 'and');
  assert.equal(ands.length, 2);
  assert.equal(m.flows.filter((f) => f.from === ands[0].id).length, 2);
  assert.equal(m.flows.filter((f) => f.to === ands[1].id).length, 2);
});

test('extractor: loop-back and terminal branches', () => {
  const m = extractWithRules(
    'The clerk checks the form. If the form is incomplete, the clerk returns it to the clerk. The manager approves the form. If the manager rejects the form, the process ends.',
  );
  const byId = new Map(m.nodes.map((n) => [n.id, n]));
  const loop = m.flows.find((f) => byId.get(f.from)?.type === 'xor' && byId.get(f.to)?.name === 'Check form');
  assert.ok(loop, 'incomplete form loops back to the first check');
  const ends = m.nodes.filter((n) => n.type === 'end');
  assert.ok(ends.length >= 2, 'rejection ends the process separately from normal completion');
});

const broken: ProcessModel = {
  title: 'Broken',
  actors: ['A', 'B'],
  nodes: [
    { id: 't1', type: 'task', name: 'Do thing', actor: 'A' },
    { id: 'g', type: 'xor', name: 'OK?' },
    { id: 't2', type: 'task', name: 'Next', actor: 'B' },
    { id: 't3', type: 'task', name: 'Orphan', actor: 'B' },
  ],
  flows: [
    { id: 'f1', from: 't1', to: 'g' },
    { id: 'f2', from: 'g', to: 't2' },
    { id: 'f3', from: 'g', to: 't3' },
  ],
};

test('validator flags missing start/end, unlabeled branches and dead ends', async () => {
  const v = await validateBpmn(generateBpmn(broken));
  const codes = new Set(v.issues.map((i) => i.code));
  for (const c of ['NO_START', 'NO_END', 'XOR_UNLABELED', 'NO_OUTGOING', 'NO_INCOMING']) assert.ok(codes.has(c), `expected ${c}, got ${[...codes]}`);
  assert.equal(v.valid, false);
});

test('repair loop converges to a valid diagram within 3 passes', async () => {
  let m = broken;
  let valid = false;
  for (let i = 0; i < 3 && !valid; i++) {
    const v = await validateBpmn(generateBpmn(m));
    valid = v.valid;
    if (!valid) m = repairModel(m, v.issues).model;
  }
  assert.ok(valid || (await validateBpmn(generateBpmn(m))).valid);
});

test('validator rejects malformed XML and unresolved references', async () => {
  assert.equal((await validateBpmn('<not-bpmn')).valid, false);
  const xml = generateBpmn(extractWithRules(SAMPLES[0].text)).replace(/targetRef="[^"]+"/, 'targetRef="ghost"');
  assert.equal((await validateBpmn(xml)).valid, false);
});

test('generator escapes XML-special characters in names', async () => {
  const m = extractWithRules('The clerk files the "R&D <draft>" report. The manager signs the report.');
  const xml = generateBpmn(m);
  assert.ok(!xml.includes('<draft>'));
  assert.equal((await validateBpmn(xml)).valid, true);
});

test('analyzer finds exception-path and hand-off problems', () => {
  const m = extractWithRules(SAMPLES[2].text);
  const f = analyze(m);
  assert.ok(f.some((x) => x.category === 'missing-exception'));
  assert.ok(f.every((x) => x.id && x.title && x.detail));
});

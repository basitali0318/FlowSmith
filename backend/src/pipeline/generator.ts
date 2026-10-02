import { PFlow, PNode, ProcessModel } from './types';
import { outgoing, incoming } from './model-utils';

const COL_W = 144;
const ROW_H = 110;
const LANE_MIN_H = 120;
const POOL_X = 40;
const POOL_Y = 40;
const LABEL_STRIP = 30;
const PAD_X = 50;

const SIZE = {
  task: { w: 100, h: 80 },
  event: { w: 36, h: 36 },
  gateway: { w: 50, h: 50 },
};

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const sizeOf = (n: PNode) => (n.type === 'task' ? SIZE.task : n.type === 'start' || n.type === 'end' ? SIZE.event : SIZE.gateway);

const ids = {
  node: (n: PNode) => n.id,
  flow: (f: PFlow) => `Flow_${f.id.replace(/[^A-Za-z0-9_]/g, '_')}`,
  lane: (i: number) => `Lane_${i + 1}`,
};

/** Rank (column) per node: longest path from sources over forward edges; back edges (loops) are ignored. */
function computeRanks(m: ProcessModel): Map<string, number> {
  const adj = new Map<string, string[]>();
  m.nodes.forEach((n) => adj.set(n.id, []));
  m.flows.forEach((f) => adj.get(f.from)?.push(f.to));

  // Detect back edges with iterative DFS from sources (start events first)
  const state = new Map<string, 0 | 1 | 2>();
  const back = new Set<string>();
  const roots = [
    ...m.nodes.filter((n) => n.type === 'start'),
    ...m.nodes.filter((n) => n.type !== 'start' && incoming(m, n.id).length === 0),
    ...m.nodes,
  ];
  for (const r of roots) {
    if (state.get(r.id)) continue;
    const stack: Array<{ id: string; i: number }> = [{ id: r.id, i: 0 }];
    state.set(r.id, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = adj.get(top.id)![top.i++];
      if (next === undefined) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const s = state.get(next);
      if (s === 1) back.add(`${top.id}->${next}`);
      else if (!s) {
        state.set(next, 1);
        stack.push({ id: next, i: 0 });
      }
    }
  }

  const fwd = m.flows.filter((f) => !back.has(`${f.from}->${f.to}`));
  const rank = new Map<string, number>();
  m.nodes.forEach((n) => rank.set(n.id, 0));
  // Bellman-Ford style relaxation on a DAG (bounded passes)
  for (let pass = 0; pass < m.nodes.length + 1; pass++) {
    let changed = false;
    for (const f of fwd) {
      const r = rank.get(f.from)! + 1;
      if (r > rank.get(f.to)!) {
        rank.set(f.to, r);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rank;
}

/** Every node needs a lane: tasks use their actor; gateways/events inherit from neighbours. */
function assignLanes(m: ProcessModel): Map<string, number> {
  const actors = [...m.actors];
  const laneOf = new Map<string, number>();
  const laneIndex = (a: string) => {
    let i = actors.indexOf(a);
    if (i < 0) {
      actors.push(a);
      i = actors.length - 1;
    }
    return i;
  };
  m.nodes.forEach((n) => n.actor && laneOf.set(n.id, laneIndex(n.actor)));

  // propagate: gateways/ends take the lane of their first predecessor, starts/others of first successor
  for (let pass = 0; pass < 4; pass++) {
    for (const n of m.nodes) {
      if (laneOf.has(n.id)) continue;
      const pred = incoming(m, n.id).map((f) => laneOf.get(f.from)).find((l) => l !== undefined);
      const succ = outgoing(m, n.id).map((f) => laneOf.get(f.to)).find((l) => l !== undefined);
      const pick = n.type === 'start' ? succ ?? pred : pred ?? succ;
      if (pick !== undefined) laneOf.set(n.id, pick);
    }
  }
  if (!actors.length) actors.push('Process');
  m.nodes.forEach((n) => !laneOf.has(n.id) && laneOf.set(n.id, 0));
  m.actors = actors;
  return laneOf;
}

export function generateBpmn(input: ProcessModel): string {
  const m: ProcessModel = JSON.parse(JSON.stringify(input));
  const processId = 'Process_1';
  const collabId = 'Collaboration_1';
  const participantId = 'Participant_1';

  const laneOf = assignLanes(m);
  const rank = computeRanks(m);
  const maxRank = Math.max(0, ...rank.values());

  // stack nodes that share (lane, rank)
  const slot = new Map<string, number>();
  const stackCount = new Map<string, number>();
  const order = [...m.nodes].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  for (const n of order) {
    const key = `${laneOf.get(n.id)}:${rank.get(n.id)}`;
    const idx = stackCount.get(key) ?? 0;
    slot.set(n.id, idx);
    stackCount.set(key, idx + 1);
  }

  const laneRows = m.actors.map((_, li) => {
    let rows = 1;
    stackCount.forEach((count, key) => key.startsWith(`${li}:`) && (rows = Math.max(rows, count)));
    return rows;
  });
  const laneH = laneRows.map((r) => Math.max(LANE_MIN_H, r * ROW_H + 30));
  const laneTop: number[] = [];
  laneH.reduce((acc, h, i) => ((laneTop[i] = acc), acc + h), POOL_Y);
  const poolH = laneH.reduce((a, b) => a + b, 0);
  const poolW = LABEL_STRIP + PAD_X * 2 + (maxRank + 1) * COL_W;

  const boxes = new Map<string, Box>();
  for (const n of m.nodes) {
    const li = laneOf.get(n.id)!;
    const { w, h } = sizeOf(n);
    // stacked nodes sit on a fixed row grid, centred as a block inside the lane
    const blockH = laneRows[li] * ROW_H;
    const cy = laneTop[li] + (laneH[li] - blockH) / 2 + ROW_H * ((slot.get(n.id) ?? 0) + 0.5);
    const cx = POOL_X + LABEL_STRIP + PAD_X + rank.get(n.id)! * COL_W + COL_W / 2 - 40;
    boxes.set(n.id, { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h });
  }

  const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const hits = (x1: number, x2: number, y: number, skip: Set<string>) => {
    const [a, c] = x1 < x2 ? [x1, x2] : [x2, x1];
    for (const [id, b] of boxes) {
      if (skip.has(id)) continue;
      if (y > b.y - 6 && y < b.y + b.h + 6 && c > b.x && a < b.x + b.w) return true;
    }
    return false;
  };

  const waypoints = (f: PFlow): Array<{ x: number; y: number }> => {
    const s = boxes.get(f.from)!;
    const t = boxes.get(f.to)!;
    const sc = centre(s);
    const tc = centre(t);
    const skip = new Set([f.from, f.to]);
    const sr = rank.get(f.from)!;
    const tr = rank.get(f.to)!;

    if (tr <= sr) {
      // loop-back edge: leave from the bottom, run beneath the lane content, enter the target from below
      const yLow = Math.max(s.y + s.h, t.y + t.h) + 28;
      return [
        { x: sc.x, y: s.y + s.h },
        { x: sc.x, y: yLow },
        { x: tc.x, y: yLow },
        { x: tc.x, y: t.y + t.h },
      ];
    }

    const sx = s.x + s.w;
    const tx = t.x;
    if (Math.abs(sc.y - tc.y) < 2) {
      if (!hits(sx, tx, sc.y, skip)) return [{ x: sx, y: sc.y }, { x: tx, y: tc.y }];
      // straight line blocked: detour below the blocking row
      const yLow = Math.max(s.y + s.h, t.y + t.h) + 26;
      return [
        { x: sc.x, y: s.y + s.h },
        { x: sc.x, y: yLow },
        { x: tc.x, y: yLow },
        { x: tc.x, y: t.y + t.h },
      ];
    }

    const gap = 22;
    const midX = tx - gap;
    // horizontal at source y, then vertical in the gutter before the target column
    if (!hits(sx, midX, sc.y, skip)) {
      return [
        { x: sx, y: sc.y },
        { x: midX, y: sc.y },
        { x: midX, y: tc.y },
        { x: tx, y: tc.y },
      ];
    }
    // blocked: leave from the vertical side of the source, then run horizontally at target height
    const exitY = tc.y > sc.y ? s.y + s.h : s.y;
    if (!hits(sc.x, tx, tc.y, skip)) {
      return [
        { x: sc.x, y: exitY },
        { x: sc.x, y: tc.y },
        { x: tx, y: tc.y },
      ];
    }
    const yLow = Math.max(s.y + s.h, t.y + t.h) + 26;
    return [
      { x: sc.x, y: s.y + s.h },
      { x: sc.x, y: yLow },
      { x: tc.x, y: yLow },
      { x: tc.x, y: t.y + t.h },
    ];
  };

  /* ---------------------------------------------------------------- XML */
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="Definitions_1" targetNamespace="https://flowsmith.ai/bpmn" exporter="FlowSmith AI" exporterVersion="0.1.0">',
  );
  out.push(`  <bpmn:collaboration id="${collabId}">`);
  out.push(`    <bpmn:participant id="${participantId}" name="${esc(m.title)}" processRef="${processId}" />`);
  out.push('  </bpmn:collaboration>');
  out.push(`  <bpmn:process id="${processId}" isExecutable="false">`);
  out.push('    <bpmn:laneSet id="LaneSet_1">');
  m.actors.forEach((a, li) => {
    out.push(`      <bpmn:lane id="${ids.lane(li)}" name="${esc(a)}">`);
    m.nodes.filter((n) => laneOf.get(n.id) === li).forEach((n) => out.push(`        <bpmn:flowNodeRef>${ids.node(n)}</bpmn:flowNodeRef>`));
    out.push('      </bpmn:lane>');
  });
  out.push('    </bpmn:laneSet>');

  for (const n of m.nodes) {
    const inc = incoming(m, n.id).map((f) => `      <bpmn:incoming>${ids.flow(f)}</bpmn:incoming>`);
    const outg = outgoing(m, n.id).map((f) => `      <bpmn:outgoing>${ids.flow(f)}</bpmn:outgoing>`);
    const defaultFlow =
      n.type === 'xor' && outgoing(m, n.id).length > 1
        ? outgoing(m, n.id).find((f) => /^(no|else|other|otherwise|default)$/i.test(f.label ?? ''))
        : undefined;
    const tag =
      n.type === 'start' ? 'startEvent'
      : n.type === 'end' ? 'endEvent'
      : n.type === 'xor' ? 'exclusiveGateway'
      : n.type === 'and' ? 'parallelGateway'
      : n.kind === 'service' ? 'serviceTask'
      : n.kind === 'user' ? 'userTask'
      : 'task';
    const attrs = `id="${ids.node(n)}"${n.name ? ` name="${esc(n.name)}"` : ''}${defaultFlow ? ` default="${ids.flow(defaultFlow)}"` : ''}`;
    out.push(`    <bpmn:${tag} ${attrs}>`);
    out.push(...inc, ...outg);
    out.push(`    </bpmn:${tag}>`);
  }
  for (const f of m.flows) {
    out.push(`    <bpmn:sequenceFlow id="${ids.flow(f)}"${f.label ? ` name="${esc(f.label)}"` : ''} sourceRef="${f.from}" targetRef="${f.to}" />`);
  }
  out.push('  </bpmn:process>');

  out.push('  <bpmndi:BPMNDiagram id="BPMNDiagram_1">');
  out.push(`    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="${collabId}">`);
  out.push(`      <bpmndi:BPMNShape id="${participantId}_di" bpmnElement="${participantId}" isHorizontal="true">`);
  out.push(`        <dc:Bounds x="${POOL_X}" y="${POOL_Y}" width="${poolW}" height="${poolH}" />`);
  out.push('      </bpmndi:BPMNShape>');
  m.actors.forEach((_, li) => {
    out.push(`      <bpmndi:BPMNShape id="${ids.lane(li)}_di" bpmnElement="${ids.lane(li)}" isHorizontal="true">`);
    out.push(`        <dc:Bounds x="${POOL_X + LABEL_STRIP}" y="${laneTop[li]}" width="${poolW - LABEL_STRIP}" height="${laneH[li]}" />`);
    out.push('      </bpmndi:BPMNShape>');
  });
  for (const n of m.nodes) {
    const b = boxes.get(n.id)!;
    out.push(`      <bpmndi:BPMNShape id="${n.id}_di" bpmnElement="${n.id}"${n.type === 'xor' ? ' isMarkerVisible="true"' : ''}>`);
    out.push(`        <dc:Bounds x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" />`);
    if (n.type === 'xor' && n.name) {
      // decision question above the diamond so leaving/loop edges never run through the text
      out.push(`        <bpmndi:BPMNLabel><dc:Bounds x="${b.x + b.w / 2 - 60}" y="${b.y - 34}" width="120" height="30" /></bpmndi:BPMNLabel>`);
    }
    out.push('      </bpmndi:BPMNShape>');
  }
  for (const f of m.flows) {
    out.push(`      <bpmndi:BPMNEdge id="${ids.flow(f)}_di" bpmnElement="${ids.flow(f)}">`);
    waypoints(f).forEach((p) => out.push(`        <di:waypoint x="${Math.round(p.x)}" y="${Math.round(p.y)}" />`));
    out.push('      </bpmndi:BPMNEdge>');
  }
  out.push('    </bpmndi:BPMNPlane>');
  out.push('  </bpmndi:BPMNDiagram>');
  out.push('</bpmn:definitions>');
  return out.join('\n');
}

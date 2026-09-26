// test/placement.test.mjs — 最小独立标记布设审计
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec } from '../src/parser.mjs';
import { tarjan, buildVerifier } from '../src/diagnoser.mjs';
import {
  buildMaskedVerifier,
  minimalMarkPlacement,
  evaluateMarks,
} from '../src/placement.mjs';

function model(text) {
  const m = parseSpec(text);
  assert.deepEqual(m.errors, [], `规程应无解析错误: ${JSON.stringify(m.errors)}`);
  return m;
}

const SILENT_DOUBLE_LOOP = `
loc 0
loc 1
loc 2
loc 3
init 0
trans f1 0 1 F SILENT
trans g1 1 2 N a
trans g2 2 1 N a
trans h1 0 3 N a
trans h2 3 0 N a
`;

test('空遮罩 verifier 与原 verifier 逐边一致（规程零改写）', () => {
  const m = model(SILENT_DOUBLE_LOOP);
  const v1 = buildVerifier(m);
  const v2 = buildMaskedVerifier(m, new Set());
  assert.equal(v1.states.length, v2.states.length);
  assert.equal(v1.start.p, v2.start.p);
  const sig = (s) => {
    const es = s.edges.map((e) =>
      `${e.mode}:${e.fTrans?.id ?? '-'}:${e.nTrans?.id ?? '-'}:${e.receipt ?? '-'}→${e.to.p},${e.to.q},${e.to.f}`)
      .sort().join('|');
    return `${s.p},${s.q},${s.f}|${es}`;
  };
  const a = v1.states.map(sig).sort();
  const b = v2.states.map(sig).sort();
  assert.deepEqual(a, b);
});

test('静默双环：最小布设 = {f1}，应用后可诊断', () => {
  const r = minimalMarkPlacement(model(SILENT_DOUBLE_LOOP), tarjan);
  assert.equal(r.alreadyDiagnosable, false);
  assert.equal(r.size, 1);
  assert.deepEqual(r.marks, ['f1']);
  // 每个被选标记的反例约束确实经过该标记
  assert.equal(r.perMarkConstraints.length, 1);
  assert.equal(r.perMarkConstraints[0].mark, 'f1');
  assert.ok(r.perMarkConstraints[0].witness.hitFaultTrans.includes('f1'));
  assert.ok(r.perMarkConstraints[0].witness.sequencesIdentical);
  // 更小集合（空布设）仍保留稳定反例
  assert.equal(r.smallerSetWitnesses.length, 1);
  assert.deepEqual(r.smallerSetWitnesses[0].set, []);
  assert.ok(r.smallerSetWitnesses[0].witness.hitFaultTrans.includes('f1'));
  // 直接核对应用集合后的裁决
  const ev = evaluateMarks(model(SILENT_DOUBLE_LOOP), ['f1'], tarjan);
  assert.equal(ev.diagnosable, true);
  assert.equal(ev.witness, null);
});

test('裁决稳定性：同一规程两次审计给出完全相同的标记集合与统计', () => {
  const m = model(SILENT_DOUBLE_LOOP);
  const r1 = minimalMarkPlacement(m, tarjan);
  const r2 = minimalMarkPlacement(m, tarjan);
  assert.deepEqual(r1.marks, r2.marks);
  assert.deepEqual(
    r1.perMarkConstraints.map((c) => [c.mark, c.witness.prefixReceiptLength, c.witness.loopReceiptLength]),
    r2.perMarkConstraints.map((c) => [c.mark, c.witness.prefixReceiptLength, c.witness.loopReceiptLength]));
});

test('可观察故障双环：标记故障回执迁移后伪装被打断', () => {
  const text = `
loc 0
loc 1
loc 2
loc 3
init 0
trans f1 0 1 F a
trans f2 1 1 N b
trans n1 0 2 N a
trans n2 2 2 N b
`;
  const r = minimalMarkPlacement(model(text), tarjan);
  assert.equal(r.size, 1);
  assert.deepEqual(r.marks, ['f1']);
  // f1 原本有回执 a：标记后是独有 m_f1，正常侧 n1 的 a 无法再对齐
  const ev = evaluateMarks(model(text), ['f1'], tarjan);
  assert.equal(ev.diagnosable, true);
});

test('两个独立伪装各需一个标记：最小布设 = 2', () => {
  const text = `
loc 0
loc 1
loc 2
loc 3
loc 4
loc 5
loc 7
init 0
trans f1 0 1 F SILENT
trans g1 1 2 N a
trans g2 2 1 N a
trans f2 0 3 F SILENT
trans h1 3 4 N b
trans h2 4 3 N b
trans na1 0 5 N a
trans na2 5 0 N a
trans nb1 0 7 N b
trans nb2 7 0 N b
`;
  const m = model(text);
  const r = minimalMarkPlacement(m, tarjan);
  assert.equal(r.size, 2);
  assert.deepEqual(r.marks, ['f1', 'f2']);
  // 任一单标记都不够
  assert.equal(evaluateMarks(m, ['f1'], tarjan).diagnosable, false);
  assert.equal(evaluateMarks(m, ['f2'], tarjan).diagnosable, false);
  assert.equal(evaluateMarks(m, ['f1', 'f2'], tarjan).diagnosable, true);
  // 真前缀反例：∅ 与 {f1} 都有存活反例，且 {f1} 下的反例只可能经 f2
  assert.equal(r.smallerSetWitnesses.length, 2);
  assert.deepEqual(r.smallerSetWitnesses[0].set, []);
  assert.deepEqual(r.smallerSetWitnesses[1].set, ['f1']);
  assert.deepEqual(r.smallerSetWitnesses[1].witness.hitFaultTrans, ['f2']);
});

test('同一伪装环有两个故障入口：两个入口都必须标记', () => {
  const text = `
loc 0
loc 1
loc 2
loc 3
init 0
trans f1 0 1 F SILENT
trans f2 0 1 F SILENT
trans g1 1 2 N a
trans g2 2 1 N a
trans h1 0 3 N a
trans h2 3 0 N a
`;
  const m = model(text);
  const r = minimalMarkPlacement(m, tarjan);
  assert.equal(r.size, 2);
  assert.deepEqual(r.marks, ['f1', 'f2']);
  // 只标一个入口，另一个入口仍制造同一无限伪装
  assert.equal(evaluateMarks(m, ['f1'], tarjan).diagnosable, false);
  assert.equal(evaluateMarks(m, ['f2'], tarjan).diagnosable, false);
  assert.equal(evaluateMarks(m, ['f1', 'f2'], tarjan).diagnosable, true);
});

test('原规程可诊断：明确返回空布设', () => {
  const text = `
loc 0
loc 1
loc 2
init 0
trans f1 0 1 F a
trans t1 1 1 N b
trans n1 0 2 N a
`;
  const r = minimalMarkPlacement(model(text), tarjan);
  assert.equal(r.alreadyDiagnosable, true);
  assert.equal(r.size, 0);
  assert.deepEqual(r.marks, []);
});

test('evaluateMarks 拒绝非故障 / 不存在的标识', () => {
  const m = model(SILENT_DOUBLE_LOOP);
  const bad = evaluateMarks(m, ['g1'], tarjan); // N 迁移不可装标记
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.invalid, ['g1']);
  const missing = evaluateMarks(m, ['nope'], tarjan);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.invalid, ['nope']);
});

test('被标记 F 迁移不再产生任何同步积边（含静默被标记）', () => {
  const m = model(SILENT_DOUBLE_LOOP);
  const v = buildMaskedVerifier(m, new Set(['f1']));
  for (const s of v.states) {
    for (const e of s.edges) {
      assert.notEqual(e.fTrans?.id, 'f1');
    }
  }
});

// ---- 随机模型：与按子集尺寸/字典序穷举的暴力最优解逐一核对 ----
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomModel(rand, n, nf) {
  const locs = Array.from({ length: n }, (_, i) => `L${i}`);
  const lines = [`init ${locs[0]}`, ...locs.map((l) => `loc ${l}`)];
  let id = 0;
  const faults = [];
  // 先放 nf 条 F 迁移（保证候选非空），再放随机 N/F 迁移
  for (let k = 0; k < nf; k++) {
    const src = locs[Math.floor(rand() * n)];
    const dst = locs[Math.floor(rand() * n)];
    const rec = rand() < 0.5 ? 'SILENT' : ['a', 'b'][Math.floor(rand() * 2)];
    const fid = `f${id++}`;
    faults.push(fid);
    lines.push(`trans ${fid} ${src} ${dst} F ${rec}`);
  }
  for (const src of locs) {
    const deg = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < deg; k++) {
      const dst = locs[Math.floor(rand() * n)];
      const rec = rand() < 0.3
        ? 'SILENT'
        : ['a', 'b', 'c'][Math.floor(rand() * 3)];
      lines.push(`trans t${id++} ${src} ${dst} N ${rec}`);
    }
  }
  return { text: lines.join('\n'), faults };
}

function subsetsBySize(ids) {
  const out = [[]];
  for (const x of ids) {
    const len = out.length;
    for (let i = 0; i < len; i++) out.push([...out[i], x]);
  }
  out.sort((a, b) => a.length - b.length || a.join(',').localeCompare(b.join(',')));
  return out;
}

test('fuzz：分支定界最优解 == 按尺寸枚举的暴力最优解（120 例）', () => {
  let rand = rng(20240926);
  let checked = 0;
  for (let i = 0; i < 120; i++) {
    const n = 2 + Math.floor(rand() * 4);
    const nf = 1 + Math.floor(rand() * 4);
    const { text, faults } = randomModel(rand, n, nf);
    const m = parseSpec(text);
    if (m.errors.length) continue;
    const r = minimalMarkPlacement(m, tarjan);
    // 暴力：按尺寸、字典序枚举，第一个可诊断布设即最优
    let brute = null;
    for (const sub of subsetsBySize(faults.sort())) {
      const ev = evaluateMarks(m, sub, tarjan);
      if (ev.ok && ev.diagnosable) { brute = sub; break; }
    }
    checked++;
    assert.ok(brute, '标记全部故障迁移必然可诊断');
    assert.equal(r.size, brute.length,
      `尺寸分歧（模型 ${i}）：bnb=${r.size} brute=${brute.length}`);
    assert.deepEqual(r.marks, brute,
      `平局裁决分歧（模型 ${i}）：bnb=${r.marks} brute=${brute}`);
    // 不变式：每个被选标记撤下后都有经该标记的存活反例
    for (const c of r.perMarkConstraints) {
      assert.ok(c.witness.hitFaultTrans.includes(c.mark));
      assert.ok(c.witness.sequencesIdentical);
    }
    // 不变式：所有真前缀都仍不可诊断
    for (const row of r.smallerSetWitnesses) {
      assert.ok(row.witness !== null);
    }
  }
  assert.ok(checked >= 80, `有效模型数不足：${checked}`);
});

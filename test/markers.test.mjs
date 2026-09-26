// test/markers.test.mjs — 最小独立标记布设审计
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec } from '../src/parser.mjs';
import { diagnose } from '../src/diagnoser.mjs';
import { minHittingSet, placeMarkers, validateMarkerIds } from '../src/markers.mjs';
import { place, probe } from '../src/analyze.mjs';

function modelOf(text) {
  const m = parseSpec(text);
  assert.deepEqual(m.errors, [], `规程应无解析错误: ${JSON.stringify(m.errors)}`);
  return m;
}

// 静默双环：唯一故障迁移 f1 静默，故障后两侧回执序列 a,a,... 完全相同
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

const DIAGNOSABLE_RECEIPT = `
loc 0
loc 1
loc 2
init 0
trans f1 0 1 F a
trans t1 1 1 N b
trans n1 0 2 N a
`;

// 两条独立故障支路：f1 支路回执 a 环、f2 支路回执 b 环，各自被正常侧伪装
const TWO_BRANCHES = `
loc 0
loc 1
loc 2
loc 3
loc 4
init 0
trans f1 0 1 F SILENT
trans g1 1 1 N a
trans h1 0 3 N a
trans h1l 3 3 N a
trans f2 0 2 F SILENT
trans g2 2 2 N b
trans h2 0 4 N b
trans h2l 4 4 N b
`;

// 串联故障 f1→f2 成环 + 独立故障 f3 成环：
// 约束 {f1,f2} 与 {f3}，最小命中集在 {f1,f3}/{f2,f3} 中按标识裁决为 {f1,f3}
const CHAINED_PLUS_INDEPENDENT = `
loc 0
loc 1
loc 2
loc 3
loc 4
loc 5
init 0
trans f1 0 1 F SILENT
trans f2 1 2 F SILENT
trans g 2 2 N a
trans h 0 3 N a
trans hl 3 3 N a
trans f3 0 4 F SILENT
trans g3 4 4 N b
trans h3 0 5 N b
trans h3l 5 5 N b
`;

test('最小命中集：基本性质与稳定裁决', () => {
  assert.deepEqual(minHittingSet([]), []);
  assert.deepEqual(minHittingSet([['b', 'a']]), ['a']);
  assert.deepEqual(minHittingSet([['a', 'b'], ['b', 'c']]), ['b']);
  // 两条不相交约束 ⇒ 各取一个，按迁移标识字典序取最小
  assert.deepEqual(minHittingSet([['b', 'a'], ['d', 'c']]), ['a', 'c']);
  // 超集约束被子集约束吸收
  assert.deepEqual(minHittingSet([['a'], ['a', 'b']]), ['a']);
  // 重复约束去重
  assert.deepEqual(minHittingSet([['a', 'b'], ['a', 'b'], ['b', 'c']]), ['b']);
  // 空约束不可命中（防御分支，调用方保证不发生）
  assert.equal(minHittingSet([[]]), null);
});

test('静默双环：给唯一故障迁移 f1 加装标记 ⇒ 最少 1 个', () => {
  const r = placeMarkers(modelOf(SILENT_DOUBLE_LOOP));
  assert.equal(r.baseDiagnosable, false);
  assert.equal(r.minCount, 1);
  assert.deepEqual(r.markers, ['f1']);
  assert.equal(r.finalVerdict.diagnosable, true);
  // 反例约束必须命中 f1（见证前缀含静默故障迁移 f1）
  assert.ok(r.constraints.length >= 1);
  assert.ok(r.constraints.every((c) => c.set.includes('f1')));
  // 空集合下仍不可诊断（最小性）
  assert.equal(diagnose(modelOf(SILENT_DOUBLE_LOOP), new Set()).diagnosable, false);
});

test('本已可诊断 ⇒ 明确的空布设', () => {
  const r = placeMarkers(modelOf(DIAGNOSABLE_RECEIPT));
  assert.equal(r.baseDiagnosable, true);
  assert.equal(r.minCount, 0);
  assert.deepEqual(r.markers, []);
  assert.deepEqual(r.constraints, []);
});

test('两条独立支路 ⇒ 最少 2 个标记，任一单点集合仍不可诊断', () => {
  const model = modelOf(TWO_BRANCHES);
  const r = placeMarkers(model);
  assert.equal(r.minCount, 2);
  assert.deepEqual(r.markers, ['f1', 'f2']);
  assert.equal(r.finalVerdict.diagnosable, true);
  // 最小性：每个更小集合（空集、两个单点集）都保留反例
  for (const sub of [[], ['f1'], ['f2']]) {
    assert.equal(diagnose(model, new Set(sub)).diagnosable, false,
      `集合 ${JSON.stringify(sub)} 下应仍不可诊断`);
  }
});

test('串联 + 独立故障：约束生成多轮，按迁移标识稳定裁决 {f1,f3}', () => {
  const model = modelOf(CHAINED_PLUS_INDEPENDENT);
  const r = placeMarkers(model);
  assert.equal(r.minCount, 2);
  assert.deepEqual(r.markers, ['f1', 'f3']);
  // 至少两轮约束生成（{f1,f2} 与 {f3} 各出现一次）
  assert.equal(r.constraints.length, 2);
  const sets = r.constraints.map((c) => c.set.join(',')).sort();
  assert.deepEqual(sets, ['f1,f2', 'f3']);
  // 裁决稳定：重复计算结果完全一致
  const again = placeMarkers(model);
  assert.deepEqual(again.markers, r.markers);
  assert.deepEqual(again.constraints.map((c) => c.set), r.constraints.map((c) => c.set));
});

test('布设语义：被标记迁移的故障侧回执成为仅它可产生的独立观测', () => {
  // 可观察故障 f1 回执 a 与正常 n1 回执 a 混淆成环；标记 f1 后
  // 故障侧的 a 成为专属观测，正常侧无法匹配 ⇒ 可诊断
  const model = modelOf(`
loc 0
loc 1
loc 2
loc 3
init 0
trans f1 0 1 F a
trans f2 1 1 N b
trans n1 0 2 N a
trans n2 2 2 N b
`);
  assert.equal(diagnose(model).diagnosable, false);
  assert.equal(diagnose(model, new Set(['f1'])).diagnosable, true);
});

test('标记集合校验：未知标识 / 非故障迁移被拒绝', () => {
  const model = modelOf(SILENT_DOUBLE_LOOP);
  assert.equal(validateMarkerIds(model, ['f1']), null);
  assert.match(validateMarkerIds(model, ['nope']), /不是规程中的迁移标识/);
  assert.match(validateMarkerIds(model, ['g1']), /不是故障迁移/);
});

test('place 视图模型：字段完整、空布设明确', () => {
  const r = place(SILENT_DOUBLE_LOOP);
  assert.equal(r.ok, true);
  assert.equal(r.baseDiagnosable, false);
  assert.equal(r.minCount, 1);
  assert.deepEqual(r.markers, ['f1']);
  assert.ok(r.faultyTransitions.includes('f1'));
  assert.equal(r.finalVerdict.diagnosable, true);
  assert.ok(Array.isArray(r.finalVerdict.checkedPairs));
  // 每条约束标注了被哪些被选标记命中
  assert.ok(r.constraints.every((c) => c.hitBy.length >= 1));
  assert.ok(r.constraints.every((c) => c.hitBy.every((x) => r.markers.includes(x))));

  const empty = place(DIAGNOSABLE_RECEIPT);
  assert.equal(empty.ok, true);
  assert.equal(empty.baseDiagnosable, true);
  assert.equal(empty.minCount, 0);
  assert.deepEqual(empty.markers, []);

  const bad = place('loc 0\ninit 0\ntrans t1 0 ZZ N ok\n');
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length > 0);
});

test('probe 视图模型：更小集合保留稳定反例，非法标记明确报错', () => {
  const p0 = probe(SILENT_DOUBLE_LOOP, []);
  assert.equal(p0.ok, true);
  assert.equal(p0.diagnosable, false);
  assert.ok(p0.witness);
  assert.equal(p0.witness.sequencesIdentical, true);

  const p1 = probe(SILENT_DOUBLE_LOOP, ['f1']);
  assert.equal(p1.ok, true);
  assert.equal(p1.diagnosable, true);

  const badId = probe(SILENT_DOUBLE_LOOP, ['nope']);
  assert.equal(badId.ok, false);
  assert.match(badId.markerError, /不是规程中的迁移标识/);

  const notFaulty = probe(SILENT_DOUBLE_LOOP, ['g1']);
  assert.equal(notFaulty.ok, false);
  assert.match(notFaulty.markerError, /不是故障迁移/);
});

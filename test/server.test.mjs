// test/server.test.mjs — HTTP 集成测试（临时端口启动真实服务）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../server.js';

let base;
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${addr.port}`;
});
after(async () => { await new Promise((r) => server.close(r)); });

const post = async (path, body) => {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};

test('健康检查响应', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, 'ok');
  assert.equal(typeof j.activeJobs, 'number');
});

test('静默双环经 HTTP 判为不可诊断，证据完整', async () => {
  const spec = [
    'loc 0', 'loc 1', 'loc 2', 'loc 3', 'init 0',
    'trans f1 0 1 F SILENT',
    'trans g1 1 2 N a', 'trans g2 2 1 N a',
    'trans h1 0 3 N a', 'trans h2 3 0 N a',
  ].join('\n');
  const { status, json } = await post('/api/analyze', { jobId: 't1', spec });
  assert.equal(status, 200);
  assert.equal(json.result.diagnosable, false);
  assert.equal(json.result.witness.prefixReceiptLength, 0);
  assert.ok(json.result.witness.sequencesIdentical);
  assert.ok(json.result.witness.loopReceiptLength >= 1);
});

test('可诊断回执经 HTTP 判为可诊断', async () => {
  const spec = 'loc 0\nloc 1\nloc 2\ninit 0\ntrans f1 0 1 F a\ntrans t1 1 1 N b\ntrans n1 0 2 N a\n';
  const { status, json } = await post('/api/analyze', { jobId: 't2', spec });
  assert.equal(status, 200);
  assert.equal(json.result.diagnosable, true);
});

test('悬空目标返回定位错误且无结论', async () => {
  const { status, json } = await post('/api/analyze',
    { jobId: 't3', spec: 'loc 0\ninit 0\ntrans t1 0 ZZ N ok\n' });
  assert.equal(status, 200);
  assert.equal(json.result.ok, false);
  const e = json.result.errors.find((x) => x.message.includes('悬空目标'));
  assert.ok(e);
  assert.equal(e.line, 3);
  assert.equal(e.column, 12);
});

test('非法 jobId 400、非法 JSON 400、未知路径 404、穿越被拦', async () => {
  const r1 = await post('/api/analyze', { jobId: '../x', spec: '' });
  assert.equal(r1.status, 400);

  const r2 = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{nope',
  });
  assert.equal(r2.status, 400);

  const r3 = await fetch(`${base}/../etc/passwd`);
  assert.notEqual(r3.status, 200);
});

test('取消不存在的任务返回 cancelled=false', async () => {
  const r = await fetch(`${base}/api/jobs/nope`, { method: 'DELETE' });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.cancelled, false);
});

const SILENT_LOOP_SPEC = [
  'loc 0', 'loc 1', 'loc 2', 'loc 3', 'init 0',
  'trans f1 0 1 F SILENT',
  'trans g1 1 2 N a', 'trans g2 2 1 N a',
  'trans h1 0 3 N a', 'trans h2 3 0 N a',
].join('\n');

test('最小独立标记布设：静默双环 ⇒ 最少 1 个标记 {f1}，新裁决可诊断', async () => {
  const { status, json } = await post('/api/markers', { jobId: 'm1', spec: SILENT_LOOP_SPEC });
  assert.equal(status, 200);
  const r = json.result;
  assert.equal(r.ok, true);
  assert.equal(r.baseDiagnosable, false);
  assert.equal(r.minCount, 1);
  assert.deepEqual(r.markers, ['f1']);
  assert.equal(r.finalVerdict.diagnosable, true);
  // 每个被选标记打断的反例约束：约束非空且都被 f1 命中
  assert.ok(r.constraints.length >= 1);
  assert.ok(r.constraints.every((c) => c.hitBy.includes('f1')));
  assert.ok(r.constraints.every((c) => c.set.includes('f1')));
  // 约束携带稳定见证摘要
  assert.ok(r.constraints[0].witness.entry);
  assert.ok(Array.isArray(r.constraints[0].witness.loopObservable));
});

test('最小独立标记布设：本已可诊断 ⇒ 明确的空布设', async () => {
  const spec = 'loc 0\nloc 1\nloc 2\ninit 0\ntrans f1 0 1 F a\ntrans t1 1 1 N b\ntrans n1 0 2 N a\n';
  const { status, json } = await post('/api/markers', { jobId: 'm2', spec });
  assert.equal(status, 200);
  const r = json.result;
  assert.equal(r.ok, true);
  assert.equal(r.baseDiagnosable, true);
  assert.equal(r.minCount, 0);
  assert.deepEqual(r.markers, []);
  assert.deepEqual(r.constraints, []);
});

test('子集探查：更小集合保留稳定反例，足够集合可诊断，非法标记报错', async () => {
  // 空集合 ⇒ 仍不可诊断且给出稳定反例
  let { status, json } = await post('/api/markers/probe',
    { jobId: 'p1', spec: SILENT_LOOP_SPEC, marked: [] });
  assert.equal(status, 200);
  assert.equal(json.result.ok, true);
  assert.equal(json.result.diagnosable, false);
  assert.ok(json.result.witness);
  assert.equal(json.result.witness.sequencesIdentical, true);

  // 装上 f1 ⇒ 可诊断
  ({ status, json } = await post('/api/markers/probe',
    { jobId: 'p2', spec: SILENT_LOOP_SPEC, marked: ['f1'] }));
  assert.equal(status, 200);
  assert.equal(json.result.diagnosable, true);

  // 未知标识 / 非故障迁移 ⇒ 明确错误
  ({ status, json } = await post('/api/markers/probe',
    { jobId: 'p3', spec: SILENT_LOOP_SPEC, marked: ['nope'] }));
  assert.equal(status, 200);
  assert.equal(json.result.ok, false);
  assert.match(json.result.markerError, /不是规程中的迁移标识/);

  ({ status, json } = await post('/api/markers/probe',
    { jobId: 'p4', spec: SILENT_LOOP_SPEC, marked: ['g1'] }));
  assert.equal(status, 200);
  assert.equal(json.result.ok, false);
  assert.match(json.result.markerError, /不是故障迁移/);

  // marked 非数组 ⇒ 400
  ({ status } = await post('/api/markers/probe',
    { jobId: 'p5', spec: SILENT_LOOP_SPEC, marked: 'f1' }));
  assert.equal(status, 400);

  // 非法 jobId ⇒ 400
  ({ status } = await post('/api/markers', { jobId: '../x', spec: '' }));
  assert.equal(status, 400);
});

test('布设任务同样受过期防护：取代旧任务后健康检查无残留', async () => {
  const [r1] = await Promise.all([
    post('/api/markers', { jobId: 'm-cancel', spec: SILENT_LOOP_SPEC }),
    (async () => {
      await new Promise((r) => setTimeout(r, 5));
      const dr = await fetch(`${base}/api/jobs/m-cancel`, { method: 'DELETE' });
      return dr.json();
    })(),
  ]);
  // 快任务可能已完成——两种结局都可接受，但不得产生 5xx
  assert.ok(r1.status === 200 || r1.status === 409);
  const h = await (await fetch(`${base}/healthz`)).json();
  assert.equal(h.activeJobs, 0);
});

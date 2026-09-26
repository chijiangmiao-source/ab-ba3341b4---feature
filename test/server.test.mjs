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

const PLACEMENT_SPEC = [
  'loc 0', 'loc 1', 'loc 2', 'loc 3', 'init 0',
  'trans f1 0 1 F SILENT',
  'trans g1 1 2 N a', 'trans g2 2 1 N a',
  'trans h1 0 3 N a', 'trans h2 3 0 N a',
].join('\n');

test('布设审计：静默双环给出最小布设 {f1}，应用后可诊断', async () => {
  const { status, json } = await post('/api/placement', { jobId: 'p1', spec: PLACEMENT_SPEC });
  assert.equal(status, 200);
  const p = json.result.placement;
  assert.equal(p.alreadyDiagnosable, false);
  assert.equal(p.size, 1);
  assert.deepEqual(p.marks, ['f1']);
  assert.equal(p.perMarkConstraints[0].mark, 'f1');
  assert.ok(p.perMarkConstraints[0].witness.hitFaultTrans.includes('f1'));
  assert.equal(p.smallerSetWitnesses.length, 1);
  assert.deepEqual(p.smallerSetWitnesses[0].set, []);
});

test('布设审计：原规程可诊断时明确返回空布设', async () => {
  const spec = 'loc 0\nloc 1\nloc 2\ninit 0\ntrans f1 0 1 F a\ntrans t1 1 1 N b\ntrans n1 0 2 N a\n';
  const { status, json } = await post('/api/placement', { jobId: 'p2', spec });
  assert.equal(status, 200);
  assert.equal(json.result.placement.alreadyDiagnosable, true);
  assert.equal(json.result.placement.size, 0);
  assert.deepEqual(json.result.placement.marks, []);
});

test('候选集合核对：{f1} 可诊断，空集合仍不可诊断', async () => {
  const r1 = await post('/api/placement/eval', { jobId: 'e1', spec: PLACEMENT_SPEC, marks: ['f1'] });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.result.ok, true);
  assert.equal(r1.json.result.diagnosable, true);
  assert.equal(r1.json.result.witness, null);

  const r2 = await post('/api/placement/eval', { jobId: 'e2', spec: PLACEMENT_SPEC, marks: [] });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.result.diagnosable, false);
  assert.ok(r2.json.result.witness.hitFaultTrans.includes('f1'));
});

test('候选核对拒绝非故障 / 非法标识', async () => {
  const r1 = await post('/api/placement/eval', { jobId: 'e3', spec: PLACEMENT_SPEC, marks: ['g1'] });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.result.ok, false);
  assert.deepEqual(r1.json.result.invalid, ['g1']);

  const r2 = await post('/api/placement/eval', { jobId: 'e4', spec: PLACEMENT_SPEC, marks: ['bad id'] });
  assert.equal(r2.status, 400);
});

test('布设审计任务同样受 supersedes / 取消保护', async () => {
  const [r1] = await Promise.all([
    fetch(`${base}/api/placement`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'p-cancel', spec: PLACEMENT_SPEC }),
    }).then(async (x) => ({ status: x.status, body: await x.text() })).catch((e) => ({ error: String(e) })),
    (async () => {
      await new Promise((r) => setTimeout(r, 5));
      const dr = await fetch(`${base}/api/jobs/p-cancel`, { method: 'DELETE' });
      return dr.json();
    })(),
  ]);
  assert.ok(r1.status === 200 || r1.status === 409 || r1.error);
  const h = await (await fetch(`${base}/healthz`)).json();
  assert.equal(h.activeJobs, 0);
});

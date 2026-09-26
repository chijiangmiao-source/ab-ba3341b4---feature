// scripts/verify.mjs — Compose verify 服务入口
// 依次执行：语法/构建检查 → 单元测试 → 随机交叉验证 → HTTP 冒烟；
// 任一步失败立即以非零退出码退出（Compose 会显示 exited(1)）。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...opts.env },
    });
    p.on('error', (err) => {
      console.error(`无法启动 ${cmd}: ${err.message}`);
      resolve(-1);
    });
    p.on('checkExit', () => {});
    p.on('exit', (code) => {
      if (!opts.softFail) console.log(`\n[verify] ${cmd} ${args.join(' ')} → exit ${code}`);
      resolve(code ?? -1);
    });
  });
}

async function smoke() {
  console.log('\n[verify] === HTTP 冒烟 ===');
  const remote = process.env.BASE_URL || '';
  let server = null;
  let cancelJob = null;
  let base;
  if (remote) {
    base = remote.replace(/\/$/, '');
    console.log(`[verify] 目标：${base}（Compose web 服务）`);
  } else {
    const PORT = '8911';
    ({ server, cancelJob } = await import('../server.js'));
    await new Promise((r) => server.listen(Number(PORT), '127.0.0.1', r));
    base = `http://127.0.0.1:${PORT}`;
    console.log(`[verify] 目标：${base}（进程内临时服务）`);
  }
  let failures = 0;
  const expect = (cond, msg) => {
    console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
    if (!cond) failures++;
  };

  // 1) 健康检查
  let r = await fetch(`${base}/healthz`);
  expect(r.status === 200, '健康检查 200');
  expect((await r.json()).status === 'ok', '健康检查内容 ok');

  // 2) 静默双环 ⇒ 不可诊断
  const silentCase = `loc 0
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
  r = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'smoke-1', spec: silentCase }),
  });
  let payload = await r.json();
  expect(r.status === 200, '静默双环 API 200');
  expect(payload.result?.diagnosable === false, '静默双环判为不可诊断');
  expect(
    payload.result?.witness?.prefixReceiptLength === 0,
    '静默双环前缀无回执（不得以位置名称比较代替）');
  const loop = payload.result?.witness?.loop;
  expect(Array.isArray(loop) && loop.every((x) => x.receipt === 'a' || x.receipt === null),
    '闭环回执全部为 a 或 ε');
  expect(loop?.some((x) => x.faultySide.transId) && loop.some((x) => x.normalSide),
    '闭环内两侧都移动（都是无限执行）');

  // 3) 可诊断回执 ⇒ 可诊断
  const diagCase = `loc 0
loc 1
loc 2
init 0
trans f1 0 1 F a
trans t1 1 1 N b
trans n1 0 2 N a
`;
  r = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'smoke-2', spec: diagCase }),
  });
  payload = await r.json();
  expect(r.status === 200, '可诊断例 API 200');
  expect(payload.result?.diagnosable === true, '可诊断例判为可诊断');
  expect(payload.result?.witness == null, '可诊断例无伪装证据');

  // 4) 非法输入：悬空目标定位 + 不产出结论
  r = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'smoke-3', spec: 'loc 0\ninit 0\ntrans t1 0 ZZ N ok\n' }),
  });
  payload = await r.json();
  expect(payload.result?.ok === false, '非法规程 ok=false');
  const dangling = payload.result?.errors?.find((e) => e.message.includes('悬空目标'));
  expect(Boolean(dangling) && dangling.line === 3 && dangling.column === 12,
    '悬空目标定位到第 3 行第 12 列');

  // 5) 静态页面与资源
  r = await fetch(`${base}/`);
  expect(r.status === 200 && (await r.text()).includes('故障闭环审计'), '页面可访问');
  r = await fetch(`${base}/app.js`);
  expect(r.status === 200, 'app.js 可访问');
  r = await fetch(`${base}/styles.css`);
  expect(r.status === 200, 'styles.css 可访问');

  // 6) 取消/过期任务：启动后立即 DELETE；其 promise reject(409)，
  //    随后的新任务结果必须正常，且服务器不残留活动任务
  const big = silentCase; // 当前实现很快，主要验证取消路径不击穿服务
  const [r1] = await Promise.all([
    fetch(`${base}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'cancel-me', spec: big }),
    }).then(async (x) => ({ status: x.status, body: await x.text() })).catch((e) => ({ error: String(e) })),
    (async () => {
      await new Promise((r) => setTimeout(r, 5));
      const dr = await fetch(`${base}/api/jobs/cancel-me`, { method: 'DELETE' });
      return dr.json();
    })(),
  ]);
  // 快任务可能在 5ms 内已完成——两种结局都可接受，但后续健康检查必须 activeJobs=0
  expect(r1.status === 200 || r1.status === 409 || r1.error, '取消竞速不产生 5xx');
  r = await fetch(`${base}/healthz`);
  const h = await r.json();
  expect(h.activeJobs === 0, '取消/完成后无残留任务');

  // 7) 最小标记布设审计：静默双环最小布设 {f1}
  r = await fetch(`${base}/api/placement`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'smoke-p1', spec: silentCase }),
  });
  payload = await r.json();
  const p = payload.result?.placement;
  expect(r.status === 200, '布设审计 API 200');
  expect(p?.size === 1 && Array.isArray(p.marks) && p.marks[0] === 'f1',
    '静默双环最小布设恰为 {f1}（不是逐个试装猜测）');
  expect(p?.perMarkConstraints?.length === 1 &&
    p.perMarkConstraints[0].witness?.hitFaultTrans?.includes('f1'),
    '被选标记 f1 附经该迁移的反例约束');
  expect(p?.smallerSetWitnesses?.length === 1 &&
    p.smallerSetWitnesses[0].set.length === 0,
    '空布设（更小集合）仍保留稳定反例');
  expect(typeof p.stats?.nodesVisited === 'number' && p.stats.nodesVisited >= 1,
    '给出分支定界复核统计');

  // 8) 应用 {f1} 后新裁决＝可诊断；空集合仍不可诊断
  r = await fetch(`${base}/api/placement/eval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'smoke-e1', spec: silentCase, marks: ['f1'] }),
  });
  payload = await r.json();
  expect(r.status === 200 && payload.result?.diagnosable === true,
    '应用 {f1} 后裁决为可诊断');
  r = await fetch(`${base}/api/placement/eval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'smoke-e2', spec: silentCase, marks: [] }),
  });
  payload = await r.json();
  expect(r.status === 200 && payload.result?.diagnosable === false &&
    payload.result?.witness?.hitFaultTrans?.includes('f1'),
    '空集合核对仍不可诊断且给出稳定反例');
  r = await fetch(`${base}/api/placement/eval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'smoke-e3', spec: silentCase, marks: ['g1'] }),
  });
  payload = await r.json();
  expect(r.status === 200 && payload.result?.ok === false,
    '非故障迁移标识被拒绝');

  // 9) 原规程可诊断：布设审计明确返回空布设
  r = await fetch(`${base}/api/placement`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'smoke-p2', spec: diagCase }),
  });
  payload = await r.json();
  expect(r.status === 200 && payload.result?.placement?.alreadyDiagnosable === true &&
    payload.result?.placement?.size === 0,
    '原规程可诊断时明确返回空布设');

  cancelJob?.('not-a-job'); // 覆盖取消不存在任务的路径
  if (server) await new Promise((r) => server.close(r));
  console.log(failures === 0 ? '\n[verify] HTTP 冒烟全部通过' : `\n[verify] HTTP 冒烟失败 ${failures} 处`);
  return failures === 0 ? 0 : 1;
}

async function main() {
  console.log('[verify] 1/5 构建检查（node --check 所有源文件）');
  const files = [
    'server.js', 'src/parser.mjs', 'src/diagnoser.mjs',
    'src/placement.mjs', 'src/analyze.mjs', 'src/worker.mjs',
    'public/app.js', 'scripts/fuzz.mjs', 'scripts/placement-fuzz.mjs',
    'scripts/verify.mjs',
  ];
  for (const f of files) {
    const code = await run('node', ['--check', f]);
    if (code !== 0) process.exit(1);
  }

  console.log('\n[verify] 2/5 单元测试');
  if ((await run('node', ['--test', 'test/'])) !== 0) process.exit(1);

  console.log('\n[verify] 3/5 随机模型交叉验证（2000 例）');
  if ((await run('node', ['scripts/fuzz.mjs', '777', '2000'])) !== 0) process.exit(1);

  console.log('\n[verify] 4/5 最小布设暴力交叉验证（1000 例）');
  if ((await run('node', ['scripts/placement-fuzz.mjs', '31337', '1000'])) !== 0) process.exit(1);

  console.log('\n[verify] 5/5 HTTP 冒烟');
  if ((await smoke()) !== 0) process.exit(1);

  console.log('\n[verify] ✅ 全部检查通过，verify 正常退出（exit 0）');
  process.exit(0);
}

main().catch((err) => {
  console.error('[verify] 异常退出:', err);
  process.exit(1);
});

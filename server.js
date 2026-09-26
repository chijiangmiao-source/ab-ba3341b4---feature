// server.js — 故障闭环审计页 HTTP 服务
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { analyze, placementAudit, evaluatePlacement } from './src/analyze.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// 活动任务：jobId -> { worker, finished }（判定 / 布设审计 / 候选核对共用）
const jobs = new Map();

// task: { type: 'run' | 'placement' | 'eval-marks', spec, marks }
function runJob(jobId, task, { useWorker = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!useWorker) {
      try { resolve(runInline(task)); } catch (e) { reject(e); }
      return;
    }
    const worker = new Worker(join(__dirname, 'src', 'worker.mjs'));
    const rec = { worker, finished: false, reject, timer: null };
    jobs.set(jobId, rec);
    rec.timer = setTimeout(() => {
      if (!rec.finished) {
        rec.finished = true;
        worker.terminate();
        jobs.delete(jobId);
        reject(Object.assign(new Error('计算超时（30s），任务已取消'), { statusCode: 409 }));
      }
    }, 30_000);
    worker.on('message', (msg) => {
      if (rec.finished || msg.jobId !== jobId) return; // 过期/陌生回执一律丢弃
      rec.finished = true;
      clearTimeout(rec.timer);
      jobs.delete(jobId);
      worker.terminate();
      if (msg.type === 'result') resolve(msg.result);
      else reject(new Error(msg.error?.message ?? '任务失败'));
    });
    worker.on('error', (err) => {
      if (rec.finished) return;
      rec.finished = true;
      clearTimeout(rec.timer);
      jobs.delete(jobId);
      reject(err);
    });
    worker.postMessage({ jobId, ...task });
  });
}

function runInline(task) {
  if (task.type === 'placement') return placementAudit(task.spec);
  if (task.type === 'eval-marks') return evaluatePlacement(task.spec, task.marks ?? []);
  return analyze(task.spec);
}

function cancelJob(jobId) {
  const rec = jobs.get(jobId);
  if (rec && !rec.finished) {
    rec.finished = true;
    clearTimeout(rec.timer);
    rec.worker.terminate(); // 过期任务立即停止，不可能再回写任何结果
    jobs.delete(jobId);
    rec.reject(Object.assign(new Error('任务已被新规程取代或取消'), { statusCode: 409 }));
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'local'}`);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        activeJobs: jobs.size,
        uptime: Math.round(process.uptime()),
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/analyze') {
      const body = await readJson(req, 2 * 1024 * 1024);
      const jobId = String(body?.jobId ?? '');
      const spec = String(body?.spec ?? '');
      if (!validJobId(jobId)) return sendJson(res, 400, { error: '非法 jobId' });
      supersede(body, jobId);
      const result = await runJob(jobId, { type: 'run', spec });
      return sendJson(res, 200, { jobId, result });
    }

    // 最小独立标记布设审计（原规程已判不可诊断后发起）
    if (req.method === 'POST' && url.pathname === '/api/placement') {
      const body = await readJson(req, 2 * 1024 * 1024);
      const jobId = String(body?.jobId ?? '');
      const spec = String(body?.spec ?? '');
      if (!validJobId(jobId)) return sendJson(res, 400, { error: '非法 jobId' });
      supersede(body, jobId);
      const result = await runJob(jobId, { type: 'placement', spec });
      return sendJson(res, 200, { jobId, result });
    }

    // 工程师核对任意候选标记集合下的裁决与稳定反例
    if (req.method === 'POST' && url.pathname === '/api/placement/eval') {
      const body = await readJson(req, 2 * 1024 * 1024);
      const jobId = String(body?.jobId ?? '');
      const spec = String(body?.spec ?? '');
      if (!validJobId(jobId)) return sendJson(res, 400, { error: '非法 jobId' });
      const marks = Array.isArray(body?.marks) ? body.marks.map(String) : [];
      if (marks.some((m) => !/^[^\s]{1,128}$/.test(m))) {
        return sendJson(res, 400, { error: '非法迁移标识' });
      }
      supersede(body, jobId);
      const result = await runJob(jobId, { type: 'eval-marks', spec, marks });
      return sendJson(res, 200, { jobId, result });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/jobs/')) {
      const jobId = decodeURIComponent(url.pathname.slice('/api/jobs/'.length));
      const cancelled = cancelJob(jobId);
      return sendJson(res, 200, { jobId, cancelled });
    }

    if (req.method === 'GET') {
      return serveStatic(url.pathname, res);
    }

    sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    sendJson(res, err.statusCode ?? 500, { error: String(err.message ?? err) });
  }
});

const validJobId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(id);

// 新任务携带 supersedes：先 terminate 旧 worker；同号任务同样先作废
function supersede(body, jobId) {
  cancelJob(jobId);
  if (body?.supersedes) cancelJob(String(body.supersedes));
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('非法 JSON'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, safe);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

// 供 verify 冒烟使用的命名导出
export { server, runJob, cancelJob };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    console.log(`故障闭环审计页监听 http://${HOST}:${PORT}（健康检查 /healthz）`);
  });
}

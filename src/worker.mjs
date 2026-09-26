// worker.mjs — 在工作线程中执行判定 / 布设审计，主线程可随时 terminate 取消
import { parentPort } from 'node:worker_threads';
import { analyze, placementAudit, evaluatePlacement } from './analyze.mjs';

parentPort.on('message', (msg) => {
  const reply = (payload) =>
    parentPort.postMessage({ jobId: msg.jobId, ...payload });
  try {
    if (msg?.type === 'run') {
      reply({ type: 'result', result: analyze(msg.spec) });
    } else if (msg?.type === 'placement') {
      reply({ type: 'result', result: placementAudit(msg.spec) });
    } else if (msg?.type === 'eval-marks') {
      reply({ type: 'result', result: evaluatePlacement(msg.spec, msg.marks) });
    }
  } catch (err) {
    reply({
      type: 'error',
      error: { message: String(err?.message ?? err) },
    });
  }
});

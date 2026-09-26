// worker.mjs — 在工作线程中执行判定，主线程可随时 terminate 取消
import { parentPort } from 'node:worker_threads';
import { dispatchJob } from './analyze.mjs';

parentPort.on('message', (msg) => {
  if (msg?.type !== 'run') return;
  try {
    const result = dispatchJob(msg);
    parentPort.postMessage({ type: 'result', jobId: msg.jobId, result });
  } catch (err) {
    parentPort.postMessage({
      type: 'error', jobId: msg.jobId,
      error: { message: String(err?.message ?? err) },
    });
  }
});

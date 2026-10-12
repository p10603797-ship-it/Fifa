/**
 * [FND-06] Stand-in pool worker for tests/unit/fnd-06-review-fixes.test.ts (plain JS, no sim). The test picks the
 * behaviour through workerData.replayPrefix:
 *   'ok'             report every job at once
 *   'boot-fail'      throw before posting 'ready' (every worker)
 *   'boot-fail-once' the first worker to boot throws, later ones work (boot counter in workerData.replayCounter)
 *   'exit-early'     exit with code 0 before posting 'ready'
 *   'hang:<id>'      busy-loop forever on job <id>
 *   'crash:<id>'     exit with code 3 on job <id>
 */
import process from 'node:process';
import { parentPort, workerData } from 'node:worker_threads';

const mode = String(workerData.replayPrefix);
const boots = new Int32Array(workerData.replayCounter);

if (mode === 'boot-fail') throw new Error('stand-in boot failure');
if (mode === 'boot-fail-once' && Atomics.add(boots, 0, 1) === 0) throw new Error('stand-in first boot failure');
if (mode === 'exit-early') process.exit(0);

parentPort.on('message', (msg) => {
  if (msg.type === 'stop') process.exit(0);
  const job = msg.job;
  if (mode === `hang:${job.id}`) for (;;) { /* hung match */ }
  if (mode === `crash:${job.id}`) process.exit(3);
  parentPort.postMessage({
    type: 'report',
    report: { id: job.id, index: job.index, label: job.label, failed: false, reasons: [], hash: `h${job.id}` },
  });
});
parentPort.postMessage({ type: 'ready' });

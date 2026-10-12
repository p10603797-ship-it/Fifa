/**
 * [FND-06] Soak / fuzz worker thread: receives jobs, runs them with runJob, posts MatchReports back.
 * Replay files are written here; a SharedArrayBuffer counter shared by all workers caps how many.
 */
import './env';
import { parentPort, workerData } from 'node:worker_threads';
import { runJob, type Job, type JobContext } from './jobs';

interface WorkerInit {
  replayDir: string;
  replayPrefix: string;
  replayLimit: number;
  /** Int32 counter of replay files written (shared by all workers). */
  replayCounter: SharedArrayBuffer;
}

const init = workerData as WorkerInit;
const counter = new Int32Array(init.replayCounter);
const ctx: JobContext = {
  replayDir: init.replayDir,
  replayPrefix: init.replayPrefix,
  replayBudget: () => Atomics.add(counter, 0, 1) < init.replayLimit,
};

parentPort!.on('message', (msg: { type: 'job'; job: Job } | { type: 'stop' }) => {
  if (msg.type === 'stop') {
    process.exit(0);
  }
  const report = runJob(msg.job, ctx);
  parentPort!.postMessage({ type: 'report', report });
});
parentPort!.postMessage({ type: 'ready' });

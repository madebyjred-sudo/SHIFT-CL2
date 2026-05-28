import 'dotenv/config';
import cron from 'node-cron';
import { syncSilPipeline } from './jobs/syncSilPipeline.js';

const schedule = process.env.WORKER_CRON_SCHEDULE ?? '0 */6 * * *';

console.log(`[shift-cl2/worker] starting. cron=${schedule}`);

cron.schedule(schedule, async () => {
  console.log(`[worker] tick ${new Date().toISOString()}`);
  try {
    await syncSilPipeline();
  } catch (err) {
    console.error('[worker] tick failed:', err);
  }
});

console.log('[shift-cl2/worker] cron registered. waiting…');

process.on('SIGTERM', () => {
  console.log('[worker] SIGTERM received, shutting down');
  process.exit(0);
});

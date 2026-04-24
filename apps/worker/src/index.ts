import 'dotenv/config';
import cron from 'node-cron';
import { scrapeAsamblea } from './jobs/scrapeAsamblea.js';
import { ingestPdfQueue } from './jobs/ingestPdf.js';
import { transcribeAudioQueue } from './jobs/transcribeAudio.js';

const schedule = process.env.WORKER_CRON_SCHEDULE ?? '0 */6 * * *';

console.log(`[shift-cl2/worker] starting. cron=${schedule}`);

cron.schedule(schedule, async () => {
  console.log(`[worker] tick ${new Date().toISOString()}`);
  try {
    await scrapeAsamblea();
    await ingestPdfQueue();
    await transcribeAudioQueue();
  } catch (err) {
    console.error('[worker] tick failed:', err);
  }
});

console.log('[shift-cl2/worker] cron registered. waiting…');

process.on('SIGTERM', () => {
  console.log('[worker] SIGTERM received, shutting down');
  process.exit(0);
});

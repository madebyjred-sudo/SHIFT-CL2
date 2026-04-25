/**
 * shift-cl2 — Migration script CL2 MariaDB → Supabase
 *
 * Source: MariaDB Cloud SQL (34.28.63.124:3306, db `prototipo`)
 *   Tables: videos, transcripciones, users
 * Target: Supabase Postgres (sessions, legislative_chunks)
 *
 * Strategy:
 *   1. Read videos rows where status = PROCESADO and transcriptDocUrl != ''
 *   2. Map to sessions (legacy_video_id, fecha, comision, tipo, video_url, transcript_url)
 *   3. Pull transcript text from transcripciones (joined by video_id)
 *   4. Chunk transcript text (target ~800 tokens, 200 overlap)
 *   5. Embed via OpenAI text-embedding-3-large
 *   6. Insert into legislative_chunks (session_id, source_type=transcript, content, embedding)
 *   7. Mark session.status = 'indexed'
 *
 * Idempotent: skips sessions already indexed (by legacy_video_id).
 *
 * Run: tsx scripts/migrate-cl2-mariadb.ts [--dry-run] [--limit N]
 *
 * STATUS: skeleton. Needs:
 *   - mysql2 client install
 *   - openai client install
 *   - Cloud SQL credentials (use existing CL2 .env or proxy)
 *   - Real chunker (langchain-text-splitters or custom)
 */

import { createClient } from '@supabase/supabase-js';

interface MigrateOpts {
  dryRun: boolean;
  limit: number;
}

interface MariaVideoRow {
  id: number;
  videoId: string;
  fecha: string;
  comision: string | null;
  tipo: string | null;
  videoUrl: string | null;
  transcriptDocUrl: string | null;
  status: string;
}

function parseArgs(): MigrateOpts {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    limit: Number(args[args.indexOf('--limit') + 1] ?? 50),
  };
}

async function fetchVideosToMigrate(_limit: number): Promise<MariaVideoRow[]> {
  // TODO: connect to MariaDB via mysql2
  // const conn = await mysql.createConnection({ host, user, password, database, ssl })
  // const [rows] = await conn.query(`
  //   SELECT id, videoId, fecha, comision, tipo, videoUrl, transcriptDocUrl, status
  //   FROM videos
  //   WHERE status = 'PROCESADO' AND transcriptDocUrl != ''
  //   ORDER BY fecha DESC
  //   LIMIT ?
  // `, [limit]);
  // return rows as MariaVideoRow[];
  console.log('[migrate] fetchVideosToMigrate: stub — pending mysql2 client');
  return [];
}

async function fetchTranscript(_videoId: string): Promise<string> {
  // TODO: SELECT contenido FROM transcripciones WHERE video_id = ?
  // OR fetch from GCS if transcriptDocUrl points there
  return '';
}

function chunkText(text: string, targetTokens = 800, overlap = 200): string[] {
  // Naive sentence-aware chunker. Replace with langchain RecursiveCharacterTextSplitter.
  if (!text) return [];
  const approxCharsPerToken = 4;
  const targetChars = targetTokens * approxCharsPerToken;
  const overlapChars = overlap * approxCharsPerToken;
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + targetChars));
    i += targetChars - overlapChars;
  }
  return chunks;
}

async function embed(_text: string): Promise<number[]> {
  // TODO: OpenAI embeddings text-embedding-3-large
  // const r = await openai.embeddings.create({ model: 'text-embedding-3-large', input: text })
  // return r.data[0].embedding
  return new Array(3072).fill(0);
}

async function main() {
  const opts = parseArgs();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  if (!supabaseUrl || !supabaseKey) {
    console.error('[migrate] missing SUPABASE env vars');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });

  console.log(`[migrate] mode=${opts.dryRun ? 'DRY' : 'LIVE'} limit=${opts.limit}`);

  const videos = await fetchVideosToMigrate(opts.limit);
  console.log(`[migrate] ${videos.length} videos to process`);

  for (const v of videos) {
    const { data: existing } = await supabase
      .from('sessions')
      .select('id, status')
      .eq('legacy_video_id', v.videoId)
      .maybeSingle();

    if (existing?.status === 'indexed') {
      console.log(`[migrate] skip ${v.videoId} (already indexed)`);
      continue;
    }

    const sessionId =
      existing?.id ??
      (
        await supabase
          .from('sessions')
          .insert({
            legacy_video_id: v.videoId,
            fecha: v.fecha,
            comision: v.comision,
            tipo: v.tipo ?? 'plenario',
            video_url: v.videoUrl,
            transcript_url: v.transcriptDocUrl,
            status: 'processing',
          })
          .select('id')
          .single()
      ).data?.id;

    if (!sessionId) {
      console.error(`[migrate] failed to upsert session for ${v.videoId}`);
      continue;
    }

    const transcript = await fetchTranscript(v.videoId);
    const chunks = chunkText(transcript);
    console.log(`[migrate] ${v.videoId} → ${chunks.length} chunks`);

    if (opts.dryRun) continue;

    for (let idx = 0; idx < chunks.length; idx++) {
      const embedding = await embed(chunks[idx]);
      await supabase.from('legislative_chunks').insert({
        session_id: sessionId,
        source_type: 'transcript',
        source_ref: v.videoId,
        chunk_index: idx,
        content: chunks[idx],
        embedding,
        metadata: { fecha: v.fecha, comision: v.comision },
      });
    }

    await supabase
      .from('sessions')
      .update({ status: 'indexed' })
      .eq('id', sessionId);
  }

  console.log('[migrate] done');
}

main().catch((err) => {
  console.error('[migrate] fatal', err);
  process.exit(1);
});

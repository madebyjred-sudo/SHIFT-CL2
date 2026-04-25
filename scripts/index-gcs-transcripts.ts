/**
 * Index ElevenLabs transcripts from GCS into legislative_chunks.
 *
 * Source: gs://sesiones-transcripciones-uc1/transcripts/{youtubeId}.json
 *   Schema: { "0": { ok, transcription: { text, words[{text,start,end,type}], language_code } } }
 *
 * Per file:
 *   1. Skip if sessions row exists with status='indexed' AND chunk count > 0
 *   2. Download JSON, extract words array
 *   3. YouTube oEmbed → title (no API key); fecha left null (backfill later via Data API)
 *   4. Chunk by ~CHUNK_CHARS preserving word timings (start/end per chunk)
 *   5. Vertex embed (RETRIEVAL_DOCUMENT, concurrency 4)
 *   6. Upsert session, insert chunks with metadata={start,end,word_count}
 *
 * Run:
 *   npx tsx -r dotenv/config scripts/index-gcs-transcripts.ts dotenv_config_path=.env.local [--limit N] [--from-id ID]
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Storage } from '@google-cloud/storage';
import { PredictionServiceClient, helpers } from '@google-cloud/aiplatform';

const TRANSCRIPT_BUCKET = process.env.GCS_BUCKET_TRANSCRIPTS ?? 'sesiones-transcripciones-uc1';
const TRANSCRIPT_PREFIX = 'transcripts/';
const CHUNK_CHARS = 1500;
const VERTEX_CONCURRENCY = 4;

const args = process.argv.slice(2);
const limit = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? Infinity);
const fromId = args.find((a) => a.startsWith('--from-id='))?.split('=')[1];
const force = args.includes('--force');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const gcpProject = process.env.GCP_PROJECT_ID;
if (!supabaseUrl || !supabaseKey) throw new Error('Supabase env missing');
if (!gcpProject) throw new Error('GCP_PROJECT_ID missing');
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('GOOGLE_APPLICATION_CREDENTIALS missing');

const supa: SupabaseClient = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
const storage = new Storage();

const GCP_LOCATION = process.env.GCP_LOCATION ?? 'us-central1';
const EMBED_MODEL = process.env.VERTEX_EMBEDDING_MODEL ?? 'gemini-embedding-001';
const EMBED_DIM = Number(process.env.VERTEX_EMBEDDING_DIM ?? 3072);
const vertex = new PredictionServiceClient({ apiEndpoint: `${GCP_LOCATION}-aiplatform.googleapis.com` });
const VERTEX_ENDPOINT = `projects/${gcpProject}/locations/${GCP_LOCATION}/publishers/google/models/${EMBED_MODEL}`;

interface Word {
  text: string;
  start: number;
  end: number;
  type: 'word' | 'spacing' | string;
}

interface Chunk {
  text: string;
  start: number;
  end: number;
  word_count: number;
}

async function embedOne(text: string): Promise<number[]> {
  const instance = helpers.toValue({ content: text, task_type: 'RETRIEVAL_DOCUMENT' });
  const parameters = helpers.toValue({ outputDimensionality: EMBED_DIM });
  const [response] = await vertex.predict({
    endpoint: VERTEX_ENDPOINT,
    instances: instance ? [instance] : [],
    parameters,
  });
  const decoded = helpers.fromValue(response.predictions?.[0] as never) as {
    embeddings?: { values?: number[] };
  };
  const values = decoded?.embeddings?.values;
  if (!values || !Array.isArray(values)) throw new Error('vertex: missing embeddings.values');
  return values;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const out: number[][] = new Array(texts.length);
  const queue = texts.map((t, i) => ({ t, i }));
  const workers = Array.from({ length: Math.min(VERTEX_CONCURRENCY, texts.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) return;
      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          out[item.i] = await embedOne(item.t);
          break;
        } catch (err: any) {
          attempt++;
          if (attempt >= 3) throw err;
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
    }
  });
  await Promise.all(workers);
  return out;
}

function chunkWords(words: Word[], maxChars: number): Chunk[] {
  const chunks: Chunk[] = [];
  let buf: Word[] = [];
  let charCount = 0;
  const flush = () => {
    if (!buf.length) return;
    const text = buf.map((w) => w.text).join('').trim();
    if (!text) {
      buf = [];
      charCount = 0;
      return;
    }
    chunks.push({
      text,
      start: buf[0].start,
      end: buf[buf.length - 1].end,
      word_count: buf.filter((w) => w.type === 'word').length,
    });
    buf = [];
    charCount = 0;
  };

  for (const w of words) {
    buf.push(w);
    charCount += w.text.length;
    if (charCount >= maxChars) {
      // Try to break at sentence boundary within last 200 chars
      let lastDot = -1;
      for (let i = buf.length - 1; i >= Math.max(0, buf.length - 40); i--) {
        if (/[.!?]$/.test(buf[i].text.trim())) {
          lastDot = i;
          break;
        }
      }
      if (lastDot > 0) {
        const head = buf.slice(0, lastDot + 1);
        const tail = buf.slice(lastDot + 1);
        const text = head.map((w) => w.text).join('').trim();
        if (text) {
          chunks.push({
            text,
            start: head[0].start,
            end: head[head.length - 1].end,
            word_count: head.filter((w) => w.type === 'word').length,
          });
        }
        buf = tail;
        charCount = tail.reduce((n, w) => n + w.text.length, 0);
      } else {
        flush();
      }
    }
  }
  flush();
  return chunks;
}

async function fetchOEmbedTitle(videoId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { title?: string };
    return j.title ?? null;
  } catch {
    return null;
  }
}

const MONTHS_ES: Record<string, string> = {
  enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10',
  noviembre: '11', diciembre: '12',
};

interface ParsedTitle {
  comision: string;
  fecha: string | null;
  tipo: 'plenario' | 'comision' | 'extraordinaria';
}

function parseTitle(title: string | null): ParsedTitle {
  const fallback: ParsedTitle = { comision: 'Plenario', fecha: null, tipo: 'plenario' };
  if (!title) return fallback;

  // Date: "17 Marzo 2026" or "17 de marzo de 2026"
  let fecha: string | null = null;
  const dateMatch = title.match(/(\d{1,2})\s+(?:de\s+)?(\w+)\s+(?:de\s+)?(\d{4})/i);
  if (dateMatch) {
    const day = dateMatch[1].padStart(2, '0');
    const month = MONTHS_ES[dateMatch[2].toLowerCase()];
    const year = dateMatch[3];
    if (month) fecha = `${year}-${month}-${day}`;
  }

  // Comision: text before the first comma, dash, or date.
  let comision = title.split(/[,\-—]/)[0].trim();
  if (dateMatch) {
    const idx = title.indexOf(dateMatch[0]);
    if (idx > 0) comision = title.slice(0, idx).replace(/[,\-—]\s*$/, '').trim();
  }

  // Normalize: strip trailing punctuation
  comision = comision.replace(/[.,:;\s]+$/, '').trim();
  if (!comision) comision = 'Plenario';

  // tipo heuristic
  let tipo: ParsedTitle['tipo'] = 'comision';
  if (/plenario/i.test(comision)) tipo = 'plenario';
  if (/extraordinaria/i.test(title)) tipo = 'extraordinaria';

  return { comision, fecha, tipo };
}

interface Stats {
  scanned: number;
  skipped: number;
  indexed: number;
  failed: number;
  totalChunks: number;
}

async function processFile(fileName: string, stats: Stats): Promise<void> {
  const videoId = fileName.replace(TRANSCRIPT_PREFIX, '').replace(/\.json$/, '');
  if (!videoId) return;

  const { data: existing } = await supa
    .from('sessions')
    .select('id, status')
    .eq('legacy_video_id', videoId)
    .maybeSingle();

  if (existing?.status === 'indexed' && !force) {
    const { count } = await supa
      .from('legislative_chunks')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', existing.id);
    if (count && count > 0) {
      console.log(`[skip] ${videoId} already indexed (${count} chunks)`);
      stats.skipped++;
      return;
    }
  }

  console.log(`[proc] ${videoId} download…`);
  const [buf] = await storage.bucket(TRANSCRIPT_BUCKET).file(fileName).download();
  const json = JSON.parse(buf.toString());
  const inner = json['0'];
  if (!inner?.ok || !inner.transcription) throw new Error('transcript not ok');
  const t = inner.transcription;
  const words: Word[] = t.words ?? [];
  if (!words.length) throw new Error('no words in transcript');

  const chunks = chunkWords(words, CHUNK_CHARS);
  if (!chunks.length) throw new Error('chunking produced 0 chunks');

  const title = await fetchOEmbedTitle(videoId);
  const parsed = parseTitle(title);

  console.log(
    `[proc] ${videoId} → ${chunks.length} chunks, ${words.length} words | ${parsed.comision} | ${parsed.fecha ?? 'fecha?'} | tipo=${parsed.tipo}`,
  );

  const sessionRow = {
    legacy_video_id: videoId,
    fecha: parsed.fecha,
    comision: parsed.comision,
    tipo: parsed.tipo,
    video_url: `https://www.youtube.com/watch?v=${videoId}`,
    transcript_url: `gs://${TRANSCRIPT_BUCKET}/${fileName}`,
    status: 'processing' as const,
    metadata: {
      title,
      language: t.language_code,
      total_words: words.length,
      total_chars: t.text?.length ?? 0,
      source: 'gcs-elevenlabs',
    },
  };

  const { data: session, error: sErr } = await supa
    .from('sessions')
    .upsert(sessionRow, { onConflict: 'legacy_video_id' })
    .select('id')
    .single();
  if (sErr || !session) throw new Error(`session upsert: ${sErr?.message}`);

  await supa.from('legislative_chunks').delete().eq('session_id', session.id);

  const t0 = Date.now();
  const embeddings = await embedBatch(chunks.map((c) => c.text));
  const embedMs = Date.now() - t0;

  const rows = chunks.map((c, idx) => ({
    session_id: session.id,
    source_type: 'transcript' as const,
    source_ref: videoId,
    chunk_index: idx,
    content: c.text,
    embedding: embeddings[idx] as unknown as string,
    metadata: {
      start: c.start,
      end: c.end,
      word_count: c.word_count,
      title,
    },
  }));

  // Insert in batches of 50 to stay under payload limits with 3072-d vectors
  for (let i = 0; i < rows.length; i += 50) {
    const slice = rows.slice(i, i + 50);
    const { error: cErr } = await supa.from('legislative_chunks').insert(slice);
    if (cErr) throw new Error(`chunk insert (batch ${i}): ${cErr.message}`);
  }

  await supa
    .from('sessions')
    .update({ status: 'indexed', updated_at: new Date().toISOString() })
    .eq('id', session.id);

  stats.indexed++;
  stats.totalChunks += chunks.length;
  console.log(`[ok]   ${videoId}: ${chunks.length} chunks · embed ${embedMs}ms`);
}

async function main() {
  console.log(
    `[index] start. bucket=${TRANSCRIPT_BUCKET} prefix=${TRANSCRIPT_PREFIX} chunk=${CHUNK_CHARS} concurrency=${VERTEX_CONCURRENCY} model=${EMBED_MODEL}/${EMBED_DIM}d`,
  );
  if (limit !== Infinity) console.log(`[index] limit=${limit}`);
  if (fromId) console.log(`[index] from-id=${fromId}`);

  const stats: Stats = { scanned: 0, skipped: 0, indexed: 0, failed: 0, totalChunks: 0 };

  let pageToken: string | undefined;
  let stopped = false;
  outer: do {
    const [files, nextQuery] = await storage.bucket(TRANSCRIPT_BUCKET).getFiles({
      prefix: TRANSCRIPT_PREFIX,
      maxResults: 1000,
      pageToken,
      autoPaginate: false,
    });
    pageToken = (nextQuery as { pageToken?: string } | undefined)?.pageToken;

    for (const f of files) {
      if (!f.name.endsWith('.json')) continue;
      stats.scanned++;
      if (fromId && !f.name.includes(fromId)) continue;
      if (stats.indexed >= limit) {
        stopped = true;
        break outer;
      }
      try {
        await processFile(f.name, stats);
      } catch (err: any) {
        stats.failed++;
        console.error(`[err]  ${f.name}: ${err.message}`);
      }
    }
  } while (pageToken && !stopped);

  console.log(
    `\n[index] done. scanned=${stats.scanned} indexed=${stats.indexed} skipped=${stats.skipped} failed=${stats.failed} totalChunks=${stats.totalChunks}`,
  );
}

main().catch((err) => {
  console.error('[index] fatal', err);
  process.exit(1);
});

/**
 * ytDlpTranscript — fallback transcript fetcher using yt-dlp subprocess.
 *
 * Why this exists:
 *   The `youtube-transcript@1.3.1` lib uses a path that Google has been
 *   progressively closing in 2025-26. For short videos it still works, but
 *   for the long-form Asamblea plenarios (1-3h) the lib reports
 *   `YoutubeTranscriptDisabledError` even when the YouTube Data API
 *   confirms the ASR track is `serving`. yt-dlp uses a different path
 *   (Innertube + JS-challenge solving) and DOES download the captions.
 *
 *   We keep `youtube-transcript` as the fast path (no subprocess overhead)
 *   and fall through to yt-dlp only when the lib reports
 *   `no_transcript_available`. That keeps the happy case cheap and the
 *   degraded case still functional.
 *
 * Runtime requirement:
 *   The Docker image must have `yt-dlp` on PATH. The Microsoft Playwright
 *   base image (mcr.microsoft.com/playwright:v1.59.1-noble) ships Ubuntu
 *   noble, where `apt-get install -y yt-dlp` works. See Dockerfile.api.
 *
 * VTT parsing:
 *   yt-dlp emits WebVTT (RFC). We only need the timecodes + cleaned text.
 *   Auto-captions repeat each line twice (overlapping cues). We dedupe by
 *   keeping only the cue whose end-time matches the next cue's start.
 */
import { spawn } from 'node:child_process';

export interface YtDlpSegment {
  start_seconds: number;
  end_seconds: number;
  text: string;
}

export class YtDlpError extends Error {
  constructor(
    message: string,
    public readonly code: 'spawn_failed' | 'binary_missing' | 'no_subs' | 'parse_failed' | 'timeout',
    public readonly videoId: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'YtDlpError';
  }
}

const DEFAULT_TIMEOUT_MS = 60_000; // plenarios are ~3h videos; yt-dlp scrape is fast (<10s typical)

/**
 * Fetch transcript via yt-dlp. Spawns subprocess, captures VTT on stdout,
 * parses to segments. Resolves to [] if yt-dlp ran but no subs in target lang.
 */
export async function fetchTranscriptViaYtDlp(
  videoId: string,
  opts?: { language?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<YtDlpSegment[]> {
  const language = opts?.language ?? 'es';
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // --skip-download:    we only want subs, not the video
  // --write-auto-subs:  auto-generated captions (the Asamblea relies on them)
  // --sub-lang:         locale code; YouTube's auto-caption locale codes are
  //                     'es' (sometimes 'es-419'); -- the regexp form .* won't
  //                     match because yt-dlp expects exact tags
  // --sub-format vtt:   WebVTT is easier to parse than ttml/srv3
  // -o -:               output filename pattern; we read VTT from a tempfile
  //                     because yt-dlp doesn't reliably stream subs to stdout
  // We write to a unique tempfile and read it back — keeps stdout for logs.
  const tmpFile = `/tmp/yt-dlp-${videoId}-${Date.now()}.${language}.vtt`;

  const args = [
    '--skip-download',
    '--write-auto-subs',
    '--sub-lang', language,
    '--sub-format', 'vtt',
    '--no-warnings',
    '--quiet',
    // ── Anti-bot: YouTube detecta IPs de Cloud Run/AWS/GCP y devuelve
    //    "Sign in to confirm you're not a bot" para clientes android/ios/web.
    //    Solución 2026-05: usar tv_simply + mweb (mobile-web). Reportes en
    //    yt-dlp/yt-dlp#11868 y #12063 confirman que estos dos clients bypasean
    //    la verificación incluso desde IPs de cloud, cuando van con cookies.
    //    tv_simply es el cliente "Smart TV embebido" — no requiere PO Token.
    //    mweb es el cliente móvil html5 — usa endpoints menos rateados.
    //    Las cookies se renuevan cada ~7-14 días. Ver
    //    playbooks/exportar-cookies-youtube.md en el cerebro CL2.
    '--extractor-args', 'youtube:player_client=tv_simply,mweb',
    // User-agent móvil para hacer juego con el client mweb. tv_simply ignora UA.
    '--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    // Use the FILE pattern: yt-dlp will write the VTT next to the supplied path
    // with the language inserted as `<base>.<lang>.vtt`. We strip our suffix.
    '-o', tmpFile.replace(`.${language}.vtt`, '.%(ext)s'),
  ];

  // Inyectar cookies si hay un path en env var. En Cloud Run, montamos
  // /secrets/youtube-cookies.txt vía Secret Manager. En local/dev, podés
  // setear YT_COOKIES_PATH a tu ~/.config/yt-dlp-cookies.txt o similar.
  const cookiesPath = process.env.YT_COOKIES_PATH;
  let cookiesStatus: 'absent' | 'present' | 'missing_file' = 'absent';
  if (cookiesPath) {
    try {
      // sync stat — fast, infrequent (only at start of each download)
      const fs = await import('node:fs');
      if (fs.existsSync(cookiesPath)) {
        args.push('--cookies', cookiesPath);
        cookiesStatus = 'present';
      } else {
        cookiesStatus = 'missing_file';
      }
    } catch {
      cookiesStatus = 'missing_file';
    }
  }

  // Inyectar proxy residencial si está configurado. YouTube bloquea IPs de
  // cloud providers (Cloud Run/AWS/GCP). Cuando ni cookies ni player_clients
  // móviles bypaseen el bot check, la única solución es enrutar a través de
  // un proxy con IP residencial (Brightdata, Webshare, Smartproxy, etc.).
  // Formato esperado: http://user:pass@host:port o socks5://user:pass@host:port
  const proxyUrl = process.env.YT_PROXY_URL;
  let proxyStatus: 'absent' | 'configured' = 'absent';
  if (proxyUrl && proxyUrl.trim().length > 0) {
    args.push('--proxy', proxyUrl);
    proxyStatus = 'configured';
  }

  // Debug log so we can verify in production whether cookies/proxy actually
  // reached yt-dlp. Visible in Cloud Run jsonPayload.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    level: 'info',
    msg: 'ytdlp_args_prepared',
    videoId,
    cookiesStatus,
    cookiesPath: cookiesPath ?? null,
    proxyStatus,
    // Log proxy host only (not credentials) for debugging.
    proxyHost: proxyUrl ? safeProxyHost(proxyUrl) : null,
    argsCount: args.length,
  }));

  // URL siempre al final
  args.push(url);

  return new Promise<YtDlpSegment[]>((resolve, reject) => {
    const child = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: opts?.signal,
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new YtDlpError(`yt-dlp timed out after ${timeoutMs}ms`, 'timeout', videoId));
    }, timeoutMs);

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // ENOENT = binary not on PATH. Common in dev containers without yt-dlp.
      if (err.code === 'ENOENT') {
        reject(new YtDlpError(
          'yt-dlp binary not found on PATH. Install via apt or pip.',
          'binary_missing',
          videoId,
          err,
        ));
        return;
      }
      reject(new YtDlpError(`yt-dlp spawn failed: ${err.message}`, 'spawn_failed', videoId, err));
    });

    child.on('close', async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new YtDlpError(
          `yt-dlp exited with code ${code}: ${stderr.slice(0, 400)}`,
          'spawn_failed',
          videoId,
        ));
        return;
      }
      // Read tempfile + parse
      try {
        const fs = await import('node:fs/promises');
        const vtt = await fs.readFile(tmpFile, 'utf-8');
        await fs.unlink(tmpFile).catch(() => { /* best-effort cleanup */ });
        const segs = parseVtt(vtt);
        resolve(segs);
      } catch (err) {
        const fsErr = err as NodeJS.ErrnoException;
        if (fsErr.code === 'ENOENT') {
          // yt-dlp ran but didn't produce subs (no auto-caption available)
          reject(new YtDlpError(
            `yt-dlp ran but no ${language} subs were generated`,
            'no_subs',
            videoId,
          ));
          return;
        }
        reject(new YtDlpError(
          `Failed to parse yt-dlp VTT output: ${(err as Error).message}`,
          'parse_failed',
          videoId,
          err,
        ));
      }
    });
  });
}

/**
 * Parse a WebVTT string into ordered TranscriptSegment[].
 *
 * VTT structure (auto-captions from YouTube look like):
 *   WEBVTT
 *   Kind: captions
 *   Language: es
 *
 *   00:00:39.960 --> 00:00:41.630 align:start position:0%
 *   Hola,<00:00:40.239><c> muy</c><00:00:40.360><c> buenas</c>
 *
 * We:
 *   - Split on blank lines into cues
 *   - Parse the timecode line (HH:MM:SS.mmm --> HH:MM:SS.mmm)
 *   - Strip the inline word-level <00:00:40.239><c>...</c> annotations
 *   - Strip HTML tags (e.g. <c>, <i>)
 *   - Dedupe cues that repeat the same text (auto-caption rolling-window pattern)
 */
export function parseVtt(vtt: string): YtDlpSegment[] {
  const lines = vtt.split(/\r?\n/);
  const cues: YtDlpSegment[] = [];

  let i = 0;
  // Skip header (WEBVTT, Kind, Language, blank lines)
  while (i < lines.length && !lines[i].includes('-->')) i++;

  while (i < lines.length) {
    const tcLine = lines[i];
    if (!tcLine || !tcLine.includes('-->')) { i++; continue; }
    const tcMatch = tcLine.match(/(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/);
    if (!tcMatch) { i++; continue; }
    const startSec = hmsToSeconds(tcMatch[1]);
    const endSec = hmsToSeconds(tcMatch[2]);

    // Read text lines until blank line
    i++;
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(lines[i]);
      i++;
    }
    const text = cleanVttText(textLines.join(' '));
    if (text.length > 0 && endSec > startSec) {
      cues.push({ start_seconds: startSec, end_seconds: endSec, text });
    }
    // Skip blank line(s) before next cue
    while (i < lines.length && lines[i].trim() === '') i++;
  }

  return dedupeRollingCues(cues);
}

/**
 * Extract just host:port from a proxy URL for safe logging.
 * Never log credentials. Input: `http://user:pass@host:port` → `host:port`.
 */
function safeProxyHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '?'}`;
  } catch {
    return '<invalid-url>';
  }
}

/** "00:01:23.456" → 83.456 */
function hmsToSeconds(hms: string): number {
  const [h, m, rest] = hms.split(':');
  const [sec, ms] = rest.split('.');
  return Number(h) * 3600 + Number(m) * 60 + Number(sec) + Number(ms ?? 0) / 1000;
}

/**
 * YouTube auto-captions emit per-word timing inside cues:
 *   "Hola,<00:00:40.239><c> muy</c><00:00:40.360><c> buenas</c>"
 * We collapse to plain text by stripping all `<...>` tokens.
 * Also collapses repeated whitespace that VTT can introduce around line breaks.
 */
function cleanVttText(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')           // strip tags + word-level timecodes
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * YouTube auto-captions repeat the previous cue text in each new cue
 * (rolling window for accessibility). After cleanVttText, this looks like:
 *   cue 1: "hola buenas tardes"
 *   cue 2: "hola buenas tardes y bienvenidos"
 *   cue 3: "y bienvenidos a la sesión"
 * We dedupe by keeping only cues whose text isn't a strict prefix of the
 * next cue's text. The result is the natural ~3-7s phrasing the speaker used.
 */
function dedupeRollingCues(cues: YtDlpSegment[]): YtDlpSegment[] {
  if (cues.length <= 1) return cues;
  const out: YtDlpSegment[] = [];
  for (let i = 0; i < cues.length; i++) {
    const cur = cues[i];
    const next = cues[i + 1];
    if (next && next.text.startsWith(cur.text + ' ')) {
      // cur is a prefix of next — drop cur
      continue;
    }
    if (next && cur.text === next.text) {
      // exact duplicate — drop cur, keep next (which has later timing)
      continue;
    }
    out.push(cur);
  }
  return out;
}

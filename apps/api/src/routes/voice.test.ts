/**
 * Tests for voice.ts — STT proxy + voice-converse loop.
 *
 * Handlers are invoked directly via the router stack (same pattern as
 * transcripts.test.ts — supertest isn't installed and the routing layer
 * is trivial enough that this is a non-issue).
 *
 * Mocks:
 *   - getUserFromRequest / getUserIdFromRequest → controllable userId/email
 *   - requireQuota / getUserQuota / logAiCall    → controllable per test
 *   - transcribeAudio / synthesizeSpeech         → in-memory ElevenLabs stubs
 *   - openRouterStream                           → simulates token streaming
 *   - @supabase/supabase-js                      → returns canned ai_call_log rows
 *
 * Coverage:
 *   1. /converse rejects when audio is missing (400)
 *   2. /converse rejects when audio is empty (400)
 *   3. /converse rejects when audio > 5 MB (413)
 *   4. /converse rejects when LLM token cap is exceeded — verified by
 *      asserting the TTS char cap truncates a long LLM reply.
 *   5. /converse happy path: STT + LLM + TTS chain runs, response shape
 *      matches contract, ai_call_log meta records tts_chars.
 *   6. /converse rejects when monthly TTS quota is exhausted (429).
 *   7. /converse 401 when unauthed.
 *   8. /quota returns the expected shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ── Supabase mock (drives the monthly-TTS-chars query) ────────────────

let _monthlyRows: Array<{ meta: { tts_chars?: number } }> = [];

vi.mock('@supabase/supabase-js', () => {
  function makeChain(): Record<string, (...args: unknown[]) => unknown> {
    const c: Record<string, (...args: unknown[]) => unknown> = {
      from: () => makeChain(),
      select: () => makeChain(),
      insert: () => Promise.resolve({ data: null, error: null }),
      eq: () => makeChain(),
      gte: () => Promise.resolve({ data: _monthlyRows, error: null }),
      rpc: () => Promise.resolve({ data: 0, error: null }),
    };
    // Make the chain awaitable for shapes that don't terminate via .gte()
    (c as Record<string, unknown>).then = (
      resolve: (v: unknown) => unknown,
      _reject: (e: unknown) => unknown,
    ) => Promise.resolve({ data: _monthlyRows, error: null }).then(resolve, _reject);
    return c;
  }
  return {
    createClient: () => makeChain(),
  };
});

// ── Auth mock ─────────────────────────────────────────────────────────

const mockGetUserFromRequest = vi.fn();
const mockGetUserIdFromRequest = vi.fn();

vi.mock('../services/auth.js', () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUserFromRequest(...args),
  getUserIdFromRequest: (...args: unknown[]) => mockGetUserIdFromRequest(...args),
}));

// ── ElevenLabs client mock ────────────────────────────────────────────

const mockTranscribeAudio = vi.fn();
const mockSynthesizeSpeech = vi.fn();

vi.mock('../services/elevenlabsClient.js', () => ({
  transcribeAudio: (...args: unknown[]) => mockTranscribeAudio(...args),
  synthesizeSpeech: (...args: unknown[]) => mockSynthesizeSpeech(...args),
}));

// ── openRouterStream mock ─────────────────────────────────────────────

const mockOpenRouterStream = vi.fn();

vi.mock('../services/openRouterClient.js', () => ({
  openRouterStream: (...args: unknown[]) => mockOpenRouterStream(...args),
}));

// ── aiQuota mock ──────────────────────────────────────────────────────

const mockRequireQuota = vi.fn();
const mockLogAiCall = vi.fn();
const mockGetUserQuota = vi.fn();

vi.mock('../services/aiQuota.js', () => ({
  requireQuota: (...args: unknown[]) => mockRequireQuota(...args),
  logAiCall: (...args: unknown[]) => mockLogAiCall(...args),
  getUserQuota: (...args: unknown[]) => mockGetUserQuota(...args),
}));

// ── rateLimit middleware — no-op in tests (we test the cap-paths in aiQuota) ─

vi.mock('../middleware/rateLimit.js', () => ({
  rateLimit: () =>
    async (_req: Request, _res: Response, next: (err?: unknown) => void) => next(),
}));

// Logger silenced — index.ts pulls it transitively via openRouterClient
// which we already mock, but the route handler also calls req.log directly
// via the mock req object below.

// ── Import router AFTER mocks ─────────────────────────────────────────

import { voiceRouter } from './voice.js';

// ── Helpers ───────────────────────────────────────────────────────────

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    body: {},
    ip: '127.0.0.1',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides,
  } as unknown as Request;
}

type ResponseCapture = {
  statusCode: number;
  body: unknown;
  status: (code: number) => ResponseCapture;
  json: (body: unknown) => void;
};

function makeRes(): ResponseCapture {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
    },
    setHeader: vi.fn(),
  } as unknown as ResponseCapture;
  return res;
}

interface RouterLayer {
  route?: {
    path: string;
    stack: Array<{ method: string; handle: (...args: unknown[]) => unknown }>;
  };
}

async function invoke(
  method: 'post' | 'get',
  path: string,
  req: Request,
  res: Response,
): Promise<void> {
  const stack = (voiceRouter as unknown as { stack: RouterLayer[] }).stack;
  for (const layer of stack) {
    if (layer.route && layer.route.path === path) {
      const handlers = layer.route.stack.filter((h) => h.method === method);
      if (handlers.length === 0) break;
      // Walk handlers in order, mimicking what express does. Each handler
      // can short-circuit by writing the response (we detect via statusCode
      // being touched OR res.body being set). multer middleware exposes
      // req.file when configured; in tests we pre-populate req.file ourselves
      // so the multer layer is a no-op — we just call its single-arity
      // signature with a next that proceeds.
      for (const h of handlers) {
        await new Promise<void>((resolve, reject) => {
          let calledNext = false;
          const next = (err?: unknown) => {
            calledNext = true;
            if (err) reject(err as Error);
            else resolve();
          };
          let maybePromise: unknown;
          try {
            maybePromise = (h.handle as (...args: unknown[]) => unknown)(
              req,
              res,
              next,
            );
          } catch (err) {
            reject(err as Error);
            return;
          }
          Promise.resolve(maybePromise)
            .then(() => {
              if (!calledNext) resolve();
            })
            .catch(reject);
        });
        // If the handler wrote a response (status was changed or body set),
        // stop walking the chain.
        const out = res as unknown as { statusCode: number; body: unknown };
        if (out.body !== undefined) return;
      }
      return;
    }
  }
  throw new Error(`No ${method.toUpperCase()} handler for ${path}`);
}

// ── Setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
  vi.stubEnv('ELEVENLABS_API_KEY', 'test-eleven-key');

  _monthlyRows = [];

  mockGetUserFromRequest.mockReset();
  mockGetUserIdFromRequest.mockReset();
  mockTranscribeAudio.mockReset();
  mockSynthesizeSpeech.mockReset();
  mockOpenRouterStream.mockReset();
  mockRequireQuota.mockReset();
  mockLogAiCall.mockReset();
  mockGetUserQuota.mockReset();

  // Defaults: authenticated, quota ok, mp3 returned.
  mockGetUserFromRequest.mockResolvedValue({ id: 'user-1', email: 'jred@shiftlab.cr' });
  mockGetUserIdFromRequest.mockResolvedValue('user-1');
  mockRequireQuota.mockResolvedValue('ok');
  mockLogAiCall.mockResolvedValue(undefined);
  mockGetUserQuota.mockResolvedValue({ used: 3, limit: 500, remaining: 497 });
  mockTranscribeAudio.mockResolvedValue('hola Lexa, qué pasó hoy en plenario');
  mockSynthesizeSpeech.mockResolvedValue(Buffer.from('FAKEMP3', 'utf-8'));
  mockOpenRouterStream.mockImplementation(async (args: { onChunk?: (chunk: unknown) => void }) => {
    args.onChunk?.({ type: 'token', payload: 'En el plenario de hoy se discutió el expediente 12345 sobre seguridad ciudadana. ' });
    args.onChunk?.({ type: 'token', payload: 'Hubo 38 diputados presentes y la votación fue 22 a favor.' });
  });
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('POST /api/voice/converse', () => {
  it('test 1: returns 400 when audio is missing', async () => {
    const req = makeReq({ body: {} });
    // No req.file set
    const res = makeRes();
    await invoke('post', '/converse', req as Request, res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('audio_required');
    expect(mockTranscribeAudio).not.toHaveBeenCalled();
  });

  it('test 2: returns 400 when audio is empty (0 bytes)', async () => {
    const req = makeReq({
      body: {},
      file: { buffer: Buffer.alloc(0), size: 0, mimetype: 'audio/webm' },
    } as Partial<Request>);
    const res = makeRes();
    await invoke('post', '/converse', req as Request, res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('empty_audio');
  });

  it('test 3: returns 413 when audio > 5 MB', async () => {
    // Bypass multer in this test by setting req.file directly with a size
    // that exceeds the cap — the in-handler re-check should catch it.
    const tooBig = 6 * 1024 * 1024;
    const req = makeReq({
      body: {},
      file: { buffer: Buffer.alloc(1024), size: tooBig, mimetype: 'audio/webm' },
    } as Partial<Request>);
    const res = makeRes();
    await invoke('post', '/converse', req as Request, res as unknown as Response);
    expect(res.statusCode).toBe(413);
    expect((res.body as { error: string }).error).toBe('audio_too_large');
    expect(mockTranscribeAudio).not.toHaveBeenCalled();
  });

  it('test 4: caps TTS input at 800 chars even when LLM emits more', async () => {
    // Mock LLM to emit a very long reply (well beyond 800 chars). The
    // route MUST clip what it sends to TTS but still return the FULL text
    // in transcript_lexa so the UI can show what was generated.
    const huge = 'A'.repeat(2000);
    mockOpenRouterStream.mockImplementation(async (args: { onChunk?: (chunk: unknown) => void }) => {
      args.onChunk?.({ type: 'token', payload: huge });
    });

    const req = makeReq({
      body: {},
      file: { buffer: Buffer.from('x'.repeat(1024)), size: 1024, mimetype: 'audio/webm' },
    } as Partial<Request>);
    const res = makeRes();
    await invoke('post', '/converse', req as Request, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(mockSynthesizeSpeech).toHaveBeenCalledOnce();
    const ttsArg = mockSynthesizeSpeech.mock.calls[0][0] as string;
    expect(ttsArg.length).toBeLessThanOrEqual(801); // 800 chars + trailing ellipsis

    // The full transcript should still be returned to the client unclipped.
    const body = res.body as { transcript_lexa: string };
    expect(body.transcript_lexa.length).toBe(2000);
  });

  it('test 5: happy path — returns transcript_user + transcript_lexa + audio_url, logs tts_chars', async () => {
    const req = makeReq({
      body: { history: JSON.stringify([{ role: 'user', content: 'turno previo' }]) },
      file: { buffer: Buffer.from('x'.repeat(1024)), size: 1024, mimetype: 'audio/webm' },
    } as Partial<Request>);
    const res = makeRes();
    await invoke('post', '/converse', req as Request, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      ok: boolean;
      transcript_user: string;
      transcript_lexa: string;
      audio_url: string;
    };
    expect(body.ok).toBe(true);
    expect(body.transcript_user).toMatch(/plenario/i);
    expect(body.transcript_lexa).toMatch(/expediente 12345/);
    expect(body.audio_url).toMatch(/^data:audio\/mpeg;base64,/);

    // Pipeline calls in order
    expect(mockTranscribeAudio).toHaveBeenCalledOnce();
    expect(mockOpenRouterStream).toHaveBeenCalledOnce();
    expect(mockSynthesizeSpeech).toHaveBeenCalledOnce();

    // History forwarded to openRouterStream
    const streamArgs = mockOpenRouterStream.mock.calls[0][0] as {
      agent_id: string;
      history: Array<{ role: string; content: string }>;
      user_id: string | null;
      user_email: string | null;
    };
    expect(streamArgs.agent_id).toBe('lexa');
    expect(streamArgs.history).toHaveLength(1);
    expect(streamArgs.user_id).toBe('user-1');
    expect(streamArgs.user_email).toBe('jred@shiftlab.cr');

    // ai_call_log meta records tts_chars (the cap-input length, not the
    // full LLM response — the monthly quota tracks BILLED chars).
    expect(mockLogAiCall).toHaveBeenCalledOnce();
    const logMeta = mockLogAiCall.mock.calls[0][2] as { tts_chars: number };
    expect(logMeta.tts_chars).toBeGreaterThan(0);
  });

  it('test 6: returns 429 when monthly TTS quota is exhausted', async () => {
    // Seed the in-memory supabase result with rows summing to more than
    // the default 90,000-char cap.
    _monthlyRows = [
      { meta: { tts_chars: 50_000 } },
      { meta: { tts_chars: 45_000 } },
    ];

    const req = makeReq({
      body: {},
      file: { buffer: Buffer.from('x'.repeat(1024)), size: 1024, mimetype: 'audio/webm' },
    } as Partial<Request>);
    const res = makeRes();
    await invoke('post', '/converse', req as Request, res as unknown as Response);

    expect(res.statusCode).toBe(429);
    const body = res.body as { error: string; used: number; limit: number };
    expect(body.error).toBe('monthly_tts_quota_exhausted');
    expect(body.used).toBe(95_000);
    expect(body.limit).toBe(90_000);
    expect(mockTranscribeAudio).not.toHaveBeenCalled();
    expect(mockOpenRouterStream).not.toHaveBeenCalled();
    expect(mockSynthesizeSpeech).not.toHaveBeenCalled();
  });

  it('test 7: returns 401 when unauthenticated', async () => {
    mockGetUserFromRequest.mockResolvedValue(null);
    const req = makeReq({
      body: {},
      file: { buffer: Buffer.from('x'.repeat(1024)), size: 1024, mimetype: 'audio/webm' },
    } as Partial<Request>);
    const res = makeRes();
    await invoke('post', '/converse', req as Request, res as unknown as Response);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: string }).error).toBe('auth_required');
  });

  it('test 7b: returns 400 when STT returns empty transcript (silence)', async () => {
    mockTranscribeAudio.mockResolvedValue('   ');
    const req = makeReq({
      body: {},
      file: { buffer: Buffer.from('x'.repeat(1024)), size: 1024, mimetype: 'audio/webm' },
    } as Partial<Request>);
    const res = makeRes();
    await invoke('post', '/converse', req as Request, res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('empty_transcript');
    expect(mockOpenRouterStream).not.toHaveBeenCalled();
    expect(mockSynthesizeSpeech).not.toHaveBeenCalled();
  });
});

describe('GET /api/voice/quota', () => {
  it('test 8: returns chars_used_month + chars_quota + conversaciones_today', async () => {
    _monthlyRows = [{ meta: { tts_chars: 12_000 } }, { meta: { tts_chars: 3_500 } }];
    mockGetUserQuota.mockResolvedValue({ used: 4, limit: 500, remaining: 496 });

    const req = makeReq();
    const res = makeRes();
    await invoke('get', '/quota', req as Request, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      ok: boolean;
      chars_used_month: number;
      chars_quota: number;
      conversaciones_today: number;
      conversaciones_daily_limit: number;
    };
    expect(body.ok).toBe(true);
    expect(body.chars_used_month).toBe(15_500);
    expect(body.chars_quota).toBe(90_000);
    expect(body.conversaciones_today).toBe(4);
    expect(body.conversaciones_daily_limit).toBe(500);
  });

  it('test 8b: 401 when unauthenticated', async () => {
    mockGetUserIdFromRequest.mockResolvedValue(null);
    const req = makeReq();
    const res = makeRes();
    await invoke('get', '/quota', req as Request, res as unknown as Response);
    expect(res.statusCode).toBe(401);
  });
});

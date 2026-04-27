/**
 * Voice → prompt — ElevenLabs Scribe STT proxy.
 *
 * The user holds the mic button on the chat composer, MediaRecorder captures
 * webm/opus, the blob lands here, ElevenLabs Scribe transcribes it, we
 * return the text. The frontend then stuffs that text into the textarea so
 * the user can review/edit before sending.
 *
 * Why server-side:
 *   - The ElevenLabs API key never touches the browser.
 *   - We can rate-limit/cap audio length centrally.
 *
 * Cost shape:
 *   - Scribe v1 is ~$0.0067/min. A 30-second prompt costs ~$0.003.
 *   - At 60 prompts/min/user (rate limit cap) the worst case is ~$0.20/min/user;
 *     in practice users speak for 5-15s, costing fractions of a cent.
 *
 * Why we don't stream:
 *   - Scribe's streaming endpoint adds complexity for a UX that already
 *     looks instant (1-2s for short prompts). Ship the simple version first.
 */
import { Router } from 'express';
import multer from 'multer';
import { getUserIdFromRequest } from '../services/auth.js';
import { requireQuota, logAiCall } from '../services/aiQuota.js';
import { transcribeAudio } from '../services/elevenlabsClient.js';

export const voiceRouter = Router();

// 25MB ≈ 25 min of webm/opus at 64kbps. Hard cap so a runaway recorder
// can't ship a 1GB file. multer parses multipart/form-data into req.file.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

voiceRouter.post('/transcribe', upload.single('audio'), async (req, res) => {
  // Auth gate — voice transcription is per-user, not anonymous. Public
  // demo can ship a separate endpoint with stricter caps if needed.
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return;
  }

  if (!req.file) {
    res.status(400).json({ ok: false, error: 'audio_required' });
    return;
  }
  if (req.file.size === 0) {
    res.status(400).json({ ok: false, error: 'empty_audio' });
    return;
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    res.status(500).json({ ok: false, error: 'eleven_not_configured' });
    return;
  }

  // Daily quota gate — Scribe v1 charges ~$0.0067/min so an
  // unbounded user could rack up real money. requireQuota writes the
  // 429 if over the cap; we exit before contacting ElevenLabs.
  if ((await requireQuota(userId, 'voice.transcribe', res)) === 'denied') return;

  try {
    const t0 = Date.now();
    const text = await transcribeAudio(req.file.buffer, req.file.mimetype);
    void logAiCall(userId, 'voice.transcribe', {
      bytes: req.file.size,
      mime: req.file.mimetype,
      length_chars: text.length,
    });
    req.log?.info('voice/transcribe ok', {
      bytes: req.file.size,
      mime: req.file.mimetype,
      chars: text.length,
      ms: Date.now() - t0,
    });
    res.json({ ok: true, text });
  } catch (err) {
    req.log?.warn('voice/transcribe failed', { error: (err as Error).message });
    res.status(502).json({ ok: false, error: 'transcribe_failed', detail: (err as Error).message });
  }
});

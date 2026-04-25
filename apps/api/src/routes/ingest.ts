/**
 * Document ingest endpoints — Atlas's PDF upload + extraction.
 *
 * MVP scope: extract full text via pdf-parse, return inline. Caller (frontend)
 * keeps text in chat state and prepends it to the next Atlas turn.
 *
 * Sprint 3: chunk + embed + persist with source_type='pdf' for cross-conversation
 * RAG (so user can ask Atlas about a doc weeks later).
 */
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { getUserIdFromRequest } from '../services/auth.js';

const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25MB
const MAX_TEXT_CHARS = 60_000; // ~15K tokens — fits Sonnet/Opus context with room to spare

export const ingestRouter = Router();

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return null;
  }
  return userId;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES },
});

// pdf-parse v2 exports a PDFParse class. Dynamic import keeps the ESM/CJS bridge clean.
let _PDFParse: any | null = null;
async function getPDFParse(): Promise<any> {
  if (_PDFParse) return _PDFParse;
  const mod = await import('pdf-parse');
  _PDFParse = (mod as any).PDFParse ?? (mod as any).default?.PDFParse;
  if (!_PDFParse) throw new Error('pdf-parse: PDFParse class not found');
  return _PDFParse;
}

ingestRouter.post('/pdf', upload.single('file'), async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    if (!req.file) {
      res.status(400).json({ ok: false, error: 'no file uploaded (field name: "file")' });
      return;
    }
    if (req.file.mimetype !== 'application/pdf' && !req.file.originalname.toLowerCase().endsWith('.pdf')) {
      res.status(400).json({ ok: false, error: 'only PDF files accepted' });
      return;
    }

    const PDFParse = await getPDFParse();
    const parser = new PDFParse({ data: req.file.buffer });
    const parsed = await parser.getText();
    await parser.destroy?.();

    const fullText = (parsed.text ?? '').trim();
    const numPages = parsed.total ?? parsed.pages?.length ?? 0;
    const truncated = fullText.length > MAX_TEXT_CHARS;
    const text = truncated ? `${fullText.slice(0, MAX_TEXT_CHARS)}\n\n[…documento truncado en ${MAX_TEXT_CHARS} caracteres]` : fullText;

    req.log.info('ingest_pdf_ok', {
      userId,
      filename: req.file.originalname,
      pages: numPages,
      chars: fullText.length,
      truncated,
    });

    res.json({
      ok: true,
      doc_id: randomUUID(),
      filename: req.file.originalname,
      pages: numPages,
      chars: fullText.length,
      truncated,
      text,
    });
  } catch (err) {
    req.log.error('ingest_pdf_failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message, request_id: req.requestId });
  }
});

ingestRouter.post('/youtube', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  res.json({
    ok: true,
    message: 'youtube ingest stub — to be implemented in Sprint 3',
    url: req.body?.url ?? null,
  });
});

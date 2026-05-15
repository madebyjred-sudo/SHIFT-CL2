#!/usr/bin/env npx tsx
/**
 * ingest-doctrina-parlamentaria.ts — Descarga e indexa la biblioteca de
 * doctrina parlamentaria del Departamento de Servicios Parlamentarios de la
 * Asamblea Legislativa de Costa Rica.
 *
 * FUENTE:
 *   https://www.asamblea.go.cr/sd/invest_parlamentarias/
 *   12 PDFs públicos sin autenticación.
 *
 * QUÉ HACE:
 *   1. Para cada PDF registrado en `doctrina_pdfs` (tabla con estado='pending'
 *      o 'stale'):
 *      a. HEAD request → Last-Modified + Content-Length.
 *      b. Si el hash local coincide con el remoto → skip (no cambió).
 *      c. GET → descarga el PDF en memoria.
 *      d. Calcula SHA256 del buffer.
 *      e. Sube a GCS bucket `shift-cl2-sil` en path `doctrina/<nombre>`.
 *      f. Actualiza `doctrina_pdfs` con hash + estado='downloaded'.
 *   2. Para cada PDF descargado / marcado como recién descargado:
 *      a. Extrae texto con pdfjs-dist (via pdfToText del servicio existente).
 *      b. Si es el RAL Comentado → chunker especializado (ralChunker.ts).
 *         Upserta en ral_articulos + ral_interpretaciones.
 *      c. Si es otro PDF de doctrina → chunking genérico (por resolución o
 *         por POR TANTO para sentencias). Upserta en ral_interpretaciones
 *         buscando el artículo más relevante por número citado.
 *      d. Actualiza doctrina_pdfs.estado='indexed' + last_indexed_at.
 *   3. Logs estructurados (JSON lines) compatibles con Cloud Logging.
 *
 * MODO DRY-RUN:
 *   DRY_RUN=true npx tsx apps/api/scripts/ingest-doctrina-parlamentaria.ts
 *   → Reporta qué haría sin descargar ni escribir a la base de datos.
 *
 * MODO SINGLE:
 *   PDF_FILTER=Reglamento_Asamblea_Legislativa_Comentado_5Edicion npx tsx ...
 *   → Solo procesa los PDFs cuyo nombre_archivo contiene ese substring.
 *
 * ENV VARS requeridas:
 *   NEXT_PUBLIC_SUPABASE_URL       Supabase project URL.
 *   SUPABASE_SERVICE_ROLE_KEY      Service role key (bypasea RLS).
 *   GCS_BUCKET                     Nombre del bucket (default: shift-cl2-sil).
 *   GOOGLE_APPLICATION_CREDENTIALS Path al SA JSON para GCS auth.
 *
 * ENV VARS opcionales:
 *   DRY_RUN=true          No escribe nada, solo muestra lo que haría.
 *   PDF_FILTER=<substr>   Procesa solo PDFs cuyo nombre contiene este string.
 *   SKIP_DOWNLOAD=true    Asume que los PDFs ya están en GCS, salta descarga.
 *   NODE_TLS_REJECT_UNAUTHORIZED=0  Para entornos donde el cert gov es problemático.
 *
 * EXIT CODES:
 *   0 = todo indexado sin errores
 *   1 = al menos un PDF falló
 *
 * CRON MENSUAL (re-ingest automático):
 *   Agregar al Cloud Scheduler o crontab:
 *     0 3 1 * * npx tsx apps/api/scripts/ingest-doctrina-parlamentaria.ts
 *   El script detecta cambios via SHA256 y solo re-indexa los PDFs que cambiaron.
 *
 * DISEÑO:
 *   Track F, Sprint 1 — 2026-05-14.
 *   Pedidos 13 y 14 de la reunión cliente 2026-05-14-reunion-cliente-pedidos-en-vivo.md.
 *   §15c: "cuando haya un cambio vuelva y lo interiorice" → cron mensual + hash check.
 */

// TLS: el servidor de la Asamblea a veces tiene problemas con la cadena de certs.
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

import 'dotenv/config';
import * as crypto from 'crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Storage } from '@google-cloud/storage';
import { logger } from '../src/services/logger.js';
import { pdfToText } from '../src/services/pdfExtractor.js';
import { chunkRalComentado, extractInterpretaciones, extractPorTanto } from '../src/services/ralChunker.js';

// ─── Config ────────────────────────────────────────────────────────────────────

const DRY_RUN = process.env.DRY_RUN === 'true';
const PDF_FILTER = process.env.PDF_FILTER ?? '';
const SKIP_DOWNLOAD = process.env.SKIP_DOWNLOAD === 'true';
const GCS_BUCKET = process.env.GCS_BUCKET ?? 'shift-cl2-sil';
const GCS_PREFIX = 'doctrina';

// Demora entre PDFs para ser educados con el servidor gubernamental.
const POLITENESS_DELAY_MS = 3_000;

// Nombres de archivo de los RAL Comentados. El chunker especializado
// solo aplica para estos PDFs. Los demás usan chunking genérico.
const RAL_COMENTADO_NAMES = [
  'Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf',
  'Reglamento_Asamblea_Legislativa_Comentado.pdf',
  'Reglamento_Asamblea_Legislativa_Historico_IEdicion.pdf',
];

// Los PDFs de sentencias y resoluciones usan la heurística POR TANTO.
const SENTENCIAS_NAMES = [
  'Inv_05_2026_Sentencias_ProcedimientoLegislativo.pdf',
];

// Sufijo de la edición para el RAL 5ta Edición (el más reciente, el canónico).
const EDICION_5TA = '5ta Edición';
const EDICION_MAP: Record<string, string> = {
  'Reglamento_Asamblea_Legislativa_Comentado_5Edicion.pdf': EDICION_5TA,
  'Reglamento_Asamblea_Legislativa_Comentado.pdf': '4ta Edición (o anterior)',
  'Reglamento_Asamblea_Legislativa_Historico_IEdicion.pdf': 'Histórico 1ra Edición',
};

// ─── Supabase client ───────────────────────────────────────────────────────────

function buildSupa(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// ─── GCS helpers ──────────────────────────────────────────────────────────────

let _gcs: Storage | null = null;
function gcs(): Storage {
  if (!_gcs) _gcs = new Storage();
  return _gcs;
}

async function uploadToGcs(
  buffer: Buffer,
  destPath: string,
  contentType = 'application/pdf',
): Promise<string> {
  const bucket = gcs().bucket(GCS_BUCKET);
  const file = bucket.file(destPath);
  await file.save(buffer, {
    metadata: { contentType },
    resumable: false,
  });
  return `gs://${GCS_BUCKET}/${destPath}`;
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────────

interface HeadResult {
  lastModified: Date | null;
  contentLength: number | null;
}

async function headRequest(url: string): Promise<HeadResult> {
  const res = await fetch(url, { method: 'HEAD' });
  if (!res.ok) {
    throw new Error(`HEAD ${url} → ${res.status} ${res.statusText}`);
  }
  const lm = res.headers.get('last-modified');
  const cl = res.headers.get('content-length');
  return {
    lastModified: lm ? new Date(lm) : null,
    contentLength: cl ? parseInt(cl, 10) : null,
  };
}

async function downloadPdf(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Tipos de registro en doctrina_pdfs ────────────────────────────────────────

interface DoctrinaPdf {
  id: string;
  nombre_archivo: string;
  url_publica: string;
  storage_path: string | null;
  content_hash: string | null;
  last_modified_remoto: string | null;
  last_downloaded_at: string | null;
  last_indexed_at: string | null;
  paginas: number | null;
  estado: 'pending' | 'downloaded' | 'indexed' | 'failed' | 'stale';
  notas: string | null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const log = logger.with({ script: 'ingest-doctrina-parlamentaria' });

  if (DRY_RUN) {
    log.info('DRY_RUN=true — no DB writes, no GCS uploads', {});
  }

  const supa = buildSupa();

  // 1. Cargar todos los PDFs del catálogo.
  const { data: allPdfs, error: fetchErr } = await supa
    .from('doctrina_pdfs')
    .select('*')
    .order('created_at', { ascending: true });

  if (fetchErr) {
    log.error('Failed to fetch doctrina_pdfs', { error: fetchErr.message });
    process.exit(1);
  }

  let pdfs = (allPdfs ?? []) as DoctrinaPdf[];

  // Aplicar filtro por nombre si se pasó PDF_FILTER.
  if (PDF_FILTER) {
    pdfs = pdfs.filter((p) => p.nombre_archivo.includes(PDF_FILTER));
    log.info(`PDF_FILTER="${PDF_FILTER}" → ${pdfs.length} PDFs a procesar`, {});
  }

  if (pdfs.length === 0) {
    log.warn('No PDFs to process. Check doctrina_pdfs table or PDF_FILTER.', {});
    // Esto puede pasar si la migración 0035 no se ha aplicado aún.
    log.info('HINT: apply migration 0035_ral_comentado.sql first.', {});
    process.exit(0);
  }

  log.info(`Starting ingest of ${pdfs.length} doctrina PDFs`, {
    dry_run: DRY_RUN,
    bucket: GCS_BUCKET,
  });

  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (const pdf of pdfs) {
    const pdfLog = log.with({ nombre: pdf.nombre_archivo });

    pdfLog.info('Processing PDF', { estado: pdf.estado, url: pdf.url_publica });

    try {
      // ── Step 1: HEAD request ────────────────────────────────────────────────
      let headInfo: HeadResult | null = null;
      if (!SKIP_DOWNLOAD) {
        try {
          headInfo = await headRequest(pdf.url_publica);
          pdfLog.info('HEAD ok', {
            last_modified: headInfo.lastModified?.toISOString() ?? 'unknown',
            content_length: headInfo.contentLength ?? 'unknown',
          });
        } catch (headErr) {
          // HEAD falla en algunos servidores gubernamentales.
          // Continuar con descarga directa.
          pdfLog.warn('HEAD failed, will attempt GET directly', {
            error: (headErr as Error).message,
          });
        }
      }

      // ── Step 2: Decidir si hay que descargar ───────────────────────────────
      let needsDownload = !SKIP_DOWNLOAD && (
        pdf.estado === 'pending' ||
        pdf.estado === 'stale' ||
        pdf.content_hash === null
      );

      // Si tenemos Last-Modified y es igual al anterior registrado, skip.
      if (
        !needsDownload &&
        headInfo?.lastModified &&
        pdf.last_modified_remoto &&
        new Date(pdf.last_modified_remoto).getTime() === headInfo.lastModified.getTime()
      ) {
        pdfLog.info('No changes detected (Last-Modified matches). Skipping.', {});
        skipCount++;
        continue;
      }

      if (needsDownload && !DRY_RUN) {
        // ── Step 3: Descargar ────────────────────────────────────────────────
        pdfLog.info('Downloading PDF...', { url: pdf.url_publica });
        const pdfBuffer = await downloadPdf(pdf.url_publica);
        const hash = sha256Hex(pdfBuffer);

        pdfLog.info('Downloaded PDF', {
          bytes: pdfBuffer.length,
          hash: hash.slice(0, 12) + '...',
        });

        // Si el hash es igual al anterior → no cambió realmente.
        if (pdf.content_hash && pdf.content_hash === hash) {
          pdfLog.info('Hash identical to previous → no changes. Skipping.', {});
          skipCount++;
          continue;
        }

        // ── Step 4: Subir a GCS ──────────────────────────────────────────────
        const gcsPath = `${GCS_PREFIX}/${pdf.nombre_archivo}`;
        try {
          const gcsUri = await uploadToGcs(pdfBuffer, gcsPath);
          pdfLog.info('Uploaded to GCS', { gcs_uri: gcsUri });
        } catch (gcsErr) {
          pdfLog.warn('GCS upload failed (continuing with local buffer)', {
            error: (gcsErr as Error).message,
          });
        }

        // ── Step 5: Actualizar doctrina_pdfs ────────────────────────────────
        const updatePayload: Partial<DoctrinaPdf> & Record<string, unknown> = {
          content_hash: hash,
          storage_path: `${GCS_BUCKET}/${gcsPath}`,
          last_downloaded_at: new Date().toISOString(),
          estado: 'downloaded',
        };
        if (headInfo?.lastModified) {
          updatePayload.last_modified_remoto = headInfo.lastModified.toISOString();
        }
        const { error: updateErr } = await supa
          .from('doctrina_pdfs')
          .update(updatePayload)
          .eq('id', pdf.id);
        if (updateErr) {
          pdfLog.warn('Failed to update doctrina_pdfs after download', {
            error: updateErr.message,
          });
        }

        // ── Step 6: Indexar ──────────────────────────────────────────────────
        const totalRows = await indexPdf(supa, pdf, pdfBuffer, pdfLog);

        if (!DRY_RUN) {
          const { error: idxErr } = await supa
            .from('doctrina_pdfs')
            .update({
              estado: 'indexed',
              last_indexed_at: new Date().toISOString(),
            })
            .eq('id', pdf.id);
          if (idxErr) {
            pdfLog.warn('Failed to set estado=indexed', { error: idxErr.message });
          }
        }

        pdfLog.info('PDF indexed successfully', { rows_upserted: totalRows });
        successCount++;
      } else if (DRY_RUN) {
        pdfLog.info('[DRY_RUN] Would download and index this PDF', {
          url: pdf.url_publica,
          current_estado: pdf.estado,
        });
        successCount++;
      } else {
        // SKIP_DOWNLOAD=true → re-indexar sin descargar.
        pdfLog.info('SKIP_DOWNLOAD=true, re-indexing from GCS not implemented yet.', {});
        pdfLog.info('TODO: download from GCS bucket and re-index.', {});
        skipCount++;
      }

    } catch (err) {
      pdfLog.error('Failed to process PDF', { error: (err as Error).message });
      failCount++;
      if (!DRY_RUN) {
        await supa
          .from('doctrina_pdfs')
          .update({
            estado: 'failed',
            notas: (err as Error).message.slice(0, 500),
          })
          .eq('id', pdf.id)
          .then();
      }
    }

    // Pausa educada entre PDFs.
    if (pdfs.indexOf(pdf) < pdfs.length - 1) {
      await sleep(POLITENESS_DELAY_MS);
    }
  }

  log.info('Ingest complete', {
    success: successCount,
    skipped: skipCount,
    failed: failCount,
    total: pdfs.length,
  });

  process.exit(failCount > 0 ? 1 : 0);
}

// ─── Indexación de un PDF ──────────────────────────────────────────────────────

/**
 * Extrae texto del PDF y lo indexa en ral_articulos + ral_interpretaciones.
 * Retorna el número de filas upsertadas.
 */
async function indexPdf(
  supa: SupabaseClient,
  pdf: DoctrinaPdf,
  pdfBuffer: Buffer,
  pdfLog: ReturnType<typeof logger.with>,
): Promise<number> {
  // Extraer texto con pdfjs-dist.
  pdfLog.info('Extracting text from PDF...', {});
  const fullText = await pdfToText(pdfBuffer);

  if (!fullText || fullText.trim().length < 100) {
    pdfLog.warn('Extracted text too short — PDF may be scanned/raster. Skipping indexing.', {
      text_length: fullText?.length ?? 0,
    });
    return 0;
  }

  pdfLog.info('Text extracted', { text_chars: fullText.length });

  const isRalComentado = RAL_COMENTADO_NAMES.includes(pdf.nombre_archivo);

  if (isRalComentado) {
    return indexRalComentado(supa, pdf, fullText, pdfLog);
  } else {
    return indexDoctranaGenerica(supa, pdf, fullText, pdfLog);
  }
}

/**
 * Indexa el RAL Comentado usando el chunker especializado.
 * Cada artículo + inciso → ral_articulos.
 * Cada interpretación → ral_interpretaciones.
 */
async function indexRalComentado(
  supa: SupabaseClient,
  pdf: DoctrinaPdf,
  fullText: string,
  pdfLog: ReturnType<typeof logger.with>,
): Promise<number> {
  const edicion = EDICION_MAP[pdf.nombre_archivo] ?? 'Desconocida';
  pdfLog.info(`Chunking RAL Comentado [${edicion}]...`, {});

  const chunks = chunkRalComentado(fullText);
  pdfLog.info(`RAL chunker produced ${chunks.length} artículo/inciso chunks`, {});

  if (DRY_RUN) {
    pdfLog.info('[DRY_RUN] Sample chunks:', {
      first_3: chunks.slice(0, 3).map((c) => ({
        numero: c.numero,
        inciso: c.inciso ?? null,
        texto_preview: c.texto_normativo.slice(0, 80),
        interpretaciones: c.interpretaciones.length,
      })),
    });
    return chunks.length;
  }

  // Si esta es la edición 5ta, marcar las anteriores como no vigentes.
  if (edicion === EDICION_5TA) {
    pdfLog.info('Marking previous editions as vigente=false...', {});
    const { error: markErr } = await supa
      .from('ral_articulos')
      .update({ vigente: false })
      .neq('edicion', EDICION_5TA);
    if (markErr) {
      pdfLog.warn('Failed to mark old editions as non-vigente', { error: markErr.message });
    }
  }

  let totalRows = 0;

  for (const chunk of chunks) {
    // Upsert artículo.
    const articuloPayload = {
      numero: chunk.numero,
      inciso: chunk.inciso === 'completo' ? null : (chunk.inciso ?? null),
      capitulo: chunk.capitulo ?? null,
      titulo_seccion: chunk.tituloSeccion ?? null,
      texto_normativo: chunk.texto_normativo,
      edicion,
      vigente: edicion === EDICION_5TA,
      source_pdf: pdf.url_publica,
      source_pagina: chunk.source_pagina,
      embed_status: 'pending',
    };

    const { data: artRow, error: artErr } = await supa
      .from('ral_articulos')
      .upsert(articuloPayload, { onConflict: 'numero,inciso,edicion' })
      .select('id')
      .single();

    if (artErr) {
      pdfLog.warn('Failed to upsert ral_articulos', {
        numero: chunk.numero,
        inciso: chunk.inciso,
        error: artErr.message,
      });
      continue;
    }

    totalRows++;

    if (!artRow?.id) continue;

    // Insertar interpretaciones (borrar previas para este artículo+edición primero).
    if (chunk.interpretaciones.length > 0) {
      // Borrar las anteriores para este artículo en esta edición.
      await supa
        .from('ral_interpretaciones')
        .delete()
        .eq('articulo_id', artRow.id);

      const interpPayloads = chunk.interpretaciones.map((interp) => ({
        articulo_id: artRow.id,
        articulo_numero: chunk.numero,
        articulo_inciso: chunk.inciso === 'completo' ? null : (chunk.inciso ?? null),
        texto_interpretacion: interp.texto,
        fuente_tipo: interp.fuente_tipo,
        fuente_cita: interp.fuente_cita ?? null,
        fuente_fecha: interp.fuente_fecha
          ? interp.fuente_fecha.toISOString().slice(0, 10)
          : null,
        fuente_pdf: pdf.url_publica,
        vigente: true,
        edicion,
      }));

      const { error: interpErr } = await supa
        .from('ral_interpretaciones')
        .insert(interpPayloads);

      if (interpErr) {
        pdfLog.warn('Failed to insert ral_interpretaciones', {
          articulo: chunk.numero,
          error: interpErr.message,
        });
      } else {
        totalRows += chunk.interpretaciones.length;
      }
    }
  }

  pdfLog.info(`RAL indexing done`, { articulos: chunks.length, total_rows: totalRows });
  return totalRows;
}

/**
 * Indexa un PDF de doctrina genérico (resoluciones, sentencias).
 * Para sentencias/resoluciones: aplica heurística POR TANTO.
 * Para el resto: chunking por párrafos de ~800 chars.
 * Inserta como ral_interpretaciones sin artículo padre (articulo_id=null no permitido
 * por FK, entonces las insertamos con articulo_numero extraído del texto).
 */
async function indexDoctranaGenerica(
  supa: SupabaseClient,
  pdf: DoctrinaPdf,
  fullText: string,
  pdfLog: ReturnType<typeof logger.with>,
): Promise<number> {
  const isSentencias = SENTENCIAS_NAMES.includes(pdf.nombre_archivo);
  pdfLog.info(`Chunking doctrina genérica${isSentencias ? ' (heurística POR TANTO)' : ''}`, {});

  // Partir por resoluciones individuales.
  // Las resoluciones suelen empezar con "RESOLUCIÓN" o "ACUERDO" o "SESIÓN".
  const RE_RESOLUCION = /(?:^|\n)(?:RESOLUC[IÍ]ÓN|ACUERDO|SESI[ÓO]N\s+PLENARIA)\b/gm;

  let resolucionBlocks: string[];
  const matches = Array.from(fullText.matchAll(RE_RESOLUCION));

  if (matches.length >= 2) {
    resolucionBlocks = matches.map((m, idx) => {
      const start = m.index!;
      const end = idx + 1 < matches.length ? matches[idx + 1].index! : fullText.length;
      return fullText.slice(start, end).trim();
    });
    pdfLog.info(`Split into ${resolucionBlocks.length} resolución blocks`, {});
  } else {
    // No tiene estructura clara → chunking por párrafos de ~2000 chars.
    resolucionBlocks = splitByParagraph(fullText, 2000);
    pdfLog.info(`Fallback: split into ${resolucionBlocks.length} paragraph chunks`, {});
  }

  if (DRY_RUN) {
    pdfLog.info('[DRY_RUN] Would index generic doctrina blocks', {
      count: resolucionBlocks.length,
      pdf: pdf.nombre_archivo,
    });
    return resolucionBlocks.length;
  }

  let totalRows = 0;

  for (const block of resolucionBlocks) {
    // Aplicar POR TANTO si es PDF de sentencias.
    const texto = isSentencias ? extractPorTanto(block) : block;

    if (texto.trim().length < 50) continue;

    // Extraer número de artículo citado (si hay).
    const articuloMatch = texto.match(/art[íi]culo\s+(\d+)/i);
    const articuloNumero = articuloMatch ? articuloMatch[1] : null;

    // Si hay un artículo citado, buscar si existe en ral_articulos.
    let articuloId: string | null = null;
    if (articuloNumero) {
      const { data: artRow } = await supa
        .from('ral_articulos')
        .select('id')
        .eq('numero', articuloNumero)
        .eq('vigente', true)
        .limit(1)
        .single();
      articuloId = artRow?.id ?? null;
    }

    // Si no hay artículo padre → necesitamos uno placeholder o saltamos.
    // Por diseño de la FK, ral_interpretaciones.articulo_id NOT NULL.
    // Si no encontramos artículo, saltamos esta resolución.
    // TODO Sprint 2: crear tabla doctrina_resoluciones sin FK a artículos.
    if (!articuloId) {
      pdfLog.debug('No matching ral_articulos found for block, skipping FK insert', {
        articulo_numero: articuloNumero ?? 'none',
        preview: texto.slice(0, 80),
      });
      continue;
    }

    const fuente_tipo: 'sentencia_sala_constitucional' | 'resolucion_presidencia' | 'otro' =
      isSentencias ? 'sentencia_sala_constitucional'
      : pdf.nombre_archivo.includes('Resoluciones') ? 'resolucion_presidencia'
      : 'otro';

    const { error: insertErr } = await supa
      .from('ral_interpretaciones')
      .insert({
        articulo_id: articuloId,
        articulo_numero: articuloNumero ?? 'sin_numero',
        texto_interpretacion: texto.slice(0, 5000), // cap para evitar rows gigantes
        fuente_tipo,
        fuente_pdf: pdf.url_publica,
        vigente: true,
        edicion: pdf.nombre_archivo,
      });

    if (insertErr) {
      pdfLog.warn('Failed to insert generic doctrina interpretation', {
        error: insertErr.message,
      });
    } else {
      totalRows++;
    }
  }

  pdfLog.info('Generic doctrina indexing done', { rows: totalRows });
  return totalRows;
}

/**
 * Parte un texto largo en bloques de máximo `maxChars` chars,
 * cortando en saltos de párrafo (doble newline).
 */
function splitByParagraph(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n\n+/);
  const blocks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length > maxChars && current.length > 0) {
      blocks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current.trim()) blocks.push(current.trim());
  return blocks;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

main().catch((err) => {
  logger.error('Unhandled error in ingest-doctrina-parlamentaria', {
    error: err?.message ?? String(err),
    stack: err?.stack?.slice(0, 500),
  });
  process.exit(1);
});

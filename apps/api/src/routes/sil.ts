/**
 * SIL browse — manual research surface over the indexed corpus.
 *
 * Different intent from /api/expedientes/:numero (single-doc view) and
 * from the chat tools (semantic search). This is for the user who wants
 * to scan the catalog by metadata: "expedientes de Hacendarios en
 * 2024", "todo lo que entró este mes con dictamen", etc.
 *
 * Default scope is INTENTIONALLY narrow: only expedientes for which
 * we have ≥1 document indexed in `sil_documentos`. The huge metadata-
 * only tail (~17.7k pre-2022 expedientes) is gated behind an explicit
 * `include_metadata=1` flag so the user has to opt into the
 * "broader DB browse, hotlinks to SIL oficial" mode. Default UX: only
 * stuff CL2 can actually read.
 *
 * Auth: same JWT gate as the rest of /api. Tighten with role checks
 * when we open up multi-tenant.
 */
import { Router, type Request, type Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getUserIdFromRequest } from '../services/auth.js';

export const silRouter = Router();

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return null;
  }
  return userId;
}

// ─── Coverage stats (drives the hero strip) ──────────────────────────
//
// These are the "honest numbers" that head the SIL page so the user
// reads the scope at a glance: what we own vs what's queued vs what's
// outside our coverage.
silRouter.get('/coverage', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  try {
    const s = supa();
    const [
      { count: total },
      { count: indexed },
      { count: active2226 },
      { count: pre1997 },
      { count: legacy97_22 },
    ] = await Promise.all([
      s.from('sil_expedientes').select('id', { count: 'exact', head: true }),
      // Total count of rows in sil_documentos (used as `indexed_doc_count`).
      // Distinct expediente count is computed below via pagination —
      // PostgREST's `head:true` doesn't support DISTINCT and `.limit()` is
      // capped server-side at 1000 rows by default, so we have to walk.
      s.from('sil_documentos').select('expediente_id', { count: 'exact', head: true }),
      s.from('sil_expedientes').select('id', { count: 'exact', head: true }).gte('id', 22000),
      s.from('sil_expedientes').select('id', { count: 'exact', head: true }).lt('id', 12900),
      s.from('sil_expedientes').select('id', { count: 'exact', head: true }).gte('id', 12900).lt('id', 22000),
    ]);

    // True distinct expedientes-with-docs count.
    //
    // Bug history: this used to be `.limit(20_000)` followed by a JS dedup,
    // assuming the table stayed small (<1k unique expedientes). After the
    // bulk DOCX ingest of 2026-04-27 the table crossed 13k rows and PostgREST's
    // server-side default page cap (1000) silently truncated the result —
    // the catálogo started showing 241 instead of the real number.
    //
    // Fix: paginate in 1000-row windows until we exhaust the table. The set
    // we accumulate is just integers so memory is bounded (~80kB at 10k uniques).
    const indexedSet = new Set<number>();
    const PAGE = 1000;
    const MAX_PAGES = 50; // safety cap: 50k rows = enough for years of growth
    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE;
      const to = from + PAGE - 1;
      const { data: chunk, error: pageErr } = await s
        .from('sil_documentos')
        .select('expediente_id')
        .range(from, to);
      if (pageErr) throw new Error(pageErr.message);
      if (!chunk || chunk.length === 0) break;
      for (const r of chunk) indexedSet.add(r.expediente_id as number);
      if (chunk.length < PAGE) break; // last page
    }
    const indexedDistinct = indexedSet.size;

    res.json({
      ok: true,
      total: total ?? 0,
      indexed_count: indexedDistinct,
      indexed_doc_count: indexed ?? 0,
      buckets: {
        active_legislature: active2226 ?? 0,
        pending_in_active: Math.max(0, (active2226 ?? 0) - indexedDistinct),
        legacy_1997_2022: legacy97_22 ?? 0,
        historical_pre_1997: pre1997 ?? 0,
      },
    });
  } catch (err) {
    req.log?.warn('sil/coverage failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Facets for filter dropdowns ─────────────────────────────────────
//
// Distinct values for comisión / estado / tipo derived from the table.
// We cache via supabase's underlying postgrest GET cache headers if
// they're configured; otherwise this is a cheap-enough query at the
// scale we have.
silRouter.get('/facets', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  try {
    const s = supa();
    // PostgREST doesn't support distinct natively, so we pull and dedupe.
    // The columns are short text — the payload is fine even at 21k rows.
    const [{ data: comRows }, { data: estRows }, { data: tipoRows }] = await Promise.all([
      s.from('sil_expedientes').select('comision').not('comision', 'is', null).limit(25_000),
      s.from('sil_expedientes').select('estado').not('estado', 'is', null).limit(25_000),
      s.from('sil_expedientes').select('tipo').not('tipo', 'is', null).limit(25_000),
    ]);

    const dedupe = (rows: Array<Record<string, unknown>> | null, key: string): string[] => {
      const set = new Set<string>();
      for (const r of rows ?? []) {
        const v = (r[key] as string | null | undefined)?.trim();
        if (v) set.add(v);
      }
      return Array.from(set).sort((a, b) => a.localeCompare(b, 'es'));
    };

    res.json({
      ok: true,
      comisiones: dedupe(comRows, 'comision'),
      estados: dedupe(estRows, 'estado'),
      tipos: dedupe(tipoRows, 'tipo'),
      // Year facets — derive from id ranges since fecha_presentacion has
      // gaps. Using id is a stable proxy for chronology in the SIL.
      years: [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018],
    });
  } catch (err) {
    req.log?.warn('sil/facets failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Expediente listing ──────────────────────────────────────────────
//
// Paginated list, filterable, with `documentos_count` joined in so the
// UI can render the indexed/metadata-only badge per card without an
// extra round-trip.
silRouter.get('/expedientes', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  const includeMetadata = req.query.include_metadata === '1';
  const comision = typeof req.query.comision === 'string' ? req.query.comision : null;
  const estado = typeof req.query.estado === 'string' ? req.query.estado : null;
  const tipo = typeof req.query.tipo === 'string' ? req.query.tipo : null;
  const year = req.query.year ? Number(req.query.year) : null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  try {
    const s = supa();

    // Step 1 — get the universe of indexed expediente_ids when needed.
    // Default mode (`include_metadata=false`) restricts the listing to
    // these ids; if true, we don't restrict but tag each row with its
    // indexed status.
    const { data: docRows } = await s
      .from('sil_documentos')
      .select('expediente_id, tipo')
      .limit(20_000);

    const docCountByExp = new Map<number, number>();
    const tiposByExp = new Map<number, Set<string>>();
    for (const r of docRows ?? []) {
      const id = r.expediente_id as number;
      docCountByExp.set(id, (docCountByExp.get(id) ?? 0) + 1);
      const set = tiposByExp.get(id) ?? new Set<string>();
      if (typeof r.tipo === 'string') set.add(r.tipo);
      tiposByExp.set(id, set);
    }
    const indexedIds = Array.from(docCountByExp.keys());

    // Step 2 — query sil_expedientes with the active filters. Apply
    // pagination on the DB side so we don't pull 21k into memory.
    let q1 = s
      .from('sil_expedientes')
      .select(
        'id, numero, titulo, comision, estado, tipo, fecha_presentacion, proponente, url_detalle',
        { count: 'exact' },
      );

    if (!includeMetadata) {
      // Default — restrict to indexed-only set.
      if (indexedIds.length === 0) {
        // Nothing indexed yet — return empty. The UI surfaces a clear
        // CTA pointing the user to the metadata-only mode.
        res.json({
          ok: true,
          total: 0,
          items: [],
          include_metadata: false,
        });
        return;
      }
      q1 = q1.in('id', indexedIds);
    }

    if (comision) q1 = q1.eq('comision', comision);
    if (estado) q1 = q1.eq('estado', estado);
    if (tipo) q1 = q1.eq('tipo', tipo);
    if (year) {
      const fromIso = `${year}-01-01`;
      const toIso = `${year}-12-31`;
      q1 = q1.gte('fecha_presentacion', fromIso).lte('fecha_presentacion', toIso);
    }
    if (q) {
      // Numero match (substring) OR title match. PostgREST or-clause
      // with ilike. Numero is a string column with the dotted format
      // ("23.456"), so substring works for partial typing.
      const escaped = q.replace(/[%_]/g, (m) => `\\${m}`);
      q1 = q1.or(`numero.ilike.%${escaped}%,titulo.ilike.%${escaped}%`);
    }

    q1 = q1
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data: rows, count, error } = await q1;
    if (error) throw new Error(error.message);

    const items = (rows ?? []).map((r) => {
      const id = r.id as number;
      const docsCount = docCountByExp.get(id) ?? 0;
      const tipos = Array.from(tiposByExp.get(id) ?? new Set<string>());
      return {
        id,
        numero: r.numero as string,
        titulo: r.titulo as string | null,
        comision: r.comision as string | null,
        estado: r.estado as string | null,
        tipo: r.tipo as string | null,
        fecha_presentacion: r.fecha_presentacion as string | null,
        proponente: r.proponente as string | null,
        url_detalle: r.url_detalle as string | null,
        documentos_count: docsCount,
        documentos_tipos: tipos,
        // 'indexed' = at least one doc is in our local store
        // 'metadata' = we know it exists but haven't downloaded
        status: docsCount > 0 ? 'indexed' : 'metadata',
      };
    });

    res.json({
      ok: true,
      total: count ?? 0,
      items,
      include_metadata: includeMetadata,
    });
  } catch (err) {
    req.log?.warn('sil/expedientes failed', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

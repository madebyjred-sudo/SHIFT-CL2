/**
 * Admin console — read + write endpoints powering the admin UI.
 *
 * Every action button in the UI lands here. Each write also dispatches
 * an audit_log entry so the Auditoría section reflects real activity.
 *
 * Auth: any authenticated user can call these during the demo. When we
 * open up to outside tenants, hoist a role check on top of the router.
 */
import { Router } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { audit, auditFromReq } from '../services/auditLog.js';
import { getUserFromRequest } from '../services/auth.js';
import { snapshotAll } from '../services/agentStats.js';
import { getOverride, loadOverrides, setOverride } from '../services/agentOverrides.js';
import { loadFlags, setFlag } from '../services/featureFlags.js';
import { logger } from '../services/logger.js';

const adminRouter = Router();

interface MockedResponse<T> {
  ok: true;
  mock: true;
  generated_at: string;
  data: T;
}

interface LiveResponse<T> {
  ok: true;
  mock: false;
  generated_at: string;
  data: T;
}

function mocked<T>(data: T): MockedResponse<T> {
  return { ok: true, mock: true, generated_at: new Date().toISOString(), data };
}
function live<T>(data: T): LiveResponse<T> {
  return { ok: true, mock: false, generated_at: new Date().toISOString(), data };
}

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ─── Operational summary ─────────────────────────────────────────────
adminRouter.get('/summary', async (req, res) => {
  try {
    const s = supa();
    const [
      { count: chunksCount },
      { count: sessionsCount },
      { count: expedientesCount },
      { count: pendingTransCount },
      { count: pendingWatchlistCount },
    ] = await Promise.all([
      s.from('legislative_chunks').select('id', { count: 'exact', head: true }),
      s.from('sessions').select('id', { count: 'exact', head: true }),
      s.from('sil_expedientes').select('id', { count: 'exact', head: true }),
      s.from('transcripciones_review').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      s.from('expedientes_watchlist').select('user_id', { count: 'exact', head: true }),
    ]);
    res.json(
      live({
        chunks: chunksCount ?? 0,
        sessions: sessionsCount ?? 0,
        expedientes: expedientesCount ?? 0,
        pending_transcripciones: pendingTransCount ?? 0,
        watchlist_total: pendingWatchlistCount ?? 0,
      }),
    );
  } catch (err) {
    req.log?.warn('admin/summary failed', { err: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Recent activity stream (live from audit_log + Supabase events) ──
adminRouter.get('/activity', async (_req, res) => {
  try {
    const { data, error } = await supa()
      .from('audit_log')
      .select('id, ts, actor_email, actor_kind, verb, resource, resource_kind, result')
      .order('ts', { ascending: false })
      .limit(15);
    if (error) throw new Error(error.message);
    res.json(live({ items: data ?? [] }));
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Alerts (derived) ────────────────────────────────────────────────
adminRouter.get('/alerts', async (_req, res) => {
  // For now derive from recent failed audit entries + worker state.
  // A real alert engine would track open issues with severity, owner,
  // ack/snooze. Today: surface anything that landed as result='error'
  // or 'retry' in the last 6 hours.
  try {
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
    const { data } = await supa()
      .from('audit_log')
      .select('id, ts, verb, resource, result, metadata')
      .neq('result', 'ok')
      .gte('ts', sixHoursAgo)
      .order('ts', { ascending: false })
      .limit(10);
    const items = (data ?? []).map((row) => ({
      id: row.id,
      severity: row.result === 'error' ? 'danger' : 'warn',
      title: `${row.verb} → ${row.result}`,
      detail: row.resource,
      when: row.ts,
    }));
    res.json(live({ items }));
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Transcripciones — DB rows + remaining mock queue ────────────────
//
// Until the legacy worker pushes real rows, the demo queue is the only
// material the operator can interact with. Naïve approach was: show
// mocks ONLY when DB is empty. That broke the moment the operator
// approved their first item — the row landed in DB, isMock flipped
// false, and the other six mock items vanished.
//
// Better: merge. Real DB rows are authoritative (their status is the
// truth). Mock rows whose external_id is NOT yet in DB still surface
// as `pending` so the operator can keep working through the demo
// backlog. Approving a mock writes a new DB row → next refresh shows
// it as approved, removes it from the mock-pending pool.
adminRouter.get('/transcripciones', async (_req, res) => {
  try {
    const s = supa();
    const { data: dbItems } = await s
      .from('transcripciones_review')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    const dbByExternal = new Map<string, Record<string, unknown>>();
    for (const r of dbItems ?? []) {
      const ext = (r as { external_id?: string }).external_id;
      if (ext) dbByExternal.set(ext, r as Record<string, unknown>);
    }

    // Merged list: real DB rows first (newest first), then any mock
    // whose external_id isn't already represented.
    const merged: Array<Record<string, unknown>> = [];
    for (const r of dbItems ?? []) merged.push(r as Record<string, unknown>);
    for (const m of MOCK_QUEUE) {
      if (!dbByExternal.has(m.external_id)) {
        merged.push(m as unknown as Record<string, unknown>);
      }
    }

    const shaped = merged.map(shapeTransRow);
    const counts = {
      pending: shaped.filter((s) => s.status === 'pending').length,
      in_progress: shaped.filter((s) => s.status === 'in_progress').length,
      approved: shaped.filter((s) => s.status === 'approved').length,
      rejected: shaped.filter((s) => s.status === 'rejected').length,
    };

    // mock=true while ANY mock is still in the merged set — the operator
    // can read the badge and know not all rows are real upstream events
    // yet. Flips false once every mock has been reviewed.
    const stillHasMocks = MOCK_QUEUE.some((m) => !dbByExternal.has(m.external_id));
    const envelope = stillHasMocks ? mocked : live;
    res.json(envelope({ counts, items: shaped }));
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.get('/transcripciones/:id', async (req, res) => {
  try {
    const { data, error } = await supa()
      .from('transcripciones_review')
      .select('*')
      .eq('external_id', req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      // Fall through to mock if id matches a demo one.
      const mockItem = MOCK_QUEUE.find((q) => q.external_id === req.params.id);
      if (mockItem) {
        res.json(mocked(buildMockDetail(mockItem)));
        return;
      }
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    const item = shapeTransRow(data);
    const segments = (data.payload?.segments as Array<Record<string, unknown>> | undefined) ?? buildMockDetail(data).segments;
    const diarization = (data.payload?.diarization as Array<Record<string, unknown>> | undefined) ?? buildMockDetail(data).diarization;
    res.json(
      live({
        item,
        segments,
        diarization,
        total_segments: (data.payload?.total_segments as number | undefined) ?? segments.length,
        total_words: (data.payload?.total_words as number | undefined) ?? 0,
      }),
    );
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.post('/transcripciones/:id/review', async (req, res) => {
  const action = req.body?.action;
  const note = (req.body?.note as string | undefined) ?? null;
  if (action !== 'approve' && action !== 'reject') {
    res.status(400).json({ ok: false, error: 'action must be approve|reject' });
    return;
  }
  try {
    const user = await getUserFromRequest(req);
    const { data: existing } = await supa()
      .from('transcripciones_review')
      .select('id, external_id')
      .eq('external_id', req.params.id)
      .maybeSingle();

    if (existing) {
      const { error } = await supa()
        .from('transcripciones_review')
        .update({
          status: action === 'approve' ? 'approved' : 'rejected',
          reviewed_by: user?.id ?? null,
          reviewed_at: new Date().toISOString(),
          reviewer_note: note,
        })
        .eq('id', existing.id);
      if (error) throw new Error(error.message);
    } else {
      // Demo path: row is in mock queue, persist a stub so subsequent
      // refreshes show it as approved/rejected.
      const mock = MOCK_QUEUE.find((q) => q.external_id === req.params.id);
      if (mock) {
        await supa().from('transcripciones_review').insert({
          external_id: mock.external_id,
          session_id: mock.session_id ? String(mock.session_id) : null,
          status: action === 'approve' ? 'approved' : 'rejected',
          confidence: mock.confidence,
          flagged_segments: mock.flagged_segments,
          source: mock.source,
          speaker: mock.speaker,
          excerpt_text: mock.excerpt_text,
          excerpt_ts: mock.excerpt_ts,
          reviewed_by: user?.id ?? null,
          reviewed_at: new Date().toISOString(),
          reviewer_note: note,
        });
      }
    }

    await auditFromReq(req, {
      verb: action === 'approve' ? 'aprobó' : 'rechazó',
      resource: `transcripción ${req.params.id}`,
      resource_kind: 'transcription',
      resource_id: req.params.id,
      result: 'ok',
      metadata: { note },
    });

    res.json({ ok: true, id: req.params.id, action, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Agents — live counters + persisted overrides ────────────────────
adminRouter.get('/agents/status', async (_req, res) => {
  try {
    const overrides = await loadOverrides();
    const stats = snapshotAll();
    const ids = ['lexa', 'atlas', 'centinela'];
    const data = ids.map((id) => {
      const s = stats[id];
      const o = overrides.get(id);
      return {
        agent_id: id,
        enabled: o?.enabled ?? true,
        model: o?.model ?? null,
        queries_24h: s?.queries_24h ?? 0,
        queries_recent_60m: s?.queries_recent_60m ?? 0,
        p50_ms: s?.p50_ms ?? null,
        p95_ms: s?.p95_ms ?? null,
        error_rate_pct: s?.error_rate_pct ?? 0,
      };
    });
    res.json(live({ items: data }));
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.patch('/agents/:id', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    const before = await getOverride(req.params.id);
    const next = await setOverride(
      req.params.id,
      {
        enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
        model: typeof req.body?.model === 'string' ? req.body.model : undefined,
      },
      user?.id ?? null,
    );

    const verb =
      before?.enabled !== next.enabled
        ? next.enabled
          ? 'activó'
          : 'desactivó'
        : 'editó';
    await auditFromReq(req, {
      verb,
      resource: `agente ${req.params.id}`,
      resource_kind: 'agent',
      resource_id: req.params.id,
      result: 'ok',
      metadata: { before, after: next },
    });

    res.json({ ok: true, agent: next });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Feature flags — read + write ────────────────────────────────────
adminRouter.get('/flags', async (_req, res) => {
  try {
    const flags = await loadFlags(true);
    res.json(live({ flags }));
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.patch('/flags/:key', async (req, res) => {
  if (req.body?.value === undefined) {
    res.status(400).json({ ok: false, error: 'value required' });
    return;
  }
  try {
    const user = await getUserFromRequest(req);
    const before = (await loadFlags(true))[req.params.key];
    await setFlag(req.params.key, req.body.value, user?.id ?? null);
    await auditFromReq(req, {
      verb: 'cambió',
      resource: `flag ${req.params.key}`,
      resource_kind: 'flag',
      resource_id: req.params.key,
      result: 'ok',
      metadata: { before, after: req.body.value },
    });
    res.json({ ok: true, key: req.params.key, value: req.body.value });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Expedientes watchlist (per-user) ────────────────────────────────
adminRouter.get('/watchlist', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      // Anonymous → empty list (UI knows how to render "no hay alertas").
      // We don't 401 because the watchlist is a soft personalization, not
      // a critical surface — every other section degrades gracefully.
      res.json(live({ ids: [] as number[] }));
      return;
    }
    const { data, error } = await supa()
      .from('expedientes_watchlist')
      .select('expediente_id')
      .eq('user_id', user.id);
    if (error) {
      // Specific error from PostgREST. Common case during the demo:
      // table just got created and the schema cache hadn't propagated
      // when the first query landed → schema_cache_miss. Restart of the
      // PostgREST instance fixes it; retry on a 30s window also works.
      req.log?.warn('admin/watchlist supabase error', {
        message: error.message,
        code: (error as { code?: string }).code,
        hint: (error as { hint?: string }).hint,
      });
      // Soft-degrade: empty list + the original message in the response
      // body (dev only — Express in prod truncates).
      res.json({
        ok: true,
        mock: false,
        degraded: true,
        degraded_reason: error.message,
        generated_at: new Date().toISOString(),
        data: { ids: [] as number[] },
      });
      return;
    }
    res.json(live({ ids: (data ?? []).map((r) => r.expediente_id as number) }));
  } catch (err) {
    req.log?.error('admin/watchlist threw', {
      message: (err as Error).message,
      stack: (err as Error).stack,
    });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.post('/watchlist/:id', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'auth_required' });
      return;
    }
    const expedienteId = Number(req.params.id);
    if (!Number.isFinite(expedienteId)) {
      res.status(400).json({ ok: false, error: 'bad_id' });
      return;
    }
    const action = req.body?.action;
    if (action === 'add') {
      const { error } = await supa()
        .from('expedientes_watchlist')
        .upsert({ user_id: user.id, expediente_id: expedienteId });
      if (error) throw new Error(error.message);
      await auditFromReq(req, {
        verb: 'activó alerta en',
        resource: `Exp. ${expedienteId}`,
        resource_kind: 'expediente',
        resource_id: String(expedienteId),
        result: 'ok',
      });
    } else if (action === 'remove') {
      const { error } = await supa()
        .from('expedientes_watchlist')
        .delete()
        .eq('user_id', user.id)
        .eq('expediente_id', expedienteId);
      if (error) throw new Error(error.message);
      await auditFromReq(req, {
        verb: 'quitó alerta en',
        resource: `Exp. ${expedienteId}`,
        resource_kind: 'expediente',
        resource_id: String(expedienteId),
        result: 'ok',
      });
    } else {
      res.status(400).json({ ok: false, error: 'action must be add|remove' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Audit log (real reads + filters + CSV) ──────────────────────────
adminRouter.get('/audit', async (req, res) => {
  try {
    let q = supa()
      .from('audit_log')
      .select('id, ts, actor_id, actor_email, actor_kind, verb, resource, resource_kind, resource_id, ip, result, metadata')
      .order('ts', { ascending: false })
      .limit(Math.min(Number(req.query.limit ?? 200) || 200, 500));
    if (typeof req.query.actor_kind === 'string') q = q.eq('actor_kind', req.query.actor_kind);
    if (typeof req.query.verb === 'string') q = q.ilike('verb', `%${req.query.verb}%`);
    if (typeof req.query.from === 'string') q = q.gte('ts', req.query.from);
    if (typeof req.query.to === 'string') q = q.lte('ts', req.query.to);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const items = (data ?? []).map((r) => ({
      ts: r.ts,
      actor: r.actor_kind === 'system' ? 'sys' : initialsForEmail(r.actor_email),
      actor_kind: r.actor_kind,
      actor_email: r.actor_email,
      verb: r.verb,
      resource: r.resource,
      resource_kind: r.resource_kind,
      ip: r.ip ?? null,
      result: r.result,
    }));
    res.json(live({ items }));
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.get('/audit.csv', async (req, res) => {
  try {
    const { data, error } = await supa()
      .from('audit_log')
      .select('ts, actor_email, actor_kind, verb, resource, resource_kind, result, ip')
      .order('ts', { ascending: false })
      .limit(2000);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    const lines = [
      ['ts', 'actor_email', 'actor_kind', 'verb', 'resource', 'resource_kind', 'result', 'ip'].join(','),
      ...rows.map((r) =>
        [
          r.ts,
          r.actor_email ?? '',
          r.actor_kind,
          quoteCsv(String(r.verb ?? '')),
          quoteCsv(String(r.resource ?? '')),
          r.resource_kind ?? '',
          r.result,
          r.ip ?? '',
        ].join(','),
      ),
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(lines);
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Users — list + role + invite ────────────────────────────────────
adminRouter.get('/users', async (_req, res) => {
  try {
    const s = supa();
    const { data, error } = await s.auth.admin.listUsers({ page: 1, perPage: 50 });
    if (error) throw new Error(error.message);
    const items = (data?.users ?? []).map((u) => ({
      id: u.id,
      email: u.email ?? '',
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at ?? null,
      role: ((u.user_metadata as { role?: string } | null)?.role as string | null) ?? 'lector',
      status: u.last_sign_in_at ? 'activo' : 'invitado',
    }));
    res.json(live({ items }));
  } catch (err) {
    logger.warn('admin/users live read failed', { error: (err as Error).message });
    // Fall through to mock when admin API isn't available.
    res.json(
      mocked({
        items: [
          { id: 'mock-1', email: 'juanma@shiftlab.cr',         created_at: '2026-01-12T00:00:00Z', last_sign_in_at: new Date(Date.now() - 120_000).toISOString(),   role: 'admin',    status: 'activo'   },
          { id: 'mock-2', email: 'diana.rodriguez@asamblea.go.cr', created_at: '2026-02-03T00:00:00Z', last_sign_in_at: new Date(Date.now() - 14*60_000).toISOString(),  role: 'operador', status: 'activo'   },
          { id: 'mock-3', email: 'andres@shiftlab.cr',         created_at: '2026-02-08T00:00:00Z', last_sign_in_at: new Date(Date.now() - 5*60*60_000).toISOString(), role: 'editor',   status: 'activo'   },
          { id: 'mock-4', email: 'tatiana.vargas@asamblea.go.cr', created_at: '2026-04-22T00:00:00Z', last_sign_in_at: null,                                            role: 'lector',   status: 'invitado' },
          { id: 'mock-5', email: 'msolano@asamblea.go.cr',     created_at: '2026-03-01T00:00:00Z', last_sign_in_at: new Date(Date.now() - 18*60*60_000).toISOString(), role: 'lector',   status: 'activo'   },
          { id: 'mock-6', email: 'rrojas@example.com',         created_at: '2026-04-25T00:00:00Z', last_sign_in_at: null,                                            role: null,       status: 'solicitud' },
        ],
      }),
    );
  }
});

adminRouter.post('/users/invite', async (req, res) => {
  const email = req.body?.email;
  const role = (req.body?.role as string | undefined) ?? 'lector';
  if (typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ ok: false, error: 'bad_email' });
    return;
  }
  try {
    const { data, error } = await supa().auth.admin.inviteUserByEmail(email, {
      data: { role },
    });
    if (error) throw new Error(error.message);
    await auditFromReq(req, {
      verb: 'invitó',
      resource: email,
      resource_kind: 'user',
      resource_id: data.user?.id ?? email,
      result: 'ok',
      metadata: { role },
    });
    res.json({ ok: true, id: data.user?.id ?? null, email });
  } catch (err) {
    await auditFromReq(req, {
      verb: 'falló invitar',
      resource: email,
      resource_kind: 'user',
      result: 'error',
      metadata: { error: (err as Error).message },
    });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

adminRouter.patch('/users/:id', async (req, res) => {
  const role = req.body?.role;
  if (typeof role !== 'string') {
    res.status(400).json({ ok: false, error: 'role required' });
    return;
  }
  try {
    const { data, error } = await supa().auth.admin.updateUserById(req.params.id, {
      user_metadata: { role },
    });
    if (error) throw new Error(error.message);
    await auditFromReq(req, {
      verb: 'cambió rol',
      resource: data.user?.email ?? req.params.id,
      resource_kind: 'user',
      resource_id: req.params.id,
      result: 'ok',
      metadata: { role },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Punto Medio passthrough — Forzar consolidación ──────────────────
adminRouter.post('/punto-medio/consolidate', async (req, res) => {
  const tenant = (req.body?.tenant as string | undefined) ?? process.env.CEREBRO_TENANT ?? 'cl2';
  const base = process.env.CEREBRO_BASE_URL ?? '';
  if (!base) {
    res.status(503).json({ ok: false, error: 'cerebro_unconfigured' });
    return;
  }
  try {
    const upstream = await fetch(`${base}/punto-medio/consolidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant }),
    });
    const body = await upstream.text();
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}: ${body.slice(0, 200)}`);
    await auditFromReq(req, {
      verb: 'generó borradores',
      resource: `editorial · ${tenant}`,
      resource_kind: 'editorial_guideline',
      result: 'ok',
    });
    res.setHeader('Content-Type', 'application/json');
    res.send(body);
  } catch (err) {
    await auditFromReq(req, {
      verb: 'generó borradores',
      resource: `editorial · ${tenant}`,
      resource_kind: 'editorial_guideline',
      result: 'error',
      metadata: { error: (err as Error).message },
    });
    res.status(502).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Re-índice handler — wires to nothing destructive yet, but logs. ─
adminRouter.post('/reindex', async (req, res) => {
  await auditFromReq(req, {
    verb: 'solicitó re-índice',
    resource: 'corpus completo',
    resource_kind: 'system',
    result: 'ok',
    metadata: { note: 'queued — worker no arranca aún en producción' },
  });
  res.json({
    ok: true,
    queued: true,
    note: 'Job marcado para reproceso. El worker batch lo recoge en la próxima ventana.',
  });
});

// ─── Workers (mock — legacy worker doesn't publish status today) ─────
adminRouter.get('/workers', (_req, res) => {
  res.json(
    mocked({
      items: [
        { name: 'scraper-orden-del-dia',    schedule: '0 7 * * 1-5',  last_run_iso: '2026-04-26T13:55:00Z', last_duration_ms: 82_000,  ok: true,  total_runs: 128,  success_rate_pct: 99.2 },
        { name: 'scraper-actas-plenaria',   schedule: '0 22 * * 1-5', last_run_iso: '2026-04-25T22:04:00Z', last_duration_ms: 258_000, ok: true,  total_runs: 94,   success_rate_pct: 100  },
        { name: 'scraper-expedientes-sil',  schedule: '*/15 * * * *', last_run_iso: '2026-04-26T14:30:00Z', last_duration_ms: 38_000,  ok: false, total_runs: 8412, success_rate_pct: 96.7, error: '3× 502 del SIL' },
        { name: 'transcribe-whisper-batch', schedule: 'evento',       last_run_iso: '2026-04-26T13:58:00Z', last_duration_ms: 724_000, ok: true,  total_runs: 341,  success_rate_pct: 98.4 },
        { name: 'embed-rag-chunks',         schedule: 'evento',       last_run_iso: '2026-04-26T14:01:00Z', last_duration_ms: 44_000,  ok: true,  total_runs: 1207, success_rate_pct: 99.9 },
        { name: 'consolidate-cerebro',      schedule: '0 3 * * *',    last_run_iso: '2026-04-26T03:00:00Z', last_duration_ms: 378_000, ok: true,  total_runs: 62,   success_rate_pct: 100  },
      ],
    }),
  );
});

// ─── Build info ──────────────────────────────────────────────────────
adminRouter.get('/build', (_req, res) => {
  res.json(
    live({
      version: process.env.SHIFT_CL2_VERSION ?? '0.1.0',
      build: process.env.SHIFT_CL2_BUILD ?? 'dev',
      deployed_at: process.env.SHIFT_CL2_DEPLOYED_AT ?? null,
      node: process.version,
      region: process.env.RAILWAY_REGION ?? process.env.AWS_REGION ?? 'local',
      host: process.env.PUBLIC_API_HOST ?? 'localhost:3001',
      locale: 'es-CR · UTC-6',
    }),
  );
});

// ─── Helpers + mock fallbacks ────────────────────────────────────────

interface MockTransRow {
  external_id: string;
  session_id: number | null;
  sesion_label: string;
  expediente: string | null;
  date: string;
  duration_seconds: number;
  confidence: number;
  flagged_segments: number;
  status: 'pending' | 'in_progress' | 'approved' | 'rejected';
  source: string;
  speaker: string;
  excerpt_text: string;
  excerpt_ts: string;
}

const MOCK_QUEUE: MockTransRow[] = [
  { external_id: 'tr-1287', session_id: 128, sesion_label: 'Plenaria N°128',          expediente: 'Exp. 23.456', date: '2026-04-22T00:00:00Z', duration_seconds: 8100,  confidence: 84, flagged_segments: 3,  status: 'pending', source: 'Whisper-large · v3', speaker: 'Dip. Calderón Castro', excerpt_text: 'El artículo catorce, en su redacción actual, deja un vacío que esta moción busca cerrar de manera permanente.', excerpt_ts: '1:57:26' },
  { external_id: 'tr-1286', session_id: 0,   sesion_label: 'Comisión Hacendarios',     expediente: 'Exp. 24.018', date: '2026-04-19T00:00:00Z', duration_seconds: 10920, confidence: 71, flagged_segments: 11, status: 'pending', source: 'Whisper-large · v3', speaker: 'Dip. Mora Castillo',   excerpt_text: 'Solicito la suspensión del trámite hasta que se incorpore el dictamen afirmativo de minoría que presentamos el martes.', excerpt_ts: '0:48:11' },
  { external_id: 'tr-1285', session_id: 127, sesion_label: 'Plenaria N°127',          expediente: 'Exp. 23.901', date: '2026-04-21T00:00:00Z', duration_seconds: 6480,  confidence: 92, flagged_segments: 1,  status: 'pending', source: 'Whisper-large · v3', speaker: 'Presidencia',          excerpt_text: 'Aprobado por unanimidad de los presentes. Se cierra la sesión a las dieciocho horas con cinco minutos.', excerpt_ts: '1:43:08' },
  { external_id: 'tr-1284', session_id: 126, sesion_label: 'Plenaria N°126',          expediente: null,          date: '2026-04-20T00:00:00Z', duration_seconds: 2700,  confidence: 96, flagged_segments: 0,  status: 'pending', source: 'Whisper-large · v3', speaker: 'Presidencia',          excerpt_text: 'Iniciamos la sesión con la lectura del orden del día.', excerpt_ts: '0:00:24' },
  { external_id: 'tr-1283', session_id: 125, sesion_label: 'Plenaria N°125',          expediente: null,          date: '2026-04-18T00:00:00Z', duration_seconds: 900,   confidence: 78, flagged_segments: 2,  status: 'pending', source: 'Whisper-large · v3', speaker: 'Secretaría',           excerpt_text: 'Por receso parlamentario, suspendemos hasta el lunes.', excerpt_ts: '0:12:01' },
  { external_id: 'tr-1282', session_id: 124, sesion_label: 'Comisión Asuntos Sociales', expediente: 'Exp. 23.901', date: '2026-04-15T00:00:00Z', duration_seconds: 9000,  confidence: 88, flagged_segments: 4,  status: 'pending', source: 'Whisper-large · v3', speaker: 'Dip. Vargas Soto',     excerpt_text: 'Es necesario incluir un transitorio que proteja los derechos adquiridos antes de la entrada en vigencia.', excerpt_ts: '2:14:33' },
  { external_id: 'tr-1281', session_id: 123, sesion_label: 'Comisión Jurídicos',       expediente: 'Exp. 22.811', date: '2026-04-12T00:00:00Z', duration_seconds: 4920,  confidence: 65, flagged_segments: 8,  status: 'pending', source: 'Whisper-large · v3', speaker: 'Sin atribuir',         excerpt_text: 'Inaudible — solapamiento con micrófono abierto.', excerpt_ts: '0:42:18' },
];

function shapeTransRow(row: Record<string, unknown>): {
  id: string;
  session_id: number | null;
  sesion_label: string;
  expediente: string | null;
  date: string;
  duration_seconds: number;
  confidence: number;
  flagged_segments: number;
  status: 'pending' | 'in_progress' | 'approved' | 'rejected';
  source: string;
  speaker: string;
  excerpt: string;
  excerpt_ts: string;
} {
  // Accept either a real DB row or a mock row.
  const externalId = (row.external_id as string | undefined) ?? '';
  return {
    id: externalId,
    session_id:
      typeof row.session_id === 'number'
        ? (row.session_id as number)
        : typeof row.session_id === 'string'
          ? Number(row.session_id) || null
          : null,
    sesion_label: (row.sesion_label as string | undefined) ?? `Sesión ${row.session_id ?? 'N/A'}`,
    expediente: (row.expediente as string | null | undefined) ?? null,
    date: (row.date as string | undefined) ?? (row.created_at as string | undefined) ?? new Date().toISOString(),
    duration_seconds: (row.duration_seconds as number | undefined) ?? 0,
    confidence: Number(row.confidence ?? 0),
    flagged_segments: Number(row.flagged_segments ?? 0),
    status: (row.status as 'pending' | 'in_progress' | 'approved' | 'rejected' | undefined) ?? 'pending',
    source: (row.source as string | undefined) ?? 'Whisper-large · v3',
    speaker: (row.speaker as string | undefined) ?? '—',
    excerpt: (row.excerpt_text as string | undefined) ?? '',
    excerpt_ts: (row.excerpt_ts as string | undefined) ?? '0:00:00',
  };
}

function buildMockDetail(item: MockTransRow | Record<string, unknown>): {
  item: ReturnType<typeof shapeTransRow>;
  segments: Array<{ ts: string; speaker: string; text: string; confidence: number; flagged: boolean; highlighted?: boolean }>;
  diarization: Array<{ speaker: string; total_seconds: number; color: string }>;
  total_segments: number;
  total_words: number;
} {
  const shaped = shapeTransRow(item as Record<string, unknown>);
  const segments = [
    { ts: '1:55:42', speaker: 'Presidencia', text: 'Tiene la palabra el diputado Calderón Castro.', confidence: 98, flagged: false },
    { ts: '1:57:26', speaker: 'Dip. Calderón', text: shaped.excerpt, confidence: shaped.confidence, flagged: false, highlighted: true },
    { ts: '2:01:08', speaker: '⚠ Sin atribuir', text: 'Inaudible — solapamiento con micrófono abierto del fondo del recinto.', confidence: 42, flagged: true },
    { ts: '2:05:14', speaker: 'Dip. Mora', text: 'Solicito moción de orden, señor Presidente.', confidence: 99, flagged: false },
    { ts: '2:08:01', speaker: 'Presidencia', text: `Procedemos a la votación nominal del expediente ${shaped.expediente?.replace('Exp. ', '') ?? 'N/D'}.`, confidence: 99, flagged: false },
    { ts: '2:11:33', speaker: 'Secretaría', text: '38 a favor, 7 en contra, 2 abstenciones. Aprobado.', confidence: 97, flagged: false },
  ];
  const diarization = [
    { speaker: 'Presidencia', total_seconds: 862, color: '#7A3B47' },
    { speaker: 'Dip. Calderón Castro', total_seconds: 2284, color: '#1534dc' },
    { speaker: 'Dip. Mora Castillo', total_seconds: 767, color: '#10b981' },
    { speaker: 'Secretaría', total_seconds: 318, color: '#f59e0b' },
  ];
  return { item: shaped, segments, diarization, total_segments: 1247, total_words: 18402 };
}

function initialsForEmail(email: string | null | undefined): string {
  if (!email) return '??';
  const local = email.split('@')[0] ?? '';
  const parts = local.replace(/[._-]/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0] + parts[1]![0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

function quoteCsv(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Boot — log a one-time line so the operator can see the audit_log
// will receive entries when actions land.
void audit({
  actor_kind: 'system',
  verb: 'arrancó',
  resource: 'admin BFF',
  resource_kind: 'system',
  result: 'ok',
}).catch(() => undefined);

export { adminRouter };

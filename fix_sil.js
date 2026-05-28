const fs = require('fs');
let content = fs.readFileSync('apps/api/src/routes/sil.ts', 'utf8');

// The block starts exactly at:
//     // Step 1 — get the universe of indexed expediente_ids when needed.
// and ends exactly at:
//       return {
//         id,

const startMarker = `    // Step 1 — get the universe of indexed expediente_ids when needed.`;
const endMarker = `      return {
        id,`;

const prefix = content.substring(0, content.indexOf(startMarker));
const suffix = content.substring(content.indexOf(endMarker));

const newBlock = `    // The document join strategy changes based on includeMetadata:
    // If false (default), we only want expedientes with indexed documents. We use an !inner join to filter.
    // If true, we want all expedientes, so we use a normal left join.
    const docJoin = includeMetadata ? 'sil_documentos(id, tipo)' : 'sil_documentos!inner(id, tipo)';

    let q1 = s
      .from('sil_expedientes')
      .select(
        \`id, numero, titulo, comision, estado, tipo, fecha_presentacion, proponente, url_detalle, \${docJoin}\`,
        { count: 'exact' },
      );

    if (comision) q1 = q1.eq('comision', comision);
    if (estado) q1 = q1.eq('estado', estado);
    if (tipo) q1 = q1.eq('tipo', tipo);
    if (year) {
      const fromIso = \`\${year}-01-01\`;
      const toIso = \`\${year}-12-31\`;
      q1 = q1.gte('fecha_presentacion', fromIso).lte('fecha_presentacion', toIso);
    }
    // Date-range filter (Track E — pedido 9 calendario)
    // Only applies when dateField is valid; date_from / date_to are optional
    // individually (open-ended ranges are valid: e.g. "desde hoy en adelante").
    if (dateField) {
      if (dateFrom) q1 = q1.gte(dateField, dateFrom);
      if (dateTo) q1 = q1.lte(dateField, dateTo);
    }
    if (q) {
      // Numero match (substring) OR title match. PostgREST or-clause
      // with ilike. Numero is a string column with the dotted format
      // ("23.456"), so substring works for partial typing.
      const escaped = q.replace(/[%_]/g, (m) => \`\\\\\\${m}\`);
      q1 = q1.or(\`numero.ilike.%\${escaped}%,titulo.ilike.%\${escaped}%\`);
    }

    const { data: rows, error, count: totalRows } = await q1
      .order('fecha_presentacion', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      // PostgREST will throw 416 on out-of-bounds offset, return empty safely.
      if (error.code === 'PGRST103') {
        res.json({ ok: true, total: totalRows ?? 0, items: [], include_metadata: includeMetadata });
        return;
      }
      throw new Error(\`Supabase query failed: \${error.message} - \${error.details || ''}\`);
    }

    const items = (rows ?? []).map((r: any) => {
      const docs = r.sil_documentos || [];
      const id = r.id as number;
      const docsCount = docs.length;
      
      const tipos = new Set<string>();
      for (const doc of docs) {
        if (doc.tipo) tipos.add(doc.tipo);
      }
      
`;

fs.writeFileSync('apps/api/src/routes/sil.ts', prefix + newBlock + suffix);

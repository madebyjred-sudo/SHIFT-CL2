import 'dotenv/config';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

(async () => {
  const queries = [
    'Polo Turístico Golfo de Papagayo ICT',
    'Papagayo',
    'Polo Turistico Golfo Papagayo',  // sin acentos
  ];

  for (const query_text of queries) {
    const res = await fetch(`${URL}/rest/v1/rpc/search_sil_expedientes_by_text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({
        query_text,
        match_limit: 10,
        filter_comision: null,
        filter_fecha_from: null,
        filter_fecha_to: null,
      }),
    });
    const data = await res.json();
    console.log(`Q: "${query_text}" → status=${res.status} hits=${Array.isArray(data) ? data.length : '?'}`);
    if (Array.isArray(data) && data.length > 0) {
      console.log('  top:', data.slice(0, 3).map((r: { numero: string; rank: number }) => `${r.numero}(${r.rank.toFixed(3)})`));
    } else if (!Array.isArray(data)) {
      console.log('  data:', JSON.stringify(data).slice(0, 200));
    }
  }
})();

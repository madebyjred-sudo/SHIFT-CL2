const { fetchTranscript } = require('youtube-transcript');

const videos = [
  { id: 'iR-1YYXOIfQ', fecha: '2026-05-05', tipo: 'plenario', segs: 4063 },
  { id: '_dAERyLYeFQ', fecha: '2026-05-06', tipo: 'plenario', segs: 4652 },
  { id: 'MXialJ49KM4', fecha: '2026-05-06', tipo: 'plenario', segs: 2503 },
  { id: 'IjUqurWhxa4', fecha: '2026-05-07', tipo: 'plenario', segs: 3221 },
];

async function check() {
  for (const v of videos) {
    try {
      const segs = await fetchTranscript(v.id, { lang: 'es' });
      console.log(`${v.id} (${v.fecha} ${v.tipo} DB=${v.segs}): YT=${segs.length} segments, first: "${segs[0]?.text?.slice(0, 60)}..."`);
    } catch (err) {
      console.log(`${v.id} (${v.fecha} ${v.tipo} DB=${v.segs}): ERROR - ${err.message}`);
    }
  }
}

check().catch(console.error);

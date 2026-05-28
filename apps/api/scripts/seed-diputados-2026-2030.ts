/**
 * seed-diputados-2026-2030 — pobla la tabla `diputados` con los 57
 * miembros del periodo legislativo 2026-2030 de la Asamblea Legislativa
 * de Costa Rica.
 *
 * Source: Wikipedia + TSE (datos públicos verificables). Ver
 * /Users/juan/AGENTS/CL2/decisions/2026-05-19-diputados-seed.md para
 * justificación + cómo agregar el cuatrienio 2022-2026 (la lista no se
 * incluye acá porque no hay un Anexo Wikipedia equivalente todavía;
 * cuando lo tengamos, agregamos un seed-diputados-2022-2026.ts).
 *
 * Idempotente: borra todos los diputados con `periodo_inicio = 2026-05-01`
 * antes de insertar. Si te falta un dato (notas, etc.) corregís el array
 * y re-corres.
 *
 * Ejecución:
 *   cd apps/api && npx tsx -r dotenv/config scripts/seed-diputados-2026-2030.ts
 */
import { createClient } from '@supabase/supabase-js';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!SUPA_URL || !SUPA_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supa = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });

const PERIODO_INICIO = '2026-05-01';
const PERIODO_FIN = '2030-04-30';

interface Diputado {
  nombreCompleto: string;        // como aparece en Wikipedia
  fraccion: string;              // texto completo
  fraccionCorta: string;         // PPS / PLN / FA / AC / PUSC
  provincia: string;             // San José / Alajuela / Cartago / Heredia / Guanacaste / Puntarenas / Limón
  curul: number;                 // 1-N dentro de la provincia
  notas?: string;
}

/**
 * Las 57 curules — orden Wikipedia (San José 1..18, Alajuela 1..12,
 * Cartago 1..6, Heredia 1..5, Guanacaste 1..5, Puntarenas 1..6, Limón
 * 1..5). Cuando el apellido tiene tilde, va con tilde — el matcher la
 * normaliza al comparar contra el SIL.
 */
const DIPUTADOS: ReadonlyArray<Diputado> = [
  // ─── San José (18) ─────────────────────────────────────────────────
  { nombreCompleto: 'Nogui Acosta Jaén', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'San José', curul: 1, notas: 'Jefe de fracción PPS. Ministro de Hacienda 2022-2025.' },
  { nombreCompleto: 'Kattia Alejandra Mora Montoya', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'San José', curul: 2 },
  { nombreCompleto: 'Stephan Brunner Neibig', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'San José', curul: 3, notas: 'Primer Vicepresidente de la República 2022-2025. Economista.' },
  { nombreCompleto: 'Mayuli del Carmen Ortega Guzmán', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'San José', curul: 4 },
  { nombreCompleto: 'Gonzalo Alberto Ramírez Zamora', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'San José', curul: 5, notas: 'Diputado 2014-2018 (PRC). Pastor evangélico y abogado.' },
  // Wikipedia tenía "Anna Katharina Müller Castro" pero el SIL (fuente
  // canónica del Tribunal Supremo de Elecciones + Asamblea) la serializa
  // como "MULLER MARIN KATHERINE" — apellido materno Marín, no Castro.
  // Corrección verificada con CL2 Consultoría 2026-05-19.
  // El canonicalize() ya normaliza Müller→MULLER (strip diacríticos), así
  // que tanto "Müller Marín" como "MULLER MARIN" del SIL matchean.
  { nombreCompleto: 'Katherine Müller Marín', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'San José', curul: 6, notas: 'Ministra de Educación Pública 2022-2025.' },
  { nombreCompleto: 'Antonio Barzuna Thompson', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'San José', curul: 7 },
  { nombreCompleto: 'Sadie Esmeralda Britton González', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'San José', curul: 8 },
  { nombreCompleto: 'Álvaro Ramírez Bogantes', fraccion: 'Partido Liberación Nacional', fraccionCorta: 'PLN', provincia: 'San José', curul: 9, notas: 'Jefe de fracción PLN. Candidato a vicepresidente PLN 2022.' },
  { nombreCompleto: 'Iztarú Alfaro Guerrero', fraccion: 'Partido Liberación Nacional', fraccionCorta: 'PLN', provincia: 'San José', curul: 10, notas: 'Subjefa fracción PLN. Regidora MSJ 2024-2028.' },
  { nombreCompleto: 'Rafael Ángel Vargas Brenes', fraccion: 'Partido Liberación Nacional', fraccionCorta: 'PLN', provincia: 'San José', curul: 11 },
  { nombreCompleto: 'Andrea Patricia Valverde Palavicini', fraccion: 'Partido Liberación Nacional', fraccionCorta: 'PLN', provincia: 'San José', curul: 12 },
  { nombreCompleto: 'Marco Francisco Badilla Chavarría', fraccion: 'Partido Liberación Nacional', fraccionCorta: 'PLN', provincia: 'San José', curul: 13, notas: 'Director General de Migración 2002-2005.' },
  { nombreCompleto: 'José María Villalta Flórez Estrada', fraccion: 'Frente Amplio', fraccionCorta: 'FA', provincia: 'San José', curul: 14, notas: 'Diputado FA 2010-2014 y 2014-2018. Candidato presidencial 2014.' },
  { nombreCompleto: 'Vianey Briyith Mora Vega', fraccion: 'Frente Amplio', fraccionCorta: 'FA', provincia: 'San José', curul: 15 },
  { nombreCompleto: 'Antonio Trejos Mazariegos', fraccion: 'Frente Amplio', fraccionCorta: 'FA', provincia: 'San José', curul: 16 },
  { nombreCompleto: 'Claudia Dobles Camargo', fraccion: 'Coalición Agenda Ciudadana', fraccionCorta: 'AC', provincia: 'San José', curul: 17, notas: 'Candidata presidencial 2026. Primera Dama 2018-2022.' },
  { nombreCompleto: 'Abril Gordienko López', fraccion: 'Partido Unidad Social Cristiana', fraccionCorta: 'PUSC', provincia: 'San José', curul: 18, notas: 'Candidata a vicepresidencia PML 2014.' },

  // ─── Alajuela (12) ─────────────────────────────────────────────────
  { nombreCompleto: 'José Miguel Villalobos Umaña', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Alajuela', curul: 1, notas: 'Ministro de Justicia y Gracia 2002-2006. Candidato presidencial PADN 2006.' },
  { nombreCompleto: 'Zaira Murillo Marín', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Alajuela', curul: 2 },
  { nombreCompleto: 'Gerardo Bogantes Rivera', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Alajuela', curul: 3 },
  { nombreCompleto: 'Grethel María Ávila Vargas', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Alajuela', curul: 4 },
  { nombreCompleto: 'Wilson Alfredo Jiménez Cordero', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Alajuela', curul: 5 },
  { nombreCompleto: 'Kattia María Ulate Alvarado', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Alajuela', curul: 6 },
  { nombreCompleto: 'Fernando Obaldía Álvarez', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Alajuela', curul: 7 },
  { nombreCompleto: 'Karen Tatiana Alfaro Jiménez', fraccion: 'Partido Liberación Nacional', fraccionCorta: 'PLN', provincia: 'Alajuela', curul: 8 },
  { nombreCompleto: 'Diana Murillo Murillo', fraccion: 'Partido Liberación Nacional', fraccionCorta: 'PLN', provincia: 'Alajuela', curul: 9, notas: 'Vicealcaldesa San Carlos 2024-2026.' },
  { nombreCompleto: 'Eder Francisco Hernández Ulloa', fraccion: 'Partido Liberación Nacional', fraccionCorta: 'PLN', provincia: 'Alajuela', curul: 10 },
  { nombreCompleto: 'Edgardo Vinicio Araya Sibaja', fraccion: 'Frente Amplio', fraccionCorta: 'FA', provincia: 'Alajuela', curul: 11, notas: 'Diputado FA 2014-2018. Candidato presidencial FA 2018.' },
  { nombreCompleto: 'Sigrid Violeta Segura Artavia', fraccion: 'Frente Amplio', fraccionCorta: 'FA', provincia: 'Alajuela', curul: 12 },

  // ─── Cartago (6) ───────────────────────────────────────────────────
  { nombreCompleto: 'Cindy María Blanco González', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Cartago', curul: 1 },
  { nombreCompleto: 'Robert Johsan Barrantes Camacho', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Cartago', curul: 2 },
  { nombreCompleto: 'Yara Vanessa Jiménez Fallas', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Cartago', curul: 3, notas: 'Secretaria del Consejo de Gobierno 2022-2025. Presidenta de la Asamblea Legislativa.' },
  { nombreCompleto: 'Janice Patricia Sandí Morales', fraccion: 'Partido Liberación Nacional', fraccionCorta: 'PLN', provincia: 'Cartago', curul: 4 },
  { nombreCompleto: 'Salvador Padilla Villanueva', fraccion: 'Partido Liberación Nacional', fraccionCorta: 'PLN', provincia: 'Cartago', curul: 5 },
  { nombreCompleto: 'Joselyn Fabiola Sáenz Núñez', fraccion: 'Frente Amplio', fraccionCorta: 'FA', provincia: 'Cartago', curul: 6 },

  // ─── Heredia (5) ───────────────────────────────────────────────────
  { nombreCompleto: 'Marta Eugenia Esquivel Rodríguez', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Heredia', curul: 1, notas: 'Presidenta Ejecutiva CCSS 2022-2025. Ministra de Planificación.' },
  { nombreCompleto: 'Juan Manuel Quesada Espinoza', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Heredia', curul: 2, notas: 'Subjefe fracción PPS. Presidente Ejecutivo AyA 2022-2025.' },
  { nombreCompleto: 'Víctor Manuel Hidalgo Solís', fraccion: 'Partido Liberación Nacional', fraccionCorta: 'PLN', provincia: 'Heredia', curul: 3, notas: 'Alcalde Santa Bárbara 2020-2028.' },
  { nombreCompleto: 'Ángela Ileana Aguilar Vargas', fraccion: 'Partido Liberación Nacional', fraccionCorta: 'PLN', provincia: 'Heredia', curul: 4, notas: 'Alcaldesa de Heredia 2022-2028.' },
  { nombreCompleto: 'María Eugenia Román Mora', fraccion: 'Frente Amplio', fraccionCorta: 'FA', provincia: 'Heredia', curul: 5 },

  // ─── Guanacaste (5) ────────────────────────────────────────────────
  { nombreCompleto: 'Nayuribe Guadamuz Rosales', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Guanacaste', curul: 1, notas: 'Ministra de Cultura 2022-2024.' },
  { nombreCompleto: 'Daniel Asdrúbal Siezar Cárdenas', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Guanacaste', curul: 2 },
  { nombreCompleto: 'Cindy Dayana Murillo Artavia', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Guanacaste', curul: 3 },
  { nombreCompleto: 'Ronald Alberto Campos Villegas', fraccion: 'Partido Liberación Nacional', fraccionCorta: 'PLN', provincia: 'Guanacaste', curul: 4 },
  { nombreCompleto: 'Karol Vanessa Matamoros Montoya', fraccion: 'Partido Liberación Nacional', fraccionCorta: 'PLN', provincia: 'Guanacaste', curul: 5 },

  // ─── Puntarenas (6) ────────────────────────────────────────────────
  { nombreCompleto: 'Royner Mora Ruiz', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Puntarenas', curul: 1, notas: 'Ministro del Deporte / Presidente Ejecutivo ICODER 2023-2025.' },
  { nombreCompleto: 'María Isabel Camareno Camareno', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Puntarenas', curul: 2 },
  { nombreCompleto: 'Ariel Alfonso Mora Fallas', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Puntarenas', curul: 3 },
  { nombreCompleto: 'Ana Ruth Esquivel Medrano', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Puntarenas', curul: 4 },
  { nombreCompleto: 'Norjelens María Lobo Vargas', fraccion: 'Partido Liberación Nacional', fraccionCorta: 'PLN', provincia: 'Puntarenas', curul: 5 },
  { nombreCompleto: 'Jesús Antonio Calderón Calderón', fraccion: 'Partido Liberación Nacional', fraccionCorta: 'PLN', provincia: 'Puntarenas', curul: 6 },

  // ─── Limón (5) ─────────────────────────────────────────────────────
  { nombreCompleto: 'Osvaldo Artavia Carballo', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Limón', curul: 1 },
  { nombreCompleto: 'Kristel Lizeth Ward Hudson', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Limón', curul: 2, notas: 'Viceministra de Juventud 2022-2024.' },
  { nombreCompleto: 'Kathia Calvo Cruz', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Limón', curul: 3 },
  { nombreCompleto: 'Reynaldo Arias Mora', fraccion: 'Partido Pueblo Soberano', fraccionCorta: 'PPS', provincia: 'Limón', curul: 4 },
  { nombreCompleto: 'Mangell Mc Lean Villalobos', fraccion: 'Partido Liberación Nacional', fraccionCorta: 'PLN', provincia: 'Limón', curul: 5, notas: 'Alcalde de Siquirres 2016-2020.' },
];

/**
 * Separa "Nogui Acosta Jaén" → { nombre: "Nogui", apellidos_display: "Acosta Jaén" }.
 * Heurística CR: los DOS últimos tokens son los apellidos (paterno + materno);
 * el resto es nombre(s).
 *
 * Excepciones manejadas:
 * - "Mc Lean" como un solo apellido (último token contiene "Lean", penúltimo "Mc")
 * - "del Carmen" en nombres compuestos → cae al nombre, no apellidos
 */
function splitName(full: string): { nombre: string; apellidosDisplay: string } {
  const tokens = full.trim().split(/\s+/);
  if (tokens.length < 2) {
    return { nombre: '', apellidosDisplay: full };
  }
  // Caso especial: "Mc Lean Villalobos" → apellidos = "Mc Lean Villalobos"
  // (3 tokens donde el primero de los apellidos es prefijo "Mc"/"Mac"/"De"/"De la"/"Del")
  // Heurística: si el antepenúltimo es un conector ("Mc", "Mac", "De", "Del", "La", "Los", "Y"),
  // los apellidos son los últimos 3.
  const lastN = (n: number) => tokens.slice(-n).join(' ');
  const tn3 = tokens.length >= 3 ? tokens[tokens.length - 3] : '';
  if (/^(mc|mac|de|del|la|los|y|von|van)$/i.test(tn3)) {
    return {
      nombre: tokens.slice(0, -3).join(' '),
      apellidosDisplay: lastN(3),
    };
  }
  return {
    nombre: tokens.slice(0, -2).join(' '),
    apellidosDisplay: lastN(2),
  };
}

/**
 * Normaliza apellidos al formato SIL: mayúsculas + sin tildes.
 * Ej: "Acosta Jaén" → "ACOSTA JAEN".
 */
function canonicalize(apellidos: string): string {
  return apellidos
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toUpperCase()
    .trim();
}

async function main() {
  console.log(`[seed] starting — ${DIPUTADOS.length} diputados, periodo ${PERIODO_INICIO} → ${PERIODO_FIN}`);

  // Idempotente: borrar antes de insertar
  const { error: delErr } = await supa
    .from('diputados')
    .delete()
    .eq('periodo_inicio', PERIODO_INICIO);
  if (delErr) {
    console.error('[seed] delete failed:', delErr.message);
    process.exit(1);
  }
  console.log('[seed] cleared existing rows for this period');

  const rows = DIPUTADOS.map((d) => {
    const { nombre, apellidosDisplay } = splitName(d.nombreCompleto);
    return {
      apellidos_canonical: canonicalize(apellidosDisplay),
      apellidos_display: apellidosDisplay,
      nombre,
      nombre_completo: d.nombreCompleto,
      fraccion: d.fraccion,
      fraccion_corta: d.fraccionCorta,
      provincia: d.provincia,
      curul: d.curul,
      periodo_inicio: PERIODO_INICIO,
      periodo_fin: PERIODO_FIN,
      notas: d.notas ?? null,
    };
  });

  const { error: insErr } = await supa.from('diputados').insert(rows);
  if (insErr) {
    console.error('[seed] insert failed:', insErr.message);
    process.exit(1);
  }

  console.log(`[seed] inserted ${rows.length} diputados`);

  // Sanity check: top 5 PPS
  const { data: sample } = await supa
    .from('diputados')
    .select('apellidos_canonical, nombre, fraccion_corta, provincia')
    .eq('periodo_inicio', PERIODO_INICIO)
    .order('curul', { ascending: true })
    .limit(5);
  console.log('[seed] sample:', JSON.stringify(sample, null, 2));
}

main().catch((e) => {
  console.error('[seed] fatal:', e);
  process.exit(1);
});

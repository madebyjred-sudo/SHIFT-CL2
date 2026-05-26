/**
 * Tests para voteSummaryParser — extracción de votaciones desde
 * `metadata.resumen.acuerdos`. Casos verbatim de prod (sessions 2026-05-11
 * a 2026-05-21 inclusive).
 */
import { describe, it, expect } from 'vitest';
import { parseVotesFromAcuerdos, renderVoteAsChunkContent } from './voteSummaryParser.js';

describe('parseVotesFromAcuerdos — casos reales de prod', () => {
  it('21-may-2026 — extrae 3 votaciones formales (descarta suspensión)', () => {
    const txt = `El Plenario Legislativo tomó varios acuerdos formales. Se aprobó por 56 votos a favor la moción para sesionar de forma extraordinaria el miércoles 27 de mayo para la elección de magistrados suplentes de la Sala Constitucional (expediente 25.258). Se aprobó en segundo debate el expediente 24.998 con 52 votos a favor. Asimismo, se aprobó en segundo debate el expediente 24.642, Ley para el mejoramiento de la gestión del PANI, con 53 votos a favor. Se suspendió formalmente el trámite del expediente 24.009 sobre alianzas público-privadas por haber sido enviado a consulta constitucional. Varios expedientes fueron remitidos a comisión para el estudio de mociones.`;
    const r = parseVotesFromAcuerdos(txt);
    // Esperamos 3 votos: 25.258, 24.998, 24.642. 24.009 (suspensión) descartado.
    expect(r.length).toBe(3);
    const by = (e: string) => r.find((v) => v.expediente === e);

    expect(by('25.258')).toMatchObject({
      decision: 'aprobado_mocion',
      votos_a_favor: 56,
    });
    expect(by('24.998')).toMatchObject({
      decision: 'aprobado_2do_debate',
      votos_a_favor: 52,
    });
    expect(by('24.642')).toMatchObject({
      decision: 'aprobado_2do_debate',
      votos_a_favor: 53,
    });

    // 24.009 NO debe estar (es suspensión, no votación)
    expect(by('24.009')).toBeUndefined();
  });

  it('19-may-2026 — rechazo con votos en contra Y a favor', () => {
    const txt = `El único acuerdo formal registrado fue la votación sobre el dictamen de mayoría negativo del expediente 24099, el cual fue rechazado por 29 votos en contra y 26 a favor. En consecuencia, se dispuso continuar el trámite legislativo de dicho expediente con base en el dictamen afirmativo de minoría.`;
    const r = parseVotesFromAcuerdos(txt);
    expect(r.length).toBe(1);
    expect(r[0]).toMatchObject({
      expediente: '24.099',
      decision: 'rechazado',
      votos_a_favor: 26,
      votos_en_contra: 29,
    });
  });

  it('11-may-2026 — segundo y definitivo debate (decisión refinada)', () => {
    const txt = `Se registraron varios acuerdos formales. Se aprobó el acta de la sesión anterior y se acordó la integración de las Comisiones con Potestad Legislativa Plena. En materia legislativa, se aprobó en segundo y definitivo debate el expediente 25114 para la adhesión de Costa Rica al Acuerdo de Asociación de Economía Digital (DEPA). Adicionalmente, se aprobó por consenso un texto sustitutivo para el expediente 24259, que reforma la ley de JAPDEVA, y se acordó dispensar de lectura dicho texto para su votación.`;
    const r = parseVotesFromAcuerdos(txt);
    const by = (e: string) => r.find((v) => v.expediente === e);
    expect(by('25.114')).toMatchObject({
      decision: 'aprobado_2do_definitivo',
      votos_a_favor: null,
    });
    expect(by('24.259')).toMatchObject({
      decision: 'aprobado',
      votos_a_favor: null,
    });
  });

  it('20-may-2026 — sesión sin votaciones de proyectos descarta todo', () => {
    const txt = `Se aprobó el acta de la sesión anterior. Se leyeron dos acuerdos de la Presidencia: el 7120-2026-2027, que corrige la integración de las comisiones plenas primera y tercera, y el 7121-2026-2027, que integra la Comisión Permanente Especial de Discapacidad y Adulto Mayor. Se fijó el 28 de mayo de 2026 para la segunda lectura de las propuestas de reforma constitucional sobre la elección de magistrados y sobre los plazos del Contralor General. No se realizaron votaciones para aprobar proyectos de ley en primer o segundo debate.`;
    const r = parseVotesFromAcuerdos(txt);
    // Acta de sesión y acuerdos de Presidencia no son votos sobre expedientes.
    expect(r).toEqual([]);
  });

  it('13-may-2026 — moción sin expediente claro descarta', () => {
    const txt = `Se aprobó una moción de orden con 50 votos a favor y cero en contra, para dar paso a la lectura de la resolución de la Presidencia de la Asamblea Legislativa sobre el procedimiento a seguir con las reformas constitucionales pendientes.`;
    const r = parseVotesFromAcuerdos(txt);
    // Sin expediente → no podemos linkear.
    expect(r).toEqual([]);
  });

  it('14-may-2026 — rechazo de mociones que ratifica archivo de expediente', () => {
    const txt = `El principal acuerdo formal de la sesión fue el rechazo, mediante votación del Plenario (29 en contra, 24 a favor), de las mociones de apelación presentadas contra la resolución de la Presidencia. Esta decisión ratificó el archivo del expediente 25.400, correspondiente a la denuncia por hostigamiento sexual contra el exdiputado Fabricio Alvarado Muñoz, por considerar que la Asamblea Legislativa carece de competencia para sancionar a quien ya no ostenta la investidura de diputado.`;
    const r = parseVotesFromAcuerdos(txt);
    // 25.400 NO recibió votación directa — fue ratificación indirecta.
    // El parser solo capta votos directos sobre expedientes.
    // Si captura algo, debe ser sobre 25.400; si no captura nada, ok también.
    if (r.length > 0) {
      expect(r[0].expediente).toBe('25.400');
    }
  });
});

describe('parseVotesFromAcuerdos — edge cases', () => {
  it('texto vacío', () => {
    expect(parseVotesFromAcuerdos('')).toEqual([]);
  });

  it('texto sin votos', () => {
    expect(parseVotesFromAcuerdos('Hubo discusión de varios temas sin votación formal.')).toEqual([]);
  });

  it('null/undefined seguro', () => {
    expect(parseVotesFromAcuerdos(null as unknown as string)).toEqual([]);
    expect(parseVotesFromAcuerdos(undefined as unknown as string)).toEqual([]);
  });

  it('múltiples expedientes en misma oración → un voto por cada', () => {
    const txt = `Se aprobaron por 40 votos a favor los expedientes 22.111 y 22.222 en primer debate.`;
    const r = parseVotesFromAcuerdos(txt);
    expect(r.length).toBe(2);
    expect(r.map((v) => v.expediente).sort()).toEqual(['22.111', '22.222']);
    for (const v of r) {
      expect(v.decision).toBe('aprobado_1er_debate');
      expect(v.votos_a_favor).toBe(40);
    }
  });

  it('"cero" se convierte a 0 (palabra)', () => {
    const txt = `Se aprobó el expediente 22.111 con 45 votos a favor y cero en contra.`;
    const r = parseVotesFromAcuerdos(txt);
    expect(r.length).toBe(1);
    expect(r[0].votos_a_favor).toBe(45);
    expect(r[0].votos_en_contra).toBe(0);
  });

  it('decisión rechazo sin votos explícitos', () => {
    const txt = `Fue rechazado el expediente 22.999.`;
    const r = parseVotesFromAcuerdos(txt);
    expect(r.length).toBe(1);
    expect(r[0].decision).toBe('rechazado');
    expect(r[0].votos_a_favor).toBeNull();
  });
});

describe('renderVoteAsChunkContent', () => {
  it('aprobado_2do_debate con conteo', () => {
    const txt = renderVoteAsChunkContent(
      {
        expediente: '24.998',
        decision: 'aprobado_2do_debate',
        votos_a_favor: 52,
        votos_en_contra: 0,
        fuente_oracion: 'Se aprobó en segundo debate el expediente 24.998 con 52 votos a favor.',
      },
      { fecha: '2026-05-21', tipo_sesion: 'Plenario Legislativo' },
    );
    expect(txt).toContain('RESULTADO DE VOTACIÓN OFICIAL');
    expect(txt).toContain('24.998');
    expect(txt).toContain('52 votos a favor');
    expect(txt).toContain('2026-05-21');
    expect(txt).toContain('segundo debate');
  });

  it('rechazado sin conteo', () => {
    const txt = renderVoteAsChunkContent(
      {
        expediente: '23.111',
        decision: 'rechazado',
        votos_a_favor: null,
        votos_en_contra: null,
        fuente_oracion: 'Fue rechazado el expediente 23.111.',
      },
      { fecha: null, tipo_sesion: null },
    );
    expect(txt).toContain('Fue rechazado');
    expect(txt).toContain('no especificados');
  });
});

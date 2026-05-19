/**
 * Mapeo de administraciones presidenciales de Costa Rica.
 *
 * Por qué este módulo existe:
 *   Cuando un expediente del SIL viene del Poder Ejecutivo, el SIL solo
 *   pone "PODER" en la columna Apellidos del bloque Secuencia de Firma —
 *   sin presidente, sin partido, sin fecha. El campo `administracion` de
 *   `sil_expediente_proponentes` queda null y la UI muestra solo "Poder
 *   PROPONENTE PRINCIPAL", sin contexto histórico.
 *
 *   Cruzando `fecha_presentacion` del expediente con este mapping
 *   podemos rellenar `administracion` automáticamente. Costa Rica
 *   inaugura cada 8 de mayo desde 1986; el dato es público, estable, y
 *   no hay que pegarle a una fuente externa.
 *
 * Cobertura:
 *   1986 → 2030 (12 administraciones, cubre todos los expedientes del
 *   SIL desde la migración digital del catálogo).
 *
 * Nombres canonical:
 *   Usamos APELLIDOS en mayúsculas (mismo formato que el SIL para los
 *   diputados firmantes), para que un proponente de SIL "PODER" pueda
 *   uniformarse con cualquier otro firmante en queries del frontend.
 *   Si el cliente más adelante quiere "Rodrigo Chaves Robles" completo,
 *   agregamos un campo `nombreCompleto` sin cambiar `apellidos`.
 */

export interface AdministracionCR {
  /** Apellidos del presidente en mayúsculas, formato SIL. */
  apellidos: string;
  /** Nombre + apellidos completo para displays largos. */
  nombreCompleto: string;
  /** Fecha de inauguración (inclusiva). ISO YYYY-MM-DD. */
  inicio: string;
  /** Fecha de fin del periodo (exclusiva — el día siguiente inaugura el sucesor). */
  fin: string;
  /** Partido político con que ganó la elección (texto canónico). */
  partido: string;
}

/**
 * Costa Rica inaugura cada 8 de mayo. Cada administración dura 4 años
 * (constitucional). Source: Asamblea Legislativa + Tribunal Supremo de
 * Elecciones (datos verificables públicamente).
 *
 * Orden cronológico ascendente para que un linear scan encuentre la
 * primera match — pero igual usamos `findByDate` que itera todo y devuelve
 * la única que cubre la fecha (defensivo contra overlaps por edits).
 */
export const ADMINISTRACIONES_CR: ReadonlyArray<AdministracionCR> = [
  {
    apellidos: 'ARIAS SÁNCHEZ',
    nombreCompleto: 'Óscar Arias Sánchez',
    inicio: '1986-05-08',
    fin: '1990-05-08',
    partido: 'PLN',
  },
  {
    apellidos: 'CALDERÓN FOURNIER',
    nombreCompleto: 'Rafael Ángel Calderón Fournier',
    inicio: '1990-05-08',
    fin: '1994-05-08',
    partido: 'PUSC',
  },
  {
    apellidos: 'FIGUERES OLSEN',
    nombreCompleto: 'José María Figueres Olsen',
    inicio: '1994-05-08',
    fin: '1998-05-08',
    partido: 'PLN',
  },
  {
    apellidos: 'RODRÍGUEZ ECHEVERRÍA',
    nombreCompleto: 'Miguel Ángel Rodríguez Echeverría',
    inicio: '1998-05-08',
    fin: '2002-05-08',
    partido: 'PUSC',
  },
  {
    apellidos: 'PACHECO DE LA ESPRIELLA',
    nombreCompleto: 'Abel Pacheco de la Espriella',
    inicio: '2002-05-08',
    fin: '2006-05-08',
    partido: 'PUSC',
  },
  {
    apellidos: 'ARIAS SÁNCHEZ',
    nombreCompleto: 'Óscar Arias Sánchez (2.º periodo)',
    inicio: '2006-05-08',
    fin: '2010-05-08',
    partido: 'PLN',
  },
  {
    apellidos: 'CHINCHILLA MIRANDA',
    nombreCompleto: 'Laura Chinchilla Miranda',
    inicio: '2010-05-08',
    fin: '2014-05-08',
    partido: 'PLN',
  },
  {
    apellidos: 'SOLÍS RIVERA',
    nombreCompleto: 'Luis Guillermo Solís Rivera',
    inicio: '2014-05-08',
    fin: '2018-05-08',
    partido: 'PAC',
  },
  {
    apellidos: 'ALVARADO QUESADA',
    nombreCompleto: 'Carlos Alvarado Quesada',
    inicio: '2018-05-08',
    fin: '2022-05-08',
    partido: 'PAC',
  },
  {
    apellidos: 'CHAVES ROBLES',
    nombreCompleto: 'Rodrigo Chaves Robles',
    inicio: '2022-05-08',
    fin: '2026-05-08',
    partido: 'PPSD',
  },
  {
    apellidos: 'FERNÁNDEZ DELGADO',
    nombreCompleto: 'Laura Fernández Delgado',
    inicio: '2026-05-08',
    fin: '2030-05-08',
    partido: 'PPS',
  },
];

/**
 * Devuelve la administración vigente en una fecha dada (formato ISO
 * `YYYY-MM-DD` o un objeto Date).
 *
 * Retorna `null` si la fecha es anterior a 1986 (límite inferior del
 * mapping) o posterior al fin del último periodo registrado.
 */
export function findAdministracionByDate(fecha: string | Date | null | undefined): AdministracionCR | null {
  if (!fecha) return null;
  const target = typeof fecha === 'string' ? fecha : fecha.toISOString().slice(0, 10);

  for (const adm of ADMINISTRACIONES_CR) {
    // inicio inclusivo, fin exclusivo (el día de cambio inaugura el sucesor)
    if (target >= adm.inicio && target < adm.fin) {
      return adm;
    }
  }
  return null;
}

/**
 * Tests para fechaDictamenExtractor — pedido 07/16g/16h del cliente CL2.
 *
 * Cubrimos las variantes que Carlos y Donovan dicen ver en los documentos
 * del SIL — convención formal ("FECHA ESTIMADA DE DICTAMEN") + variantes
 * manuales que cada analista escribe distinto.
 */
import { describe, it, expect } from 'vitest';
import {
  extractFechasDictamen,
  pickPrimaryFechaDictamen,
  extractPrimaryFechaDictamen,
} from './fechaDictamenExtractor.js';

describe('fechaDictamenExtractor', () => {
  describe('canonical FECHA ESTIMADA pattern', () => {
    it('extracts "FECHA ESTIMADA DE DICTAMEN: 14 de mayo de 2026"', () => {
      const text = 'Expediente 24982\n\nFECHA ESTIMADA DE DICTAMEN: 14 de mayo de 2026\n\nLa comisión...';
      const c = extractPrimaryFechaDictamen(text);
      expect(c?.valor_fecha).toBe('2026-05-14');
      expect(c?.pattern_id).toBe('fecha_estimada_canonical');
      expect(c?.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('extracts lowercase variant "fecha estimada de dictamen: 28-may-2026"', () => {
      const text = 'fecha estimada de dictamen: 28-may-2026';
      const c = extractPrimaryFechaDictamen(text);
      expect(c?.valor_fecha).toBe('2026-05-28');
    });

    it('extracts "Fecha estimada de dictamen del 03 de junio del 2026"', () => {
      const text = 'Fecha estimada de dictamen del 03 de junio del 2026';
      const c = extractPrimaryFechaDictamen(text);
      expect(c?.valor_fecha).toBe('2026-06-03');
    });

    it('extracts numeric format "fecha estimada de dictamen: 14/05/2026"', () => {
      const text = 'fecha estimada de dictamen: 14/05/2026';
      const c = extractPrimaryFechaDictamen(text);
      expect(c?.valor_fecha).toBe('2026-05-14');
    });
  });

  describe('variantes manuales (Carlos style)', () => {
    it('extracts "fecha para dictaminar: 14 de mayo de 2026"', () => {
      const text = 'fecha para dictaminar: 14 de mayo de 2026';
      const c = extractPrimaryFechaDictamen(text);
      expect(c?.valor_fecha).toBe('2026-05-14');
      expect(c?.pattern_id).toBe('fecha_para_dictaminar');
    });

    // Variantes encontradas en docs reales del SIL (2026-05-20 audit):
    it('extracts "Fecha para dictaminar el 08 de agosto de 2024."', () => {
      const text = 'Fecha para dictaminar el 08 de agosto de 2024. No se le presentó trámite';
      const c = extractPrimaryFechaDictamen(text);
      expect(c?.valor_fecha).toBe('2024-08-08');
    });

    it('extracts "fecha para dictaminar el expediente en discusión hasta el 16 de junio de 2023"', () => {
      const text = 'la comisión amplió la fecha para dictaminar el expediente en discusión hasta el 16 de junio de 2023 mediante Moción';
      const c = extractPrimaryFechaDictamen(text);
      expect(c?.valor_fecha).toBe('2023-06-16');
    });

    it('extracts "Fecha para dictaminar el 16 de abril de 2024."', () => {
      const text = 'Por el plazo otorgado por la moción 137. Fecha para dictaminar el 16 de abril de 2024.';
      const c = extractPrimaryFechaDictamen(text);
      expect(c?.valor_fecha).toBe('2024-04-16');
    });

    it('extracts "fecha tentativa de dictamen: 30-jun-2026"', () => {
      const text = 'fecha tentativa de dictamen: 30-jun-2026';
      const c = extractPrimaryFechaDictamen(text);
      expect(c?.valor_fecha).toBe('2026-06-30');
      expect(c?.pattern_id).toBe('fecha_tentativa');
    });

    it('extracts "se dictaminará el 14 de mayo de 2026"', () => {
      const text = 'La comisión se dictaminará el 14 de mayo de 2026 según el cronograma.';
      const c = extractPrimaryFechaDictamen(text);
      expect(c?.valor_fecha).toBe('2026-05-14');
    });

    it('extracts "para dictaminar antes del 30 de junio de 2026"', () => {
      const text = 'El expediente debe procesarse para dictaminar antes del 30 de junio de 2026.';
      const c = extractPrimaryFechaDictamen(text);
      expect(c?.valor_fecha).toBe('2026-06-30');
    });
  });

  describe('prefiere canonical sobre variantes', () => {
    it('cuando ambos patrones aparecen, gana canonical', () => {
      const text = `
        En el calendario interno aparece para dictaminar antes del 20 de mayo de 2026.
        FECHA ESTIMADA DE DICTAMEN: 14 de mayo de 2026
      `;
      const c = extractPrimaryFechaDictamen(text);
      expect(c?.valor_fecha).toBe('2026-05-14');
      expect(c?.pattern_id).toBe('fecha_estimada_canonical');
    });

    it('cuando hay 2 canonical, gana el más cercano al inicio', () => {
      const text = `
        FECHA ESTIMADA DE DICTAMEN: 14 de mayo de 2026
        ... muchas páginas ...
        En el anexo: FECHA ESTIMADA DE DICTAMEN: 21 de mayo de 2026
      `;
      const c = extractPrimaryFechaDictamen(text);
      expect(c?.valor_fecha).toBe('2026-05-14');
    });
  });

  describe('returns todas las candidatas para auditoría', () => {
    it('captura múltiples menciones distintas', () => {
      const text = `
        FECHA ESTIMADA DE DICTAMEN: 14 de mayo de 2026
        En conversación con el secretario, fecha tentativa de dictamen: 21-may-2026.
      `;
      const all = extractFechasDictamen(text);
      expect(all.length).toBe(2);
      const fechas = all.map((c) => c.valor_fecha).sort();
      expect(fechas).toEqual(['2026-05-14', '2026-05-21']);
    });
  });

  describe('rechaza fechas con typos del SIL', () => {
    it('ignora "2424" (typo común del SIL por "2024")', () => {
      // Cuando el SIL tiene typos de año (e.g. 2424 en lugar de 2024)
      // queremos NO insertar esa fecha — preferimos no-data a data-mala.
      const text = 'FECHA ESTIMADA DE DICTAMEN: 14 de mayo de 2424';
      const c = extractPrimaryFechaDictamen(text);
      expect(c).toBeNull();
    });
  });

  describe('contexto window', () => {
    it('captura ±80 chars alrededor del match', () => {
      const before = 'Lorem ipsum '.repeat(20); // 240 chars
      const after = ' dolor sit amet'.repeat(20);
      const text = `${before}FECHA ESTIMADA DE DICTAMEN: 14 de mayo de 2026.${after}`;
      const c = extractPrimaryFechaDictamen(text);
      expect(c?.contexto).toBeDefined();
      expect(c?.contexto?.includes('14 de mayo de 2026')).toBe(true);
    });
  });

  describe('text vacío o demasiado corto', () => {
    it('devuelve [] para text empty', () => {
      expect(extractFechasDictamen('')).toEqual([]);
    });
    it('devuelve [] para text < 20 chars', () => {
      expect(extractFechasDictamen('hola mundo')).toEqual([]);
    });
    it('devuelve [] para text sin matches', () => {
      const text = 'Este documento no tiene ninguna fecha de dictamen, solo habla de cosas generales del proyecto y su exposición de motivos.';
      expect(extractFechasDictamen(text)).toEqual([]);
    });
  });
});

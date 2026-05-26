/**
 * Tests para whatsappTemplates — Ronald F3 (2026-05-26).
 */
import { describe, it, expect } from 'vitest';
import {
  renderTemplate,
  listTemplateNames,
  buildDedupKey,
  WHATSAPP_TEMPLATES,
} from './whatsappTemplates.js';

describe('renderTemplate — happy path', () => {
  it('expediente_nuevo con todas las vars', () => {
    const out = renderTemplate('expediente_nuevo', {
      numero: '24.998',
      titulo: 'Acuerdo de transporte aéreo Costa Rica - Chile',
      proponente: 'PODER EJECUTIVO',
      fecha: '2025-05-22',
      cliente_label: 'FEDEFARMA',
      relevancia: 'rutas aéreas para distribución farmacéutica',
      url: 'https://cl2-v2.agentescl2.com/expediente/24.998',
    });
    expect(out).toContain('24.998');
    expect(out).toContain('FEDEFARMA');
    expect(out).toContain('PODER EJECUTIVO');
    expect(out).not.toMatch(/\{\{/);
  });

  it('votacion_proxima', () => {
    const out = renderTemplate('votacion_proxima', {
      numero: '24.642',
      titulo: 'Reforma PANI',
      fecha: '21 de mayo de 2026',
      tipo_debate: 'Segundo debate',
      comision: 'JUVENTUD (ÁREA II)',
      url: 'https://cl2-v2.agentescl2.com/expediente/24.642',
    });
    expect(out).toContain('Segundo debate');
    expect(out).toContain('21 de mayo de 2026');
  });

  it('ley_publicada con todos los campos', () => {
    const out = renderTemplate('ley_publicada', {
      numero_ley: '10761',
      numero_gaceta: '210',
      fecha: '2024-11-15',
      titulo: 'Ley de turismo regional',
      numero_expediente: '24.018',
      sector: 'turismo',
      cliente_label: 'ICT',
      url: 'https://cl2-v2.agentescl2.com/expediente/24.018',
    });
    expect(out).toContain('Ley N° 10761');
    expect(out).toContain('ICT');
    expect(out).toContain('La Gaceta N° 210');
  });
});

describe('renderTemplate — errors', () => {
  it('template name desconocido lanza', () => {
    expect(() => renderTemplate('inexistente', {})).toThrowError(/Unknown WhatsApp template/);
  });

  it('vars requeridas faltantes → error con nombres', () => {
    expect(() =>
      renderTemplate('expediente_nuevo', { numero: '24.998' }),
    ).toThrowError(/missing required vars/);
  });

  it('var vacía cuenta como missing', () => {
    expect(() =>
      renderTemplate('expediente_nuevo', {
        numero: '24.998',
        titulo: 'X',
        proponente: '',
        fecha: '2026-01-01',
        cliente_label: 'X',
        relevancia: 'X',
        url: 'X',
      }),
    ).toThrowError(/proponente/);
  });
});

describe('listTemplateNames + WHATSAPP_TEMPLATES', () => {
  it('al menos 5 templates registrados (uno por categoría base)', () => {
    expect(listTemplateNames().length).toBeGreaterThanOrEqual(5);
  });

  it('cada template tiene los 4 campos requeridos', () => {
    for (const [name, tpl] of Object.entries(WHATSAPP_TEMPLATES)) {
      expect(tpl.name, `${name}.name`).toBe(name);
      expect(tpl.description, `${name}.description`).toBeTruthy();
      expect(tpl.bodyTemplate, `${name}.bodyTemplate`).toBeTruthy();
      expect(tpl.requiredVars, `${name}.requiredVars`).toBeInstanceOf(Array);
      expect(tpl.category, `${name}.category`).toBeTruthy();
    }
  });

  it('cada bodyTemplate menciona todas sus requiredVars como {{var}}', () => {
    for (const tpl of Object.values(WHATSAPP_TEMPLATES)) {
      for (const v of tpl.requiredVars) {
        expect(tpl.bodyTemplate, `${tpl.name} no menciona {{${v}}}`).toContain(`{{${v}}}`);
      }
    }
  });
});

describe('buildDedupKey', () => {
  it('formato canonical cliente:template:scope', () => {
    expect(buildDedupKey('abc-123', 'expediente_nuevo', '24.998')).toBe(
      'abc-123:expediente_nuevo:24.998',
    );
  });
});

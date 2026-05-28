/**
 * Tests para canUseEditorialTools — gating de tools editoriales con marca CL2.
 * Wave 4 / Ronald F1 (2026-05-26).
 */
import { describe, it, expect } from 'vitest';
import { canUseEditorialTools, CL2_EDITORIAL_TOOLS } from './auth.js';

describe('canUseEditorialTools', () => {
  it('admin → puede usar', () => {
    expect(canUseEditorialTools('admin')).toBe(true);
  });
  it('operador → puede usar', () => {
    expect(canUseEditorialTools('operador')).toBe(true);
  });
  it('editor → puede usar', () => {
    expect(canUseEditorialTools('editor')).toBe(true);
  });
  it('lector → puede usar', () => {
    expect(canUseEditorialTools('lector')).toBe(true);
  });
  it('cliente → NO puede usar (único rol restringido)', () => {
    expect(canUseEditorialTools('cliente')).toBe(false);
  });
  it('null → puede usar (conservar comportamiento previo)', () => {
    expect(canUseEditorialTools(null)).toBe(true);
  });
});

describe('CL2_EDITORIAL_TOOLS — set de tools restringidas', () => {
  it('contiene exactamente las 4 tools editoriales con marca CL2', () => {
    expect(CL2_EDITORIAL_TOOLS).toEqual(new Set([
      'generate_presentation',
      'generate_docx',
      'generate_asset',
      'edit_asset_slide',
    ]));
  });

  it('NO incluye tools de retrieval/búsqueda', () => {
    for (const t of ['search_transcripts', 'search_sil_expedientes', 'get_sil_expediente', 'search_reglamento']) {
      expect(CL2_EDITORIAL_TOOLS.has(t)).toBe(false);
    }
  });
});

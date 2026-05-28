-- 0052_user_access_cliente_role.sql
--
-- Agrega 'cliente' al CHECK constraint de user_access.role (Ronald F1).
--
-- ─── PROBLEMA ────────────────────────────────────────────────────────────
-- El cliente CL2 (Ronald Alpízar) pidió un tercer rol "cliente" que cubre
-- a los usuarios FINALES de las instituciones que él asesora — FEDEFARMA,
-- ICT, etc. Estos usuarios pueden:
--   - chatear con Lexa/Atlas
--   - navegar expedientes SIL, sesiones, hojas
--   - recibir alertas Centinela
-- Pero NO pueden:
--   - invocar tools editoriales con marca CL2 (generate_presentation,
--     generate_docx, generate_asset, edit_asset_slide)
--   - acceder al panel /admin
--
-- El check actual permite solo: lector, editor, operador, admin.
-- Hay que agregar 'cliente' sin tocar los otros valores.
--
-- ─── SOLUCIÓN ────────────────────────────────────────────────────────────
-- DROP CONSTRAINT + ADD CONSTRAINT en una transacción.
-- Compatible con cualquier row existente (todas ya tienen role válido).
-- Idempotente: si 'cliente' ya está, el ADD CONSTRAINT lo refleja sin
-- pérdida de datos.

begin;

alter table user_access
  drop constraint if exists user_access_role_check;

alter table user_access
  add constraint user_access_role_check
    check (role is null or role = any (array['lector', 'editor', 'operador', 'admin', 'cliente']));

commit;

-- Verificación (no es DDL — se loguea):
--   select unnest(array['lector','editor','operador','admin','cliente']) as role;
--   → debe listar 5 roles.

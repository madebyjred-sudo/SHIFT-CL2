-- shift-cl2 — Extend podcasts.source_type to cover Hojas integration.
--
-- A1 of docs/PODCASTS-HOJAS-INTEGRATION.md: workspaces (boards) and
-- their nodes can now be the source of a podcast. The worker's
-- loadSource() switch grew two branches; the constraint here gets the
-- two new values.
--
-- We don't add a separate `hoja_podcasts` linking table yet — for now
-- we just filter `podcasts` by source_type+source_id when listing
-- per-workspace audio. Add the linking table when multi-attach
-- semantics matter (see PODCASTS-HOJAS-INTEGRATION.md §"Decisión").

alter table podcasts drop constraint if exists podcasts_source_type_check;
alter table podcasts add constraint podcasts_source_type_check
  check (source_type in ('sesion','expediente','chat','hoja_workspace','hoja_node'));

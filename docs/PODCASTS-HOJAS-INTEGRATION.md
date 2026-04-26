# Podcasts ↔ Hojas (Board notas) — integration plan

Status: design only, no code.
Author: 2026-04-26
Audience: future PR authors and reviewers.

## Why integrate

Hojas is the canvas where the user **builds research** — drag chunks
of SIL, drop Lexa replies, write their own notes. Podcasts (P1+P2)
turn arbitrary inputs into narrated audio. The combination unlocks
two flows that are hard to copy:

1. **Canvas → audio briefing.** Generate a 3-5 min narrated summary of
   everything on a Hoja workspace. The user leaves the office, listens
   on the way home, arrives ready to write the brief.
2. **Per-node listen.** Each node (cite, expediente_ref, freeform note)
   gets a "listen" affordance. A jefa de despacho who isn't going to
   sit and read the dictamen del expediente 24.018 will press play and
   get it summarized in 90 seconds.

These map cleanly to two existing primitives:

- The **Lexa Arquitecta** pattern (multi-hoja generation from a single
  prompt) → mirror it for audio. "Architect this canvas as a podcast."
- The **node detail panel** (already wired for content edits) → add a
  podcast tab.

## Concrete model

### New table: `hoja_podcasts`

Migration `0013_hoja_podcasts.sql` (NOT IMPLEMENTED YET):

```sql
create table hoja_podcasts (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  -- nullable: a workspace-level podcast attaches to NO node.
  node_id         uuid references workspace_nodes(id) on delete cascade,
  -- denormalized FK to podcasts(id) — keeps the audio asset + status
  -- in one place; deletion of the podcast cascades to remove the link.
  podcast_id      uuid not null references podcasts(id) on delete cascade,
  position        text check (position in ('header','sidebar','inline')) default 'sidebar',
  pinned          boolean default false,
  created_at      timestamptz default now()
);
create index hoja_podcasts_workspace on hoja_podcasts(workspace_id);
create index hoja_podcasts_node      on hoja_podcasts(node_id) where node_id is not null;
```

RLS: piggyback on the workspace row's existing owner check.

### Reuse `podcasts.source_type`

Add `'hoja_workspace'` and `'hoja_node'` to the existing
`source_type` check constraint in `0012_podcasts.sql`. The worker's
`loadSource()` switch gets two new branches:

- `hoja_workspace` → assemble all nodes' content (markdown bodies of
  `type='hoja'` + titles of `type='cite' / 'expediente_ref'`) in
  z-order, prepend the workspace title.
- `hoja_node` → load a single node's content; for `'cite' /
  'expediente_ref'` follow the FK to load the actual chunk / expediente
  detail.

This way we don't fork the worker — same script gen, same TTS, same
storage.

## UX surfaces

### 1. Workspace header — "Generar podcast del board"

Right side of the Hoja toolbar, next to "Lexa Arquitecta". Same
PodcastModal opens with `source_type='hoja_workspace'` and
`source_id=workspaceId`. Result is auto-attached to the workspace
(`hoja_podcasts` row with `node_id=null`, `position='header'`).

The workspace header shows a thin audio player strip when at least
one workspace-level podcast exists. Click the title in the strip to
open the audio in a popover.

### 2. Node detail panel — "Podcast" tab

When a node is selected, the detail panel already has tabs for
content / metadata. Add **Podcast**:

- If no podcast attached: "Generar podcast" button → modal with
  `source_type='hoja_node'` and `source_id=nodeId`.
- If attached: inline player + "Regenerar".

### 3. Canvas-level "now playing" affordance (P3+)

When the user starts playback on any podcast, a persistent floating
mini-player attaches to the bottom-right corner of the canvas. They
can keep dragging nodes, opening Lexa, etc. while listening.

## Why NOT just a separate page

Two reasons. First: the value is **contextual**. A standalone
"podcasts" page would feel like an afterthought; embedded in Hojas it
becomes part of the research loop. Second: workspaces already carry
the **scope** (which expedientes, which sessions, which lineamientos
the user cares about). Generating a podcast from the workspace inherits
that scope without making the user re-pick.

## Phasing

- **A1 (1 day)** — schema migration + extend `loadSource()` + add
  workspace-level header button. Audio player strip in the header.
- **A2 (1 day)** — node detail panel "Podcast" tab.
- **A3 (0.5 day)** — floating mini-player + multi-podcast queue
  (listen to several nodes back-to-back).

Cost ceiling stays the same: 5 podcasts/user/day, char caps in script
gen. Generating from a 6-hoja workspace doesn't blow the budget because
the script gen itself caps total chars before TTS.

## Open questions

1. **Workspace updates → re-gen?** When the user changes the canvas,
   the existing podcast becomes stale. Show a "stale" badge on the
   header strip; do NOT auto-regenerate (cost + UX surprise).
2. **Per-node inheritance.** If a node is regenerated and was attached
   to the workspace podcast as a source, do we surface a "this section
   of the podcast may be outdated" hint? Probably overkill for v1.
3. **Lexa Arquitecta-style "podcast plan."** Could we have Lexa
   propose the podcast structure ("90s on the dictamen, 60s on the
   votación, 30s on what to do Monday") and let the user reorder
   chapters before TTS runs? Nice-to-have. Out of scope until the
   single-shot version proves itself.

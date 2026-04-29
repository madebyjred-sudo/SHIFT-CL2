# Atlas `generate_presentation` tool — chat dispatcher pending

**Status:** YAML declared, code dispatcher pending. Tool will be invisible to the agent runtime until wired.

## What's done

- `packages/cerebro-config/agents/atlas.yaml` lists the tool with full description so the agent's system prompt mentions it. This is the same pattern `workspace_build_nodes` and `workspace_edit_node` follow — declared in YAML, dispatched elsewhere.
- Backend endpoint `POST /api/workspace/:id/export` with `format: 'pptx'` already exists, cache-aware, returns `{gammaUrl, exportUrl, generationId, cached, generatedAt}`.

## What's missing

The Cerebro/OpenRouter tool calling pipeline needs to:

1. **Register the tool schema** in `apps/api/src/services/openRouterClient.ts` next to `SEARCH_SIL_EXPEDIENTES_TOOL` etc. Schema:
   ```ts
   const GENERATE_PRESENTATION_TOOL = {
     type: 'function',
     function: {
       name: 'generate_presentation',
       description: '... (copy from atlas.yaml)',
       parameters: {
         type: 'object',
         properties: {
           workspace_id: { type: 'string', format: 'uuid' },
           force: { type: 'boolean', default: false },
         },
         required: ['workspace_id'],
       },
     },
   };
   ```

2. **Conditionally register** when the agent has the tool (mirroring `hasSilTools(agent.tools)` pattern in the same file).

3. **Dispatch** the tool call:
   - Tool args arrive in the OpenRouter response stream as a `tool_calls` chunk.
   - Pass `workspace_id` to `POST /api/workspace/:id/export` internally (or refactor the export logic into a callable function so we don't make an HTTP loop).
   - Stream a status event to the chat surface: "Generando con Gamma…"
   - When the export resolves, emit a structured event the chat UI renders as a card with the same two CTAs as `PptxResultModal`.

4. **Frontend chat integration:**
   - Detect the `pptx_ready` event in the chat stream.
   - Render a `PptxChatCard` component (variant of `PptxResultModal` inline in the conversation) with the gammaUrl + exportUrl buttons.
   - Optionally also pop the modal automatically the first time.

## Estimated effort

~2-3 hours including:
- 30min schema + register
- 1h dispatcher wiring (handle async tool result, stream back)
- 1h frontend chat card rendering
- 30min tests + manual verification

## Why deferred

The user-facing UX win (modal, cache, no popup blocks) lands in this commit and is the bulk of the value. Chat trigger is a "nice to have" that requires plumbing through the OpenRouter tool-calling stream — meaningful effort, low marginal value vs the export menu CTA which is already prominent.

## Pickup checklist

- [ ] Schema in `openRouterClient.ts`
- [ ] Conditional registration on agent.tools
- [ ] Backend dispatcher (probably new file `apps/api/src/services/toolDispatchers/generatePresentation.ts`)
- [ ] Streaming event protocol — define `pptx_status` and `pptx_ready` events
- [ ] Frontend stream consumer to surface card
- [ ] Manual test: "Atlas, hacé una presentación de este workspace" → card appears in chat
- [ ] Verify cache reuse flows through chat trigger too

## Reference

The user feedback that motivated this:
> "creo que también deberíamos poder disparar eso vía Chat es decir que si nosotros lo le decimos ayuda a sacar una presentación con eso lo haga sin necesidad de que me diga ay échate el botón sino que lo él lo haga el pitch el botón"

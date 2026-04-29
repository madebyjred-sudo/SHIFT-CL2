# Vercel Cron Worker — parked 2026-04-29

**Status:** repo creado, código listo, type-check ✓, deploy a Vercel pausado por decisión del operador.

**Picking it up later:** todo lo necesario está acá. Estimado para terminar el deploy: 15-20 min.

## Por qué se hizo

YouTube flaggea las IPs egress de Cloud Run en su endpoint de timed-text. El pipeline `transcript-process` corriendo en Cloud Run devuelve `no_transcript_available` para todos los videos, aunque las captions existan. Mismo código corriendo desde IP residencial baja transcripts sin problema.

**Workaround actual (válido para el demo):** drainer local `scripts/drain-pending-local.ts`.

**Solución definitiva (este worker):** mover el processing a Vercel, que asigna IPs no flaggeadas.

## Estado del repo

- **GitHub:** https://github.com/madebyjred-sudo/CRONCL2VRCL
- **Local path:** `/Users/juan/Downloads/cl2-cron-worker/`
- **Branch:** `main`, único commit `initial: Vercel cron worker for CL2 transcript draining`

## Estructura

```
cl2-cron-worker/
├── api/cron/drain-pending.ts    180 líneas — Vercel function entrypoint
├── lib/
│   ├── transcriptProcess.ts     761 líneas — vendored, mentions stubeada
│   ├── youtubeTranscript.ts     322 líneas — vendored
│   ├── resilience.ts             94 líneas — vendored
│   └── logger.ts                 57 líneas — vendored
├── package.json
├── tsconfig.json
├── vercel.json                   crons: */30 * * * *, maxDuration 300s
└── README.md                     guía de deploy paso a paso
```

## Lo que falta para terminar (5 pasos)

1. **Importar el repo a Vercel** desde https://vercel.com/new (Framework: Other)
2. **Setear 5 env vars** en Settings → Environment Variables:
   - `SUPABASE_URL` (= `NEXT_PUBLIC_SUPABASE_URL` de `shift-cl2/.env.local`)
   - `SUPABASE_SERVICE_ROLE_KEY` (= `SUPABASE_SERVICE_ROLE_KEY` de `.env.local`)
   - `OPENROUTER_API_KEY` (= `OPENROUTER_API_KEY` de `.env.local`)
   - `CRON_SECRET` (generar con `openssl rand -hex 32`)
   - `LOG_LEVEL=info`
3. **Redeploy** (Vercel no auto-redeploya tras setear env vars)
4. **Test manual** desde tab Crons → Run Now → verificar log `cron_drain_complete`
5. **Confirmar schedule:** debería verse `*/30 * * * *` next to la función

## Decisiones que ya están tomadas

- **Mentions scan stubeado** en el worker (ahorra 489 líneas vendored). Plan post-MVP: cron en Cloud Run que corra `scanSessionForMentions` retroactivamente sobre lo indexado.
- **Vendoring por encima de monorepo:** acepted la duplicación porque dar acceso al repo `shift-cl2` a Vercel agrega fricción. Si crece, migrar a monorepo workspace.
- **Sequential processing con throttle de 1.5s** entre sesiones: previene flag-by-burst.
- **`limit=4` por invocación:** 4 × 60s = 240s, headroom dentro del cap de 300s de Vercel Pro.
- **Plan Vercel Pro:** ya pagado por el operador. Crons hasta 40 jobs incluido. Function executions ~1.4k/mes (<0.2% del cap).

## Costo total estimado

| Item | Costo |
|---|---|
| Vercel Pro | $0 marginal (ya pagado) |
| OpenRouter Sonnet 4.6 | ~$5/mes (30 sesiones/día × $0.005) |
| Supabase egress | $0 (~50KB/sesión, free tier sobra) |
| **Total marginal** | **~$5/mes** |

## Drift management

Si arreglás un bug en `apps/api/src/jobs/transcriptProcess.ts` del repo principal, hay que **manualmente** copiar el cambio a `cl2-cron-worker/lib/transcriptProcess.ts`. No hay sync automático.

Cuando llegue el momento de unificar:
- **Opción A:** publicar paquete privado en npm con la lógica compartida.
- **Opción B:** mover el worker como tercer workspace en `shift-cl2/` y deployar con Vercel desde subdirectorio (Vercel soporta `rootDirectory: apps/cron-worker`).

Ambas son ~½ día de trabajo. Para el demo aceptamos la duplicación.

## Cuando volvás a esto

```bash
# 1. Clonar el worker (si no lo tenés local)
cd ~/Downloads
git clone https://github.com/madebyjred-sudo/CRONCL2VRCL.git cl2-cron-worker
cd cl2-cron-worker

# 2. Instalar deps + verificar que sigue compilando
npm install
npx tsc --noEmit

# 3. Si hubo cambios upstream (apps/api/src/jobs/transcriptProcess.ts), re-vendorá:
cp ~/Downloads/shift-cl2/apps/api/src/jobs/transcriptProcess.ts lib/
cp ~/Downloads/shift-cl2/apps/api/src/services/youtubeTranscript.ts lib/
cp ~/Downloads/shift-cl2/apps/api/src/services/resilience.ts lib/
cp ~/Downloads/shift-cl2/apps/api/src/services/logger.ts lib/

# 4. Re-aplicar los 2 cambios locales (imports relativos + mentions stub)
# Ver el commit inicial para el diff exacto.

# 5. git push y seguir con los pasos 1-5 del README.md
```

## Referencias cruzadas

- Spec original: `docs/specs/2026-04-28-youtube-transcript-pipeline.md` §6 "Cloud Run egress IP rate-limited por YouTube"
- Drainer local equivalente: `scripts/drain-pending-local.ts`
- Endpoint Cloud Run que el worker reemplaza: `POST /api/internal/process-pending` en `apps/api/src/routes/transcripts.ts`

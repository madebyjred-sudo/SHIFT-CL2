#!/usr/bin/env python3
"""
backfill-enricher-orchestrator.py

Orquesta el endpoint `/api/internal/centinela/sil-enrich` en batches para
que los ~21k expedientes pasen por el enricher SIL sin tener que
re-activar el cron paused.

Qué llena el enricher (por expediente):
  - sil_expediente_audiencias       (parseado del grvConvocatoria del SIL)
  - sil_expediente_tramite          (timeline de tramitación)
  - sil_expediente_orden_dia_apariciones
  - sil_expediente_actas_indexadas  (cross-match con sharepoint_raw)
  - sil_expediente_fechas_extraidas (cuatrienal + ordinario del grid)
  - sil_expediente_proponentes      (firmantes con orden de firma)

Lo que NO llena (otras fuentes):
  - sil_expediente_consultas        (consultas a entidades, requiere otro scraper)
  - sil_expediente_consultas_sala   (Sala IV, requiere scraper Sala Constitucional)
  - sil_documentos.fecha_dictamen_estimada (necesita extractor de texto)
  - lista_despacho_items            (otro crawler)
  - centinela_eventos               (cron noveltyScan)

Estrategia:
  El endpoint recibe `{ limit, min_id }` y procesa hasta `limit` expedientes
  con id >= min_id que NO estén ya enriquecidos. Idempotente. Devolvemos
  enriched=0 cuando no hay más targets.

Uso:
  python3 scripts/backfill-enricher-orchestrator.py            # full run
  python3 scripts/backfill-enricher-orchestrator.py --limit 50 # limite por batch
  python3 scripts/backfill-enricher-orchestrator.py --max-batches 10  # dry-test
"""

import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import datetime

API_BASE = "https://cl2-v2-api-u3rliii7wa-uc.a.run.app"
ENDPOINT = "/api/internal/centinela/sil-enrich"

# Token interno — lo trae el script del env (lo seteamos al correr)
INTERNAL_TOKEN = os.environ.get("INTERNAL_TRIGGER_SECRET")
if not INTERNAL_TOKEN:
    print("ERROR: INTERNAL_TRIGGER_SECRET no está set en env", file=sys.stderr)
    print("       Hint: lo extrae de Cloud Run cl2-v2-api env vars", file=sys.stderr)
    sys.exit(1)


def call_enrich(limit: int, min_id: int, timeout: int = 1800) -> dict:
    """POST al endpoint; devuelve el JSON parseado."""
    req = urllib.request.Request(
        f"{API_BASE}{ENDPOINT}",
        data=json.dumps({"limit": limit, "min_id": min_id}).encode(),
        headers={
            "X-Internal-Trigger": INTERNAL_TOKEN,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=200, help="batch size (max 200)")
    ap.add_argument("--min-id", type=int, default=0, help="empezar desde este id (0 = todos)")
    ap.add_argument("--max-batches", type=int, default=200, help="cap defensivo")
    ap.add_argument("--delay", type=float, default=2.0, help="segundos entre batches")
    args = ap.parse_args()

    print(f"Backfill enricher orchestrator — {datetime.now().isoformat()}")
    print(f"  endpoint: {API_BASE}{ENDPOINT}")
    print(f"  batch limit: {args.limit}")
    print(f"  starting min_id: {args.min_id}")
    print(f"  max batches: {args.max_batches}")
    print(f"  inter-batch delay: {args.delay}s\n")

    total_enriched = 0
    total_failed = 0
    total_not_found = 0
    total_no_props = 0
    consecutive_zero = 0
    start_ts = time.time()

    for batch_idx in range(1, args.max_batches + 1):
        batch_ts = time.time()
        try:
            result = call_enrich(args.limit, args.min_id)
        except Exception as e:
            print(f"  batch {batch_idx} FAILED: {type(e).__name__}: {str(e)[:150]}", file=sys.stderr)
            time.sleep(30)  # backoff on failure
            continue

        r = result.get("result", {})
        enriched = r.get("enriched", 0)
        not_found = r.get("not_found", 0)
        failed = r.get("failed", 0)
        no_props = r.get("no_proponentes", 0)
        processed = result.get("processed", 0)
        msg = r.get("message", "")

        total_enriched += enriched
        total_failed += failed
        total_not_found += not_found
        total_no_props += no_props

        elapsed_batch = time.time() - batch_ts
        elapsed_total = time.time() - start_ts

        print(f"  batch {batch_idx:>3}: enriched={enriched:>3} not_found={not_found:>2} failed={failed:>2} no_props={no_props:>2} | batch={elapsed_batch:.0f}s | total={elapsed_total/60:.1f}min | cum_enriched={total_enriched}")
        if msg:
            print(f"    msg: {msg}")

        # Terminamos si hay 2 batches seguidos con 0 enriquecidos
        # (significa que ya cubrimos todo lo que se puede)
        if processed == 0:
            consecutive_zero += 1
            if consecutive_zero >= 2:
                print(f"\n  2 batches consecutivos sin progreso — terminamos. Total enriched: {total_enriched}")
                break
        else:
            consecutive_zero = 0

        time.sleep(args.delay)

    elapsed = time.time() - start_ts
    print(f"\n=== Resumen ===")
    print(f"  Total enriched: {total_enriched}")
    print(f"  Total not_found: {total_not_found}")
    print(f"  Total failed: {total_failed}")
    print(f"  Total no_proponentes: {total_no_props}")
    print(f"  Wall time: {elapsed/60:.1f}min")


if __name__ == "__main__":
    main()

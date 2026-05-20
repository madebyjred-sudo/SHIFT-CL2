#!/usr/bin/env python3
"""
backfill-fechas-dictamen-orchestrator.py

Orquesta el endpoint POST /api/internal/centinela/extract-fechas-dictamen
en batches para que los ~22k documentos del SIL pasen por el extractor de
"fecha estimada de dictamen" (Pedido 07/16g/16h del cliente CL2).

Lo que hace el job (por documento):
  1. extractPrimaryFechaDictamen(text_extracted) → candidato top
  2. Si cambió respecto a la vigente: marcar la previa como superseded_by
     la nueva, e insertar la nueva (Pedido 16h — historial)
  3. Si no hay match, marcar el doc con metadata.fecha_dictamen_attempted
     para no re-procesar

Idempotente: re-correr no genera dupes. Para forzar re-extracción de
docs ya intentados, pasar --force.

Uso:
  python3 scripts/backfill-fechas-dictamen-orchestrator.py
  python3 scripts/backfill-fechas-dictamen-orchestrator.py --limit 500 --max-batches 100
  python3 scripts/backfill-fechas-dictamen-orchestrator.py --force --limit 200

Performance: ~100ms por doc en server (regex puro). Esperamos
22k docs / 500 per batch * (timeout per batch ~5-10min) ≈ 30-60min.
"""

import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import datetime

API_BASE = "https://cl2-v2-api-u3rliii7wa-uc.a.run.app"
ENDPOINT = "/api/internal/centinela/extract-fechas-dictamen"

INTERNAL_TOKEN = os.environ.get("INTERNAL_TRIGGER_SECRET")
if not INTERNAL_TOKEN:
    print("ERROR: INTERNAL_TRIGGER_SECRET no está en env", file=sys.stderr)
    print("       Sourcear con: source infra/deploy/.env.production", file=sys.stderr)
    sys.exit(1)


def call_extract(limit: int, force: bool, since: str | None, timeout: int = 900) -> dict:
    body = {"limit": limit, "force_reextract": force}
    if since:
        body["since"] = since
    req = urllib.request.Request(
        f"{API_BASE}{ENDPOINT}",
        data=json.dumps(body).encode(),
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
    ap.add_argument("--limit", type=int, default=500, help="docs por batch (max 2000)")
    ap.add_argument("--max-batches", type=int, default=80, help="cap defensivo")
    ap.add_argument("--delay", type=float, default=3.0, help="segundos entre batches")
    ap.add_argument("--force", action="store_true", help="re-procesar docs ya intentados")
    ap.add_argument("--since", default=None, help="ISO date — solo docs creados después")
    args = ap.parse_args()

    print(f"Backfill fechas dictamen orchestrator — {datetime.now().isoformat()}")
    print(f"  endpoint: {API_BASE}{ENDPOINT}")
    print(f"  batch limit: {args.limit}")
    print(f"  max batches: {args.max_batches}")
    print(f"  force_reextract: {args.force}")
    print(f"  inter-batch delay: {args.delay}s\n")

    total = {"processed": 0, "inserted": 0, "superseded": 0,
             "unchanged": 0, "no_match": 0, "no_text": 0,
             "no_expediente": 0, "failed": 0}
    consecutive_zero = 0
    start_ts = time.time()

    for batch_idx in range(1, args.max_batches + 1):
        batch_ts = time.time()
        try:
            result = call_extract(args.limit, args.force, args.since)
        except Exception as e:
            print(f"  batch {batch_idx} FAILED: {type(e).__name__}: {str(e)[:150]}", file=sys.stderr)
            time.sleep(30)
            continue

        r = result.get("result", {})
        processed = r.get("processed", 0)
        for k in total.keys():
            total[k] += r.get(k, 0)

        elapsed_batch = time.time() - batch_ts
        elapsed_total = time.time() - start_ts

        print(
            f"  batch {batch_idx:>3}: processed={processed:>3} ins={r.get('inserted',0):>2} "
            f"sup={r.get('superseded',0):>2} unch={r.get('unchanged',0):>2} "
            f"nm={r.get('no_match',0):>3} nt={r.get('no_text',0):>2} "
            f"fail={r.get('failed',0):>2} | {elapsed_batch:.0f}s | total={elapsed_total/60:.1f}min "
            f"| cum_ins={total['inserted']}"
        )

        # Si el endpoint no procesó nada, asumimos que ya cubrimos todo.
        if processed == 0:
            consecutive_zero += 1
            if consecutive_zero >= 2:
                print(f"\n  2 batches consecutivos sin progreso — terminamos.")
                break
        else:
            consecutive_zero = 0

        time.sleep(args.delay)

    elapsed = time.time() - start_ts
    print(f"\n=== Resumen ===")
    print(f"  Total processed:   {total['processed']}")
    print(f"  Total inserted:    {total['inserted']}")
    print(f"  Total superseded:  {total['superseded']}")
    print(f"  Total unchanged:   {total['unchanged']}")
    print(f"  Total no_match:    {total['no_match']}")
    print(f"  Total no_text:     {total['no_text']}")
    print(f"  Total failed:      {total['failed']}")
    print(f"  Wall time:         {elapsed/60:.1f}min")


if __name__ == "__main__":
    main()

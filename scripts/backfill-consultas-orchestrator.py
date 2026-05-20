#!/usr/bin/env python3
"""
backfill-consultas-orchestrator.py

Orquesta el endpoint /api/internal/centinela/sil-enrich con flag
`re_enrich_for_consultas: true` en batches. Sirve para backfillear
Pedidos P04 (consultas) y P16k (texto sustitutivo) sobre los ~3.5k
expedientes que fueron enriched ANTES del deploy del parser nuevo
(2026-05-20 13:38 CR, revision cl2-v2-api-00116-nnc).

Por qué este script existe (separado del orchestrator default):
  - El endpoint default filtra a "expedientes SIN proponentes" — modo
    backfill inicial. Eso skipea los ~3.5k ya enriched.
  - El flag `re_enrich_for_consultas: true` invierte: targetea
    expedientes que SÍ tienen proponentes pero NO tienen consultas.
  - El enricher es idempotente (DELETE+INSERT en todas las tablas
    auxiliares) así que re-correrlo no rompe nada.

Estrategia recomendada:
  1. Esperar a que termine el backfill inicial (Ola 1) — orchestrator
     default. ETA ~6h desde 2026-05-20 14:15 CR.
  2. Correr este script: ~3.5k expedientes × ~3s por expediente
     (1 fetch SIL + 7-8 inserts DB) ≈ 3h.

Uso:
  python3 scripts/backfill-consultas-orchestrator.py
  python3 scripts/backfill-consultas-orchestrator.py --limit 200 --delay 1
  python3 scripts/backfill-consultas-orchestrator.py --max-batches 50

NOTA: cuando el endpoint devuelve `enriched=0` por 2 batches seguidos
(0 expedientes para procesar), termina automáticamente.
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

INTERNAL_TOKEN = os.environ.get("INTERNAL_TRIGGER_SECRET")
if not INTERNAL_TOKEN:
    print("ERROR: INTERNAL_TRIGGER_SECRET no está set en env", file=sys.stderr)
    print("       Sourcear con: source infra/deploy/.env.production", file=sys.stderr)
    sys.exit(1)


def call_enrich(limit: int, min_id: int, timeout: int = 1800) -> dict:
    """POST al endpoint con flag re_enrich_for_consultas=true."""
    req = urllib.request.Request(
        f"{API_BASE}{ENDPOINT}",
        data=json.dumps({
            "limit": limit,
            "min_id": min_id,
            "re_enrich_for_consultas": True,
        }).encode(),
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
    ap.add_argument("--limit", type=int, default=100, help="expedientes por batch (max 200)")
    ap.add_argument("--min-id", type=int, default=0, help="solo expedientes con id >= min_id")
    ap.add_argument("--max-batches", type=int, default=80, help="cap defensivo")
    ap.add_argument("--delay", type=float, default=2.0, help="segundos entre batches")
    args = ap.parse_args()

    print(f"Backfill CONSULTAS (P04+P16k) — {datetime.now().isoformat()}")
    print(f"  endpoint: {API_BASE}{ENDPOINT}")
    print(f"  mode: re_enrich_for_consultas")
    print(f"  batch limit: {args.limit}")
    print(f"  starting min_id: {args.min_id}")
    print(f"  max batches: {args.max_batches}")
    print(f"  inter-batch delay: {args.delay}s\n")

    total_enriched = 0
    total_failed = 0
    consecutive_zero = 0
    start_ts = time.time()

    for batch_idx in range(1, args.max_batches + 1):
        batch_ts = time.time()
        try:
            result = call_enrich(args.limit, args.min_id)
        except Exception as e:
            print(f"  batch {batch_idx} FAILED: {type(e).__name__}: {str(e)[:150]}", file=sys.stderr)
            time.sleep(30)
            continue

        r = result.get("result", {})
        enriched = r.get("enriched", 0)
        failed = r.get("failed", 0)
        processed = result.get("processed", 0)
        msg = r.get("message", "")

        total_enriched += enriched
        total_failed += failed

        elapsed_batch = time.time() - batch_ts
        elapsed_total = time.time() - start_ts

        print(
            f"  batch {batch_idx:>3}: processed={processed:>3} enriched={enriched:>3} "
            f"failed={failed:>2} | {elapsed_batch:.0f}s | total={elapsed_total/60:.1f}min "
            f"| cum_enriched={total_enriched}"
        )
        if msg:
            print(f"    msg: {msg}")

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
    print(f"  Total re-enriched: {total_enriched}")
    print(f"  Total failed: {total_failed}")
    print(f"  Wall time: {elapsed/60:.1f}min")


if __name__ == "__main__":
    main()

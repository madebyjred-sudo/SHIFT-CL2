#!/usr/bin/env python3
"""
backfill-bold-fechas-orchestrator.py

Orquesta el endpoint /api/internal/centinela/detect-bold-fechas en
batches. Para cada fila de sil_expediente_fechas_extraidas con
campo='fecha_dictamen_estimada' y visual_marker='plain', intenta
fetch del DOCX original desde GCS, busca <strong> que contenga la
fecha, y si encuentra, marca visual_marker='bold'.

Pedido 16g del cliente CL2 (Carlos): "Ahí tenés en ese 24982 en
negrita, fecha para dictaminar."

Performance: ~2-3 segundos por fila (fetch GCS ~1-3MB + mammoth parse
+ cheerio scan). Concurrency 3 en server-side. Esperamos ~30s por
batch de 200 rows.

Uso:
  python3 scripts/backfill-bold-fechas-orchestrator.py
  python3 scripts/backfill-bold-fechas-orchestrator.py --limit 100 --max-batches 30
  python3 scripts/backfill-bold-fechas-orchestrator.py --force  # re-checa rows bold

Correr DESPUÉS del backfill-fechas-dictamen — no tiene sentido
buscar bold para fechas que no existen aún.
"""

import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import datetime

API_BASE = "https://cl2-v2-api-u3rliii7wa-uc.a.run.app"
ENDPOINT = "/api/internal/centinela/detect-bold-fechas"

INTERNAL_TOKEN = os.environ.get("INTERNAL_TRIGGER_SECRET")
if not INTERNAL_TOKEN:
    print("ERROR: INTERNAL_TRIGGER_SECRET no está set en env", file=sys.stderr)
    sys.exit(1)


def call_detect(limit: int, force: bool, timeout: int = 900) -> dict:
    body = {"limit": limit, "force_recheck": force}
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
    ap.add_argument("--limit", type=int, default=200, help="rows por batch")
    ap.add_argument("--max-batches", type=int, default=30, help="cap defensivo")
    ap.add_argument("--delay", type=float, default=3.0, help="segundos entre batches")
    ap.add_argument("--force", action="store_true", help="re-checa rows ya 'bold'")
    args = ap.parse_args()

    print(f"Backfill BOLD fechas (P16g) — {datetime.now().isoformat()}")
    print(f"  endpoint: {API_BASE}{ENDPOINT}")
    print(f"  batch limit: {args.limit}")
    print(f"  max batches: {args.max_batches}")
    print(f"  force_recheck: {args.force}\n")

    total = {"examined": 0, "bold_marked": 0, "no_bold": 0,
             "no_doc_found": 0, "failed": 0}
    consecutive_zero = 0
    start_ts = time.time()

    for batch_idx in range(1, args.max_batches + 1):
        batch_ts = time.time()
        try:
            result = call_detect(args.limit, args.force)
        except Exception as e:
            print(f"  batch {batch_idx} FAILED: {type(e).__name__}: {str(e)[:150]}", file=sys.stderr)
            time.sleep(30)
            continue

        r = result.get("result", {})
        examined = r.get("examined", 0)
        for k in total:
            total[k] += r.get(k, 0)

        elapsed_batch = time.time() - batch_ts
        elapsed_total = time.time() - start_ts

        print(
            f"  batch {batch_idx:>2}: examined={examined:>3} "
            f"bold={r.get('bold_marked',0):>2} "
            f"no_bold={r.get('no_bold',0):>2} "
            f"no_doc={r.get('no_doc_found',0):>2} "
            f"fail={r.get('failed',0):>2} "
            f"| {elapsed_batch:.0f}s | total={elapsed_total/60:.1f}min "
            f"| cum_bold={total['bold_marked']}"
        )

        if examined == 0:
            consecutive_zero += 1
            if consecutive_zero >= 2:
                print(f"\n  2 batches consecutivos sin progreso — terminamos.")
                break
        else:
            consecutive_zero = 0

        time.sleep(args.delay)

    elapsed = time.time() - start_ts
    print(f"\n=== Resumen ===")
    print(f"  Total examined:    {total['examined']}")
    print(f"  Total bold marked: {total['bold_marked']}")
    print(f"  Total no_bold:     {total['no_bold']}")
    print(f"  Total no_doc:      {total['no_doc_found']}")
    print(f"  Total failed:      {total['failed']}")
    print(f"  Wall time:         {elapsed/60:.1f}min")


if __name__ == "__main__":
    main()

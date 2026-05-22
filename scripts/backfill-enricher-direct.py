#!/usr/bin/env python3
"""
backfill-enricher-direct.py

Bypass endpoint paginación. Hace SQL directo a Supabase Management API
para encontrar expedientes sin tramite, los manda explícitos al endpoint
en batches.

Uso:
  python3 scripts/backfill-enricher-direct.py
  python3 scripts/backfill-enricher-direct.py --batch 50 --delay 2

Workers paralelos compiten por los mismos targets — usa offset distribuido
para que no se pisen:
  Worker N (de M total): offset = N, take cada M-th expediente
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
SUPABASE_API = "https://api.supabase.com/v1/projects/romccykiucfltfdfatrx/database/query"

PAT = os.environ.get("SUPABASE_ACCESS_TOKEN")
INTERNAL_TOKEN = os.environ.get("INTERNAL_TRIGGER_SECRET")

if not PAT or not INTERNAL_TOKEN:
    print("ERROR: necesita SUPABASE_ACCESS_TOKEN + INTERNAL_TRIGGER_SECRET en env", file=sys.stderr)
    sys.exit(1)


def sql_query(query: str, timeout: int = 60) -> list:
    """Ejecuta SQL contra Supabase Management API."""
    req = urllib.request.Request(
        SUPABASE_API,
        data=json.dumps({"query": query}).encode(),
        headers={
            "Authorization": f"Bearer {PAT}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def fetch_pending(batch: int, worker_id: int, total_workers: int) -> list[str]:
    """Devuelve hasta `batch` expedientes sin tramite, distribuidos por worker.

    Si worker_id=2 y total_workers=6, toma cada 6° expediente empezando en offset 2.
    """
    # Take 4x batch to leave room para race conditions y filtros
    over_fetch = batch * total_workers * 3
    rows = sql_query(f"""
        SELECT e.numero
        FROM sil_expedientes e
        WHERE NOT EXISTS (
            SELECT 1 FROM sil_expediente_tramite t
            WHERE t.expediente_id = e.numero
        )
        ORDER BY e.id DESC
        LIMIT {over_fetch};
    """)
    # Distribuir: worker_id, worker_id + total_workers, worker_id + 2*total_workers, ...
    distributed = [r["numero"] for i, r in enumerate(rows) if i % total_workers == worker_id]
    return distributed[:batch]


def call_endpoint(numeros: list[str], timeout: int = 1800) -> dict:
    body = {"numeros": numeros, "limit": len(numeros)}
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
    ap.add_argument("--batch", type=int, default=50, help="expedientes por llamada")
    ap.add_argument("--delay", type=float, default=2.0, help="segundos entre batches")
    ap.add_argument("--max-batches", type=int, default=500, help="cap defensivo")
    ap.add_argument("--worker-id", type=int, default=0, help="ID de este worker (0-indexed)")
    ap.add_argument("--total-workers", type=int, default=1, help="total workers en paralelo")
    args = ap.parse_args()

    print(f"Direct enricher orchestrator — worker {args.worker_id+1}/{args.total_workers} — {datetime.now().isoformat()}")
    print(f"  batch: {args.batch}, delay: {args.delay}s, max_batches: {args.max_batches}\n")

    total_enriched = 0
    total_failed = 0
    consec_zero = 0
    start = time.time()

    for batch_idx in range(1, args.max_batches + 1):
        bt = time.time()
        try:
            numeros = fetch_pending(args.batch, args.worker_id, args.total_workers)
        except Exception as e:
            print(f"  batch {batch_idx} SQL FAIL: {e}", file=sys.stderr)
            time.sleep(30)
            continue

        if not numeros:
            consec_zero += 1
            print(f"  batch {batch_idx}: 0 targets — corpus completo o offset agotado")
            if consec_zero >= 3:
                print(f"\n  3 batches sin targets — TERMINAMOS")
                break
            time.sleep(args.delay * 3)
            continue
        consec_zero = 0

        try:
            result = call_endpoint(numeros)
        except Exception as e:
            print(f"  batch {batch_idx} ENDPOINT FAIL: {type(e).__name__}: {str(e)[:120]}", file=sys.stderr)
            time.sleep(30)
            continue

        r = result.get("result", {})
        enriched = r.get("enriched", 0)
        failed = r.get("failed", 0)
        no_props = r.get("no_proponentes", 0)
        not_found = r.get("not_found", 0)

        total_enriched += enriched
        total_failed += failed

        dt = time.time() - bt
        tt = time.time() - start
        print(
            f"  batch {batch_idx:>3}: sent={len(numeros):>3} "
            f"enriched={enriched:>3} not_found={not_found:>2} "
            f"failed={failed:>2} no_props={no_props:>2} "
            f"| {dt:.0f}s | total={tt/60:.1f}min | cum_enr={total_enriched}"
        )

        time.sleep(args.delay)

    elapsed = time.time() - start
    print(f"\n=== Worker {args.worker_id+1}/{args.total_workers} Resumen ===")
    print(f"  Total enriched: {total_enriched}")
    print(f"  Total failed: {total_failed}")
    print(f"  Wall time: {elapsed/60:.1f}min")


if __name__ == "__main__":
    main()

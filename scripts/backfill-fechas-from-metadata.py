#!/usr/bin/env python3
"""
backfill-fechas-from-metadata.py — Pedido 07 (28-pedidos).

Migra `sil_expedientes.metadata.vencimiento_*` (legacy scrape) a la tabla
canónica `sil_expediente_fechas_extraidas`. Después de esto los ~6.500
expedientes con metadata vencimientos pasan a verse en el panel
"Fechas estimadas" del frontend.

Por qué Python y no migration SQL:
  Los valores en metadata jsonb son strings tipo "30/04/2026" (formato
  CR DD/MM/YYYY), no fechas ISO. PostgreSQL puede parsearlos con
  TO_DATE() pero quería robusticidad para manejar formatos mixtos +
  log de cuáles fallan + idempotencia (UPSERT con dedup en
  (expediente_id, campo, extraction_method)).

Idempotente: borra rows previas con extraction_method='regex' del
expediente antes de insertar las nuevas. Re-correrlo no duplica.

Cobertura:
  Antes: 497 expedientes con fechas (~2%)
  Después: ~7000 expedientes con fechas (~32%)
  Sigue faltando: ~15k expedientes que ni siquiera tienen metadata
  vencimientos — necesitan SIL scraping vía silEnrichExpediente.

Uso:
  python3 scripts/backfill-fechas-from-metadata.py --dry-run
  python3 scripts/backfill-fechas-from-metadata.py
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, date

SUPA_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPA_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if not SUPA_URL or not SUPA_KEY:
    print("ERROR: env vars not set", file=sys.stderr)
    sys.exit(1)

REST = f"{SUPA_URL}/rest/v1"
H = {"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}", "Content-Type": "application/json"}


def parse_cr_date(s: str) -> str | None:
    """
    Parsea formatos comunes de fecha CR:
      - "30/04/2026" → "2026-04-30"
      - "30-04-2026" → "2026-04-30"
      - "2026-04-30" → "2026-04-30"
      - "2026/04/30" → "2026-04-30"
    Devuelve None si no se puede parsear.
    """
    if not s or not isinstance(s, str):
        return None
    s = s.strip()
    for sep in ('/', '-'):
        parts = s.split(sep)
        if len(parts) == 3:
            try:
                # Determinar si es DD/MM/YYYY o YYYY/MM/DD por longitud del primer token
                if len(parts[0]) == 4:
                    y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
                else:
                    d, m, y = int(parts[0]), int(parts[1]), int(parts[2])
                # Sanity check
                if 1990 <= y <= 2050 and 1 <= m <= 12 and 1 <= d <= 31:
                    return f"{y:04d}-{m:02d}-{d:02d}"
            except (ValueError, IndexError):
                continue
    return None


def http(method, path, body=None, headers_extra=None):
    url = f"{REST}/{path}"
    data = json.dumps(body).encode() if body is not None else None
    hh = {**H, **(headers_extra or {})}
    req = urllib.request.Request(url, data=data, headers=hh, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def fetch_all(path, page_size=1000):
    out = []
    start = 0
    while True:
        hh = {"Range-Unit": "items", "Range": f"{start}-{start + page_size - 1}"}
        status, body = http("GET", path, headers_extra=hh)
        if status not in (200, 206):
            raise RuntimeError(f"GET {path} failed {status}: {body[:200]}")
        rows = json.loads(body)
        if not rows:
            break
        out.extend(rows)
        if len(rows) < page_size:
            break
        start += page_size
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    print(f"Backfill iniciado {datetime.now().isoformat()}")
    print(f"  Dry-run: {args.dry_run}\n")

    # Pull expedientes con metadata vencimientos
    exps = fetch_all("sil_expedientes?select=numero,metadata&or=(metadata->>vencimiento_cuatrienal.not.is.null,metadata->>vencimiento_ordinario.not.is.null)")
    print(f"Expedientes con metadata vencimientos: {len(exps)}")

    # Construir las inserts
    rows_to_insert = []
    parse_failures = []
    for e in exps:
        numero = e["numero"]
        meta = e.get("metadata") or {}

        vc_raw = meta.get("vencimiento_cuatrienal")
        if vc_raw:
            vc_iso = parse_cr_date(vc_raw)
            if vc_iso:
                rows_to_insert.append({
                    "expediente_id": numero,
                    "campo": "fecha_cuatrienal",
                    "valor_fecha": vc_iso,
                    "valor_texto_original": f"Vencimiento Cuatrienal: {vc_raw}",
                    "fuente_documento_url": f"https://consultassil3.asamblea.go.cr/frmConsultaProyectos.aspx?expediente={numero.replace('.', '')}",
                    "fuente_pagina": None,
                    "extraction_method": "regex",
                    "extraction_confidence": 0.98,
                    "visual_marker": "plain",
                    "extracted_at": datetime.utcnow().isoformat() + "Z",
                })
            else:
                parse_failures.append((numero, "vencimiento_cuatrienal", vc_raw))

        vo_raw = meta.get("vencimiento_ordinario")
        if vo_raw:
            vo_iso = parse_cr_date(vo_raw)
            if vo_iso:
                rows_to_insert.append({
                    "expediente_id": numero,
                    "campo": "vence_subcomision",
                    "valor_fecha": vo_iso,
                    "valor_texto_original": f"Vencimiento Ordinario: {vo_raw}",
                    "fuente_documento_url": f"https://consultassil3.asamblea.go.cr/frmConsultaProyectos.aspx?expediente={numero.replace('.', '')}",
                    "fuente_pagina": None,
                    "extraction_method": "regex",
                    "extraction_confidence": 0.98,
                    "visual_marker": "plain",
                    "extracted_at": datetime.utcnow().isoformat() + "Z",
                })
            else:
                parse_failures.append((numero, "vencimiento_ordinario", vo_raw))

    print(f"Rows a insertar: {len(rows_to_insert)}")
    print(f"Parse failures: {len(parse_failures)}")
    if parse_failures[:5]:
        print("  Sample parse failures:")
        for n, c, v in parse_failures[:5]:
            print(f"    {n} {c}: {repr(v)}")

    if args.dry_run:
        if rows_to_insert[:3]:
            print("\n  Sample rows (dry-run):")
            for r in rows_to_insert[:3]:
                print(f"    {r['expediente_id']:>8} | {r['campo']:>22} | {r['valor_fecha']} | {r['valor_texto_original']}")
        return

    # Idempotencia: borrar rows previas con extraction_method='regex' de los
    # expedientes que vamos a insertar, así re-correr el script no duplica.
    distinct_exps = sorted({r["expediente_id"] for r in rows_to_insert})
    print(f"\nBorrando rows previas (extraction_method='regex') de {len(distinct_exps)} expedientes en chunks de 100...")
    deleted_total = 0
    for i in range(0, len(distinct_exps), 100):
        chunk = distinct_exps[i:i + 100]
        # PostgREST: in.(numero1,numero2,...)
        in_clause = ",".join(chunk)
        status, body = http(
            "DELETE",
            f"sil_expediente_fechas_extraidas?expediente_id=in.({in_clause})&extraction_method=eq.regex&campo=in.(fecha_cuatrienal,vence_subcomision)",
            headers_extra={"Prefer": "return=representation,count=exact"},
        )
        if status not in (200, 204):
            print(f"  DELETE chunk failed {status}: {body[:200]}", file=sys.stderr)
        else:
            try:
                deleted_total += len(json.loads(body) or [])
            except Exception:
                pass
    print(f"Filas eliminadas: {deleted_total}")

    # Bulk insert en chunks de 500
    print(f"\nInsertando {len(rows_to_insert)} rows en chunks de 500...")
    inserted = 0
    errors = 0
    for i in range(0, len(rows_to_insert), 500):
        chunk = rows_to_insert[i:i + 500]
        status, body = http(
            "POST", "sil_expediente_fechas_extraidas",
            body=chunk, headers_extra={"Prefer": "return=minimal"},
        )
        if status in (200, 201, 204):
            inserted += len(chunk)
        else:
            errors += len(chunk)
            print(f"  chunk {i}-{i+len(chunk)}: HTTP {status} {body[:200]}", file=sys.stderr)
        if (i + 500) % 2000 == 0:
            print(f"  …{inserted}/{len(rows_to_insert)} insertados")
    print(f"\nDONE — inserted {inserted}, errors {errors}")


if __name__ == "__main__":
    main()

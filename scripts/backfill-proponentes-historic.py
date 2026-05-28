#!/usr/bin/env python3
"""
backfill-proponentes-historic.py

Backfill masivo de `sil_expediente_proponentes` para 2 cohortes:

  A) **PODER EJECUTIVO** (4.207 expedientes): cuando `sil_expedientes.proponente`
     es 'PODER' (o 'PODER EJECUTIVO' literal), crea/actualiza una fila en
     `sil_expediente_proponentes` con firma_orden=1, diputado_nombre='PODER
     EJECUTIVO', y rellena `administracion` + `fraccion` derivados de
     `fecha_presentacion` cruzada contra el mapping histórico de presidentes
     de Costa Rica (1958-2030).

  B) **DIPUTADOS** (rows con fraccion=null y diputado_nombre != PODER): cruza
     contra la tabla local `diputados` (cuatrienio 2026-2030, 57 entradas) y
     rellena `fraccion` cuando hay match por apellidos canonicalizados.

Por qué Python y no el cron de enrichment:
  El cron `centinela-sil-enrich` está pausado por instrucción explícita
  (consume tokens LLM en otras etapas). Este backfill NO necesita LLM ni
  pegarle al SIL — es cálculo local sobre fechas + cross-reference con
  la tabla diputados. Sólo hace SELECT + UPSERT contra Supabase.

Uso:
  python3 scripts/backfill-proponentes-historic.py --dry-run        # ver qué cambiaría
  python3 scripts/backfill-proponentes-historic.py --mode poder     # solo PODER
  python3 scripts/backfill-proponentes-historic.py --mode diputados # solo diputados
  python3 scripts/backfill-proponentes-historic.py                   # ambos

Credenciales: lee NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY del env.
"""

import argparse
import json
import os
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import date, datetime
from typing import Any, Optional

# ─── Config ──────────────────────────────────────────────────────────────

SUPA_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPA_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if not SUPA_URL or not SUPA_KEY:
    print(
        "ERROR: NEXT_PUBLIC_SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY no están set.\n"
        "Tip: source el .env.production o exportá las vars antes de correr.",
        file=sys.stderr,
    )
    sys.exit(1)

REST = f"{SUPA_URL}/rest/v1"
HEADERS = {
    "apikey": SUPA_KEY,
    "Authorization": f"Bearer {SUPA_KEY}",
    "Content-Type": "application/json",
}

# ─── Administraciones presidenciales (1958 → 2030) ──────────────────────
# Costa Rica inaugura cada 8 de mayo. 18 administraciones cubren todos los
# expedientes con proponente=PODER en DB (oldest 1958, newest 2026-05-05).
# Datos verificables públicamente (Asamblea Legislativa + TSE).
ADMINISTRACIONES = [
    # (fecha_inicio, fecha_fin_excl, apellidos, fraccion_corta)
    ("1958-05-08", "1962-05-08", "ECHANDI JIMÉNEZ", "PUN"),
    ("1962-05-08", "1966-05-08", "ORLICH BOLMARCICH", "PLN"),
    ("1966-05-08", "1970-05-08", "TREJOS FERNÁNDEZ", "UNIFICACIÓN"),
    ("1970-05-08", "1974-05-08", "FIGUERES FERRER", "PLN"),
    ("1974-05-08", "1978-05-08", "ODUBER QUIRÓS", "PLN"),
    ("1978-05-08", "1982-05-08", "CARAZO ODIO", "COALICIÓN UNIDAD"),
    ("1982-05-08", "1986-05-08", "MONGE ÁLVAREZ", "PLN"),
    ("1986-05-08", "1990-05-08", "ARIAS SÁNCHEZ", "PLN"),
    ("1990-05-08", "1994-05-08", "CALDERÓN FOURNIER", "PUSC"),
    ("1994-05-08", "1998-05-08", "FIGUERES OLSEN", "PLN"),
    ("1998-05-08", "2002-05-08", "RODRÍGUEZ ECHEVERRÍA", "PUSC"),
    ("2002-05-08", "2006-05-08", "PACHECO DE LA ESPRIELLA", "PUSC"),
    ("2006-05-08", "2010-05-08", "ARIAS SÁNCHEZ", "PLN"),
    ("2010-05-08", "2014-05-08", "CHINCHILLA MIRANDA", "PLN"),
    ("2014-05-08", "2018-05-08", "SOLÍS RIVERA", "PAC"),
    ("2018-05-08", "2022-05-08", "ALVARADO QUESADA", "PAC"),
    ("2022-05-08", "2026-05-08", "CHAVES ROBLES", "PPSD"),
    ("2026-05-08", "2030-05-08", "FERNÁNDEZ DELGADO", "PPS"),
]


def admin_por_fecha(fecha_iso: str) -> Optional[tuple[str, str]]:
    """Devuelve (apellidos, fraccion) de la administración vigente en fecha_iso, o None."""
    if not fecha_iso:
        return None
    for inicio, fin, apellidos, fraccion in ADMINISTRACIONES:
        if inicio <= fecha_iso < fin:
            return (apellidos, fraccion)
    # Para fechas antes de 1958 o después de 2030 retornamos None — no las cubrimos.
    return None


# ─── Helpers HTTP ────────────────────────────────────────────────────────


def http(method: str, path: str, *, body: Any = None, headers_extra: Optional[dict] = None) -> tuple[int, str, dict]:
    url = f"{REST}/{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    hh = {**HEADERS}
    if headers_extra:
        hh.update(headers_extra)
    req = urllib.request.Request(url, data=data, headers=hh, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read().decode("utf-8"), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8"), dict(e.headers)


def fetch_all(path: str, *, page_size: int = 1000) -> list[dict]:
    """Pagina con Range header hasta agotar."""
    out: list[dict] = []
    start = 0
    while True:
        hh = {"Range-Unit": "items", "Range": f"{start}-{start + page_size - 1}"}
        status, body, _ = http("GET", path, headers_extra=hh)
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


# ─── Canonicalize apellidos (mismo algoritmo que el TS) ──────────────────


def canonicalize(text: str) -> str:
    """
    Quita acentos/diacríticos, uppercase, colapsa espacios. Idéntico al
    `canonicalize` de `apps/api/src/services/diputadosLookup.ts`.
    """
    if not text:
        return ""
    # NFD descompone los caracteres acentuados en base + diacrítico
    nfd = unicodedata.normalize("NFKD", text)
    # Quitar los combining marks (categoría 'Mn')
    stripped = "".join(c for c in nfd if unicodedata.category(c) != "Mn")
    return " ".join(stripped.upper().split())


def extract_apellidos(diputado_nombre: str) -> str:
    """
    Heurística: los apellidos canonicalizados siempre son 2 tokens (raro: 3).
    Si el campo trae 'BOGANTES RIVERA GERALD ALBERTO', queremos
    'BOGANTES RIVERA' (los 2 primeros). Si trae solo 'BOGANTES RIVERA',
    devuelve igual.
    """
    canon = canonicalize(diputado_nombre)
    tokens = canon.split()
    if len(tokens) <= 2:
        return canon
    return " ".join(tokens[:2])


# ─── Task A: PODER EJECUTIVO backfill ────────────────────────────────────


def backfill_poder(dry_run: bool = False) -> dict:
    print("\n=== Backfill PODER EJECUTIVO ===")
    # Pull expedientes con proponente PODER + fecha_presentacion
    expedientes = fetch_all(
        "sil_expedientes?proponente=in.(PODER,PODER%20EJECUTIVO)"
        "&fecha_presentacion=not.is.null"
        "&select=numero,fecha_presentacion"
    )
    print(f"  Target: {len(expedientes)} expedientes PODER con fecha")

    stats = {"matched": 0, "no_admin": 0, "upserted": 0, "errors": 0}
    by_admin: dict[str, int] = {}

    # Bulk upsert en chunks de 100
    chunk: list[dict] = []
    for i, e in enumerate(expedientes):
        fecha = e.get("fecha_presentacion")
        numero = e.get("numero")
        admin = admin_por_fecha(fecha)
        if not admin:
            stats["no_admin"] += 1
            continue
        stats["matched"] += 1
        apellidos_pres, fraccion = admin
        by_admin[apellidos_pres] = by_admin.get(apellidos_pres, 0) + 1
        chunk.append(
            {
                "expediente_id": numero,
                "firma_orden": 1,
                "diputado_nombre": "PODER EJECUTIVO",
                "administracion": apellidos_pres,
                "fraccion": fraccion,
            }
        )

        # Flush every 100
        if len(chunk) >= 100:
            if not dry_run:
                stats["upserted"] += _upsert_chunk(chunk, stats)
            chunk = []
            if (i + 1) % 500 == 0:
                print(f"  …{i+1}/{len(expedientes)} processed")

    if chunk and not dry_run:
        stats["upserted"] += _upsert_chunk(chunk, stats)

    print(f"  Stats: {stats}")
    print(f"  By administración:")
    for k, v in sorted(by_admin.items(), key=lambda x: -x[1]):
        print(f"    {k:25} {v}")
    if dry_run:
        print(f"  (DRY RUN — no writes performed; sample of 3 changes:)")
        for e in expedientes[:3]:
            adm = admin_por_fecha(e["fecha_presentacion"])
            if adm:
                print(f"    {e['numero']:>8} {e['fecha_presentacion']} → {adm}")
    return stats


def _upsert_chunk(chunk: list[dict], stats: dict) -> int:
    """Upsert un chunk a sil_expediente_proponentes via on-conflict."""
    status, body, _ = http(
        "POST",
        "sil_expediente_proponentes?on_conflict=expediente_id,firma_orden",
        body=chunk,
        headers_extra={"Prefer": "resolution=merge-duplicates,return=minimal"},
    )
    if status in (200, 201, 204):
        return len(chunk)
    print(f"    upsert chunk failed {status}: {body[:200]}", file=sys.stderr)
    stats["errors"] += len(chunk)
    return 0


# ─── Task B: Diputados cross-reference ───────────────────────────────────


def backfill_diputados(dry_run: bool = False) -> dict:
    print("\n=== Backfill DIPUTADOS (cross-reference con tabla diputados) ===")

    # Cargar diputados en memoria
    dips = fetch_all("diputados?select=apellidos_canonical,nombre_completo,fraccion,fraccion_corta")
    dips_by_apellidos = {d["apellidos_canonical"]: d for d in dips}
    print(f"  Diputados en seed: {len(dips_by_apellidos)}")

    # Pull rows con fraccion=null y diputado_nombre != PODER*
    targets = fetch_all(
        "sil_expediente_proponentes?fraccion=is.null"
        "&diputado_nombre=not.ilike.PODER*"
        "&select=expediente_id,firma_orden,diputado_nombre"
    )
    print(f"  Target rows: {len(targets)}")

    stats = {"matched": 0, "no_match": 0, "updated": 0, "errors": 0}
    no_match_sample: list[str] = []
    match_sample: list[tuple[str, str]] = []

    for i, row in enumerate(targets):
        apellidos = extract_apellidos(row["diputado_nombre"])
        d = dips_by_apellidos.get(apellidos)
        if not d:
            stats["no_match"] += 1
            if len(no_match_sample) < 15:
                no_match_sample.append(row["diputado_nombre"])
            continue
        stats["matched"] += 1
        if len(match_sample) < 5:
            match_sample.append((row["diputado_nombre"], d["fraccion"]))

        if dry_run:
            continue

        # Update por PK compuesto (expediente_id, firma_orden)
        eid = urllib.parse.quote(row["expediente_id"], safe="")
        path = f"sil_expediente_proponentes?expediente_id=eq.{eid}&firma_orden=eq.{row['firma_orden']}"
        body = {
            "fraccion": d["fraccion"],
            "diputado_nombre": d["nombre_completo"],
        }
        status, resp_body, _ = http("PATCH", path, body=body, headers_extra={"Prefer": "return=minimal"})
        if status in (200, 204):
            stats["updated"] += 1
        else:
            stats["errors"] += 1
            if stats["errors"] <= 5:
                print(f"    PATCH failed for {row['expediente_id']}/{row['firma_orden']}: {status} {resp_body[:120]}", file=sys.stderr)

        if (i + 1) % 1000 == 0:
            print(f"  …{i+1}/{len(targets)} processed (matched={stats['matched']}, no_match={stats['no_match']})")

    print(f"  Stats: {stats}")
    print(f"  Sample matches:")
    for nm, fr in match_sample:
        print(f"    {nm:35} → {fr}")
    print(f"  Sample no-match (top 15 — apellidos no en seed):")
    for nm in no_match_sample:
        print(f"    {nm}")
    return stats


# ─── CLI ─────────────────────────────────────────────────────────────────


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--mode",
        choices=("poder", "diputados", "both"),
        default="both",
        help="qué backfill correr (default: both)",
    )
    ap.add_argument("--dry-run", action="store_true", help="no escribir a DB, solo reportar")
    args = ap.parse_args()

    print(f"Backfill iniciado a {datetime.now().isoformat()}")
    print(f"  Mode: {args.mode}  Dry-run: {args.dry_run}")
    print(f"  Supabase: {SUPA_URL}")

    t0 = time.time()
    if args.mode in ("poder", "both"):
        backfill_poder(dry_run=args.dry_run)
    if args.mode in ("diputados", "both"):
        backfill_diputados(dry_run=args.dry_run)
    elapsed = time.time() - t0
    print(f"\nDone en {elapsed:.1f}s")


if __name__ == "__main__":
    main()

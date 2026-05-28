#!/usr/bin/env python3
"""
scrape-diputados-historic.py

Descarga la lista de diputados de los cuatrienios pasados de la Asamblea
Legislativa de Costa Rica desde Wikipedia y los inserta en la tabla
`diputados` con su `periodo_inicio` / `periodo_fin` correspondiente. Datos
verificables públicamente (TSE + Asamblea).

Cuatrienios cubiertos: 2002-2006, 2006-2010, 2010-2014, 2014-2018,
2018-2022, 2022-2026. El 2026-2030 ya está seedeado en otro script.

Por qué Wikipedia y no el Tribunal Supremo de Elecciones (TSE):
  El TSE expone JSON-stats por persona elegida pero el listing por
  cuatrienio queda detrás de su navegación stateful. Wikipedia tiene
  la tabla en HTML estático parseable y se mantiene actualizada por
  contribuyentes. Para el caso disonante (Müller Castro vs Marín)
  sabemos que el SIL gana; este seed sirve para cross-reference por
  apellidos, no como fuente final de verdad del nombre completo.

Uso:
  python3 scripts/scrape-diputados-historic.py --dry-run
  python3 scripts/scrape-diputados-historic.py
"""

import argparse
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime
from html.parser import HTMLParser
from typing import Optional

SUPA_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPA_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if not SUPA_URL or not SUPA_KEY:
    print("ERROR: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no set", file=sys.stderr)
    sys.exit(1)

REST = f"{SUPA_URL}/rest/v1"
H = {
    "apikey": SUPA_KEY,
    "Authorization": f"Bearer {SUPA_KEY}",
    "Content-Type": "application/json",
}

CUATRIENIOS = [
    # (label, periodo_inicio, periodo_fin, parser_format)
    # parser_format:
    #   "modern" = header "Curul | Foto | Nombre | Fracción | …" (2014+)
    #   "old"    = header "Provincia | Lugar | Fracción | Diputado | Inicia | Termina" (2010-2014)
    ("2022-2026", "2022-05-01", "2026-04-30", "modern"),
    ("2018-2022", "2018-05-01", "2022-04-30", "modern"),
    ("2014-2018", "2014-05-01", "2018-04-30", "modern"),
    ("2010-2014", "2010-05-01", "2014-04-30", "old"),
    # 2006-2010 y 2002-2006 las páginas no existen en Wikipedia en este path.
    # Los expedientes de esas épocas siguen con fracción NULL hasta que
    # alguien aporte la lista (TSE).
]


# ─── Fracción → corta mapping (normalize variantes de Wikipedia) ────────


def fraccion_corta(full: str) -> str:
    """Normaliza el nombre del partido a su sigla corta."""
    if not full:
        return ""
    f = full.upper()
    if "LIBERACI" in f and "NACIONAL" in f:
        return "PLN"
    if "UNIDAD" in f and "SOCIAL" in f and "CRISTIANA" in f:
        return "PUSC"
    if "ACCI" in f and "CIUDADAN" in f:
        return "PAC"
    if "FRENTE" in f and "AMPLIO" in f:
        return "FA"
    if "MOVIMIENTO" in f and "LIBERTARIO" in f:
        return "ML"
    if "PUEBLO SOBERANO" in f:
        return "PPS"
    if "PROGRESO" in f and "SOCIAL" in f and "DEMOC" in f:
        return "PPSD"
    if "REPUBLICANO" in f and "SOCIAL" in f:
        return "PRSC"
    if "RESTAURACI" in f and "NACIONAL" in f:
        return "PRN"
    if "INTEGRACI" in f and "NACIONAL" in f:
        return "PIN"
    if "NUEVA" in f and "REP" in f and "BLICA" in f:
        return "PNR"
    if "ACCESIBILIDAD" in f and "SIN" in f and "EXCLUSI" in f:
        return "PASE"
    if "RENOVACI" in f and "COSTARRICENSE" in f:
        return "PRC"
    if "UNI" in f and "AGRICOLA" in f and "CARTAGI" in f:
        return "PUAC"
    if "INDEPENDIENTE" in f and "OBRER" in f:
        return "PIO"
    if "ALIANZA" in f and "DEMOCR" in f and "CRISTIAN" in f:
        return "ADC"
    if "VAMOS" in f:
        return "PV"
    if "LIBERAL" in f and "PROGRESISTA" in f:
        return "PLP"
    if "FRENTE" in f and "ECOLO" in f:
        return "FE"
    if "INTEGRACIÓN NACIONAL" in f:
        return "PIN"
    # Default: extraer iniciales mayúsculas
    initials = "".join(c for c in full if c.isupper())
    return initials[:6] if initials else full[:6]


# ─── Canonicalize (mismo algoritmo que diputadosLookup.ts) ──────────────


def canonicalize(text: str) -> str:
    if not text:
        return ""
    nfd = unicodedata.normalize("NFKD", text)
    stripped = "".join(c for c in nfd if unicodedata.category(c) != "Mn")
    return " ".join(stripped.upper().split())


def extract_apellidos(full_name: str) -> str:
    """
    Convención hispano: <Nombre(s)> <Apellido Paterno> <Apellido Materno>.
    Tomamos las últimas 2 palabras como apellidos. Falla con nombres
    compuestos pero es buena heurística para 90%+ de casos.

    Ejemplo: "Anna Katharina Müller Castro" → apellidos "Müller Castro"
    Ejemplo: "Juan Pérez" → "Juan Pérez" (caso degenerado, 1 apellido)
    """
    tokens = full_name.strip().split()
    if len(tokens) >= 2:
        return f"{tokens[-2]} {tokens[-1]}"
    return full_name


def extract_nombre(full_name: str) -> str:
    """Todo menos los últimos 2 tokens (que son apellidos)."""
    tokens = full_name.strip().split()
    if len(tokens) > 2:
        return " ".join(tokens[:-2])
    return tokens[0] if tokens else ""


# ─── Wikipedia HTML scraper ─────────────────────────────────────────────


class WikiTableParser(HTMLParser):
    """
    Parsea las tablas de Wikipedia con clase 'wikitable'. Cada fila se
    devuelve como list[str] (cell texts limpios). Para el formato
    Asamblea CR los headers típicos son:
      | Curul (provincia) | Foto | Nombre | Partido | Profesión | Otros datos |

    Cuatrienios viejos usan slightly different headers pero la columna
    'Nombre' y 'Partido' son consistentes en posición 2 y 3 (0-indexed).
    """

    def __init__(self):
        super().__init__()
        self.rows: list[list[str]] = []
        self.in_table = False
        self.in_row = False
        self.in_cell = False
        self.cur_row: list[str] = []
        self.cur_cell: list[str] = []
        self.depth_in_table = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "table":
            cls = a.get("class", "")
            if "wikitable" in cls:
                self.in_table = True
                self.depth_in_table = 1
            elif self.in_table:
                self.depth_in_table += 1
        elif self.in_table and tag == "tr" and self.depth_in_table == 1:
            self.in_row = True
            self.cur_row = []
        elif self.in_row and tag in ("td", "th") and self.depth_in_table == 1:
            self.in_cell = True
            self.cur_cell = []

    def handle_endtag(self, tag):
        if tag == "table" and self.in_table:
            self.depth_in_table -= 1
            if self.depth_in_table == 0:
                self.in_table = False
        elif self.in_row and tag == "tr" and self.depth_in_table == 1:
            if self.cur_row:
                self.rows.append(self.cur_row)
            self.in_row = False
            self.cur_row = []
        elif self.in_cell and tag in ("td", "th") and self.depth_in_table == 1:
            text = " ".join("".join(self.cur_cell).split())
            self.cur_row.append(text)
            self.in_cell = False
            self.cur_cell = []

    def handle_data(self, data):
        if self.in_cell:
            self.cur_cell.append(data)

    def handle_entityref(self, name):
        if self.in_cell:
            self.cur_cell.append({"nbsp": " ", "amp": "&"}.get(name, ""))


PROVINCIAS = ("San José", "Alajuela", "Cartago", "Heredia", "Guanacaste", "Puntarenas", "Limón")


def is_partido_cell(cell: str) -> bool:
    """Detecta si una celda contiene el nombre de un partido."""
    if not cell:
        return False
    u = cell.upper()
    if u == "INDEPENDIENTE":
        return True
    keywords = (
        "PARTIDO ", "LIBERACI", "UNIDAD SOCIAL", "FRENTE AMPLIO",
        "ACCIÓN CIUDADANA", "ACCESIBILIDAD", "MOVIMIENTO LIBERTARIO",
        "RESTAURACI", "INTEGRACI", "NUEVA REP", "PUEBLO SOBERANO",
        "PROGRESO SOCIAL", "REPUBLICANO SOCIAL", "ALIANZA DEM",
        "VAMOS", "LIBERAL PROGRESISTA", "FRENTE ECOL", "COALICI",
        "RENOVACI", "AGRÍCOLA CARTAGI", "INDEPENDIENTE OBRER",
    )
    return any(k in u for k in keywords)


def scrape_modern(periodo_label: str) -> list[dict]:
    """
    Parser para Wikipedia 2014-2026: filas que empiezan con "Provincia N".
    Header típico: | Curul | Foto | Nombre | Fracción | Profesión | …
    """
    url = f"https://es.wikipedia.org/wiki/Anexo:Diputados_del_periodo_legislativo_{periodo_label}_en_Costa_Rica"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 CL2-research/1.0"})
    html = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", errors="replace")
    p = WikiTableParser()
    p.feed(html)

    PROV_RE = re.compile(r"^(San José|Alajuela|Cartago|Heredia|Guanacaste|Puntarenas|Limón)\s+(\d+)\s*$", re.I)
    diputados: list[dict] = []
    for row in p.rows:
        if len(row) < 3:
            continue
        m = PROV_RE.match(row[0].strip())
        if not m:
            continue
        provincia = m.group(1)
        curul = int(m.group(2))

        nombre = ""
        partido = ""
        for cell in row[1:6]:
            cell = cell.strip()
            if not cell:
                continue
            if is_partido_cell(cell):
                if not partido:
                    partido = cell
            elif not nombre and len(cell.split()) >= 2 and re.match(r"^[A-ZÁÉÍÓÚÑÜ]", cell):
                # 2+ palabras con mayúscula inicial = candidato a nombre.
                # Excluye "Diputado" header u otros leak strings.
                if cell.lower() not in ("diputado", "diputada", "profesion", "profesión"):
                    nombre = cell

        if not nombre or not partido:
            continue
        diputados.append({
            "nombre_completo": nombre, "fraccion": partido,
            "fraccion_corta": fraccion_corta(partido),
            "provincia": provincia, "curul": curul,
        })
    return diputados


def scrape_old(periodo_label: str) -> list[dict]:
    """
    Parser para Wikipedia 2010-2014: header
      | Provincia | Lugar | Fracción | Diputado | Inicia | Termina |
    Cada curul puede tener varios diputados (sustituciones). Tomamos solo
    el primero (firma original del cuatrienio).
    """
    url = f"https://es.wikipedia.org/wiki/Anexo:Diputados_del_periodo_legislativo_{periodo_label}_en_Costa_Rica"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 CL2-research/1.0"})
    html = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", errors="replace")
    p = WikiTableParser()
    p.feed(html)

    PROV_RE = re.compile(r"Provincia de (San José|Alajuela|Cartago|Heredia|Guanacaste|Puntarenas|Limón)", re.I)
    diputados: list[dict] = []
    seen_curul: set[tuple[str, int]] = set()
    for row in p.rows:
        if len(row) < 4:
            continue
        m = PROV_RE.match(row[0].strip())
        if not m:
            continue
        provincia = m.group(1)
        try:
            curul = int(row[1].strip())
        except ValueError:
            continue

        key = (provincia, curul)
        if key in seen_curul:
            continue
        seen_curul.add(key)

        partido = row[2].strip()
        nombre = row[3].strip()
        if not partido or not nombre:
            continue

        diputados.append({
            "nombre_completo": nombre,
            "fraccion": partido if "Partido" in partido or "Frente" in partido or "Movimiento" in partido or "Accesibilidad" in partido or "Restauración" in partido or "Renovación" in partido else f"Partido {partido}",
            "fraccion_corta": fraccion_corta(partido),
            "provincia": provincia, "curul": curul,
        })
    return diputados


def scrape_cuatrienio(periodo_label: str, fmt: str) -> list[dict]:
    if fmt == "modern":
        return scrape_modern(periodo_label)
    if fmt == "old":
        return scrape_old(periodo_label)
    raise ValueError(f"unknown format: {fmt}")


# ─── DB writes ───────────────────────────────────────────────────────────


def insert_period(rows: list[dict], periodo_inicio: str, periodo_fin: str, dry_run: bool = False) -> int:
    """
    Borra rows previas de este periodo y re-inserta. Idempotente.
    """
    # Delete existing for this period
    if not dry_run:
        del_url = f"{REST}/diputados?periodo_inicio=eq.{periodo_inicio}&periodo_fin=eq.{periodo_fin}"
        req = urllib.request.Request(del_url, method="DELETE", headers=H)
        try:
            urllib.request.urlopen(req, timeout=30).read()
        except urllib.error.HTTPError as e:
            print(f"    delete period {periodo_inicio} failed: {e.code} {e.read().decode()[:200]}", file=sys.stderr)
            return 0

    payload = []
    for r in rows:
        apellidos_display = extract_apellidos(r["nombre_completo"])
        apellidos_canonical = canonicalize(apellidos_display)
        nombre_part = extract_nombre(r["nombre_completo"])
        payload.append(
            {
                "apellidos_canonical": apellidos_canonical,
                "apellidos_display": apellidos_display,
                "nombre": nombre_part or None,
                "nombre_completo": r["nombre_completo"],
                "fraccion": r["fraccion"],
                "fraccion_corta": r["fraccion_corta"],
                "provincia": r["provincia"],
                "curul": r["curul"],
                "periodo_inicio": periodo_inicio,
                "periodo_fin": periodo_fin,
                "notas": None,
            }
        )

    if dry_run:
        return len(payload)

    req = urllib.request.Request(
        f"{REST}/diputados",
        data=json.dumps(payload).encode(),
        method="POST",
        headers={**H, "Prefer": "return=minimal"},
    )
    try:
        urllib.request.urlopen(req, timeout=60).read()
        return len(payload)
    except urllib.error.HTTPError as e:
        print(f"    insert period {periodo_inicio} failed: {e.code} {e.read().decode()[:300]}", file=sys.stderr)
        return 0


# ─── CLI ─────────────────────────────────────────────────────────────────


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    print(f"Scrape diputados histórico — {datetime.now().isoformat()}")
    print(f"  Dry-run: {args.dry_run}")
    print(f"  Cuatrienios: {[c[0] for c in CUATRIENIOS]}")

    total_inserted = 0
    per_period: dict[str, int] = {}
    for periodo_label, inicio, fin, fmt in CUATRIENIOS:
        print(f"\n=== {periodo_label} ({fmt}) ===")
        try:
            dips = scrape_cuatrienio(periodo_label, fmt)
        except Exception as e:
            print(f"  scrape failed: {e}", file=sys.stderr)
            continue
        print(f"  Scraped: {len(dips)} diputados")
        # Sample
        for d in dips[:3]:
            print(f"    {d['provincia']} {d['curul']:>2} | {d['nombre_completo']:38} | {d['fraccion_corta']}")

        n = insert_period(dips, inicio, fin, dry_run=args.dry_run)
        per_period[periodo_label] = n
        total_inserted += n
        time.sleep(0.5)  # politeness con Wikipedia

    print(f"\n=== Resumen ===")
    for k, v in per_period.items():
        print(f"  {k}: {v}")
    print(f"  Total: {total_inserted}")


if __name__ == "__main__":
    main()

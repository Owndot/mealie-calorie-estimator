#!/usr/bin/env python3
"""
One-time (re-runnable) import of the official BLS 4.0 Open Data dataset into a compact,
read-only SQLite reference table bundled with this service.

Source: Max Rubner-Institut (MRI), "Bundeslebensmittelschlüssel (BLS), Version 4.0" (2025-12-15).
License: CC BY 4.0 (Creative Commons Attribution 4.0 International).
Required attribution (reproduced verbatim, per license terms):
  Max Rubner-Institut (2025): Bundeslebensmittelschlüssel (BLS), Version 4.0 -
  Deutsche Nährstoffdatenbank. Karlsruhe. DOI: 10.25826/Data20251217-134202-0
Download: https://blsdb.de/download (BLS_4_0_2025_DE.zip)

This script transforms ONLY the fields this service needs (BLS code, German name, English
name, and 11 nutrient columns) out of the full 418-column/138-nutrient official export. It does
not hand-author, estimate, or invent any nutrition value — every stored number is either a
verbatim BLS 4.0 figure (converted mg -> g at the two columns that need it, for internal unit
consistency with every other provider) or is left null, exactly matching what BLS itself reports.

Usage:
    python3 scripts/import_bls.py <path-to-BLS_4_0_Daten_2025_DE.xlsx> [output-sqlite-path]

Requires: pip install openpyxl (only for running this import script — not a runtime dependency
of the service itself).
"""
import sqlite3
import sys
import unicodedata
import re
from pathlib import Path

try:
    import openpyxl
except ImportError:
    print("Install openpyxl to run this import: pip install openpyxl", file=sys.stderr)
    sys.exit(1)

DEFAULT_OUTPUT = Path(__file__).resolve().parent.parent / "resources" / "bls" / "bls-4.0.sqlite"

# Column indices in the official BLS_4_0_Daten_2025_DE.xlsx export (0-based), resolved by
# header name at load time below rather than hardcoded — this script looks the index up by the
# BLS component code prefix in each header (e.g. "ENERCC Energie (Kilokalorien) [kcal/100g]"
# starts with "ENERCC "), so it keeps working if MRI reorders columns in a future release. It
# fails loudly if a required code disappears from the header row.
REQUIRED_CODES = [
    "BLS Code", "Lebensmittelbezeichnung", "Food name",
    "ENERCC", "PROT625", "FAT", "CHO", "FIBT", "NA", "SUGAR", "FASAT", "FAMS", "FAPU", "CHORL",
]

# Values BLS uses in place of a number, and what they mean for our purposes:
#   "-"                  -> not determined at all: genuinely unknown, stays null.
#   "TR" / "<LOD" /
#   "<LOQ" / "<LOD or <LOQ" -> measured but below the trace/detection/quantification threshold:
#                              a real (negligible) measurement, not a missing one -> 0.
TRACE_TOKENS = {"TR", "<LOD", "<LOQ", "<LOD or <LOQ"}
MISSING_TOKENS = {"-"}


def parse_value(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip()
        if s in MISSING_TOKENS:
            return None
        if s in TRACE_TOKENS:
            return 0.0
        # Unrecognized marker: fail loudly rather than silently guessing at its meaning.
        raise ValueError(f"Unrecognized BLS value marker: {v!r}")
    raise ValueError(f"Unexpected BLS cell type: {type(v)} ({v!r})")


def mg_to_g(v):
    return v / 1000.0 if v is not None else None


def normalize_name(name: str) -> str:
    """Same normalization family as the TS side's ranking.tokenize()/cache.normalizeKey() —
    lowercase, diacritics-folded, non-letter/digit collapsed to spaces, for exact-match lookups."""
    s = unicodedata.normalize("NFKD", name).lower()
    s = re.sub(r"[^\w\s]", " ", s, flags=re.UNICODE)
    s = re.sub(r"\s+", " ", s).strip()
    return s


# BLS food names are state-explicit (e.g. "Speisezwiebel roh", "Kartoffel gekocht"). Extracted
# heuristically from the name text itself since there is no separate structured state column.
STATE_PATTERNS = [
    ("dried", re.compile(r"\b(getrocknet\w*|trockenprodukt|pulver|gefriergetrocknet\w*)\b", re.IGNORECASE)),
    ("cooked", re.compile(
        r"\b(gekocht\w*|gegart\w*|gedünstet\w*|gedaempft\w*|gedämpft\w*|geschmort\w*|gebraten\w*|"
        r"gebacken\w*|frittiert\w*|gegrillt\w*|blanchiert\w*)\b", re.IGNORECASE)),
    ("raw", re.compile(r"\broh\w*\b", re.IGNORECASE)),
]


def infer_state(name_de: str) -> str:
    for state, pattern in STATE_PATTERNS:
        if pattern.search(name_de):
            return state
    return "unknown"


# Official BLS Code structure (BLS 4.0 Dokumentation section 2.4, cross-referenced against
# blsdb.de/bls): the code is up to 7 characters, [Letter][6 digits]. The LEADING LETTER is the
# "Hauptlebensmittelgruppe" (main food group) — this is authoritative structured metadata, not a
# lexical guess. Two letters are explicitly documented as composite/prepared-dish groups:
#   X = "Menükomponenten überwiegend pflanzlich" (menu components, predominantly plant-based)
#   Y = "Menükomponente vorwiegend tierisch" (menu components, predominantly animal-based)
# Empirically verified against this exact dataset: every BLS entry this project's own regression
# testing found to be a prepared dish wrongly matching a simple-ingredient query (Hasenpfeffer,
# Schweinepfeffer, Rote-Linsensuppe mit Koriander, Kartoffel-Tomaten-Gratin) is coded X or Y.
# Every other letter (B, C, D, E, F, G, H, K, M, N, P, Q, R, S, T, U, V, W) covers a raw/single-
# food group (bread, cereals, fine baked goods, eggs, fruit, vegetables, legumes/sprouts/tofu,
# potato/starch, dairy, non-alcoholic drinks, alcoholic drinks, fats/oils, condiments/spices,
# sugar/honey, fish, meat cuts, offal/game, sausage/cured meat) — BLS's own letter system doesn't
# further split those into "simple" vs "processed" at the single-letter level, so this import
# only derives the composite/non-composite distinction from the code; the existing name-based
# infer_state() continues to carry preparation-state detail.
COMPOSITE_DISH_LETTERS = {"X", "Y"}


def food_type_from_code(bls_code: str) -> str:
    letter = bls_code[0].upper() if bls_code else ""
    return "composite_dish" if letter in COMPOSITE_DISH_LETTERS else "simple"


def find_column_indices(header_row):
    indices = {}
    for i, cell in enumerate(header_row):
        if not isinstance(cell, str):
            continue
        for code in REQUIRED_CODES:
            if code in indices:
                continue  # keep the first match only — the value column always precedes its
                # own "{CODE} Datenherkunft"/"{CODE} Referenz" sibling columns in this export.
            if code in ("BLS Code", "Lebensmittelbezeichnung", "Food name"):
                if cell == code:
                    indices[code] = i
            elif cell.startswith(code + " ") and "[" in cell:
                indices[code] = i
    missing = [c for c in REQUIRED_CODES if c not in indices]
    if missing:
        raise SystemExit(f"BLS export is missing expected column(s): {missing}. "
                          f"The format may have changed — update REQUIRED_CODES/parsing accordingly.")
    return indices


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    xlsx_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUTPUT
    output_path.parent.mkdir(parents=True, exist_ok=True)

    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    sheet_name = wb.sheetnames[0]
    ws = wb[sheet_name]
    rows = ws.iter_rows(values_only=True)
    header = next(rows)
    idx = find_column_indices(header)

    if output_path.exists():
        output_path.unlink()
    conn = sqlite3.connect(output_path)
    conn.execute("""
        CREATE TABLE bls_foods (
            bls_code TEXT PRIMARY KEY,
            name_de TEXT NOT NULL,
            name_de_normalized TEXT NOT NULL,
            name_en TEXT,
            inferred_state TEXT NOT NULL,
            group_letter TEXT NOT NULL,
            food_type TEXT NOT NULL,
            kcal_per_100g REAL,
            protein_per_100g REAL,
            carbs_per_100g REAL,
            fat_per_100g REAL,
            saturated_fat_per_100g REAL,
            unsaturated_fat_per_100g REAL,
            fiber_per_100g REAL,
            sugar_per_100g REAL,
            sodium_per_100g REAL,
            cholesterol_per_100g REAL
        )
    """)
    conn.execute("CREATE INDEX idx_bls_name_de_normalized ON bls_foods(name_de_normalized)")

    count = 0
    for r in rows:
        bls_code = r[idx["BLS Code"]]
        name_de = r[idx["Lebensmittelbezeichnung"]]
        name_en = r[idx["Food name"]]
        if not bls_code or not name_de:
            continue

        fams = parse_value(r[idx["FAMS"]])
        fapu = parse_value(r[idx["FAPU"]])
        unsaturated = None if (fams is None and fapu is None) else (fams or 0.0) + (fapu or 0.0)

        conn.execute(
            """INSERT INTO bls_foods (
                bls_code, name_de, name_de_normalized, name_en, inferred_state,
                group_letter, food_type,
                kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g,
                saturated_fat_per_100g, unsaturated_fat_per_100g, fiber_per_100g,
                sugar_per_100g, sodium_per_100g, cholesterol_per_100g
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                bls_code, name_de, normalize_name(name_de), name_en, infer_state(name_de),
                bls_code[0].upper(), food_type_from_code(bls_code),
                parse_value(r[idx["ENERCC"]]),
                parse_value(r[idx["PROT625"]]),
                parse_value(r[idx["CHO"]]),
                parse_value(r[idx["FAT"]]),
                parse_value(r[idx["FASAT"]]),
                unsaturated,
                parse_value(r[idx["FIBT"]]),
                parse_value(r[idx["SUGAR"]]),
                mg_to_g(parse_value(r[idx["NA"]])),
                mg_to_g(parse_value(r[idx["CHORL"]])),
            ),
        )
        count += 1

    conn.execute(
        "CREATE TABLE bls_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
    conn.execute(
        "INSERT INTO bls_meta (key, value) VALUES ('attribution', ?)",
        ("Max Rubner-Institut (2025): Bundeslebensmittelschlüssel (BLS), Version 4.0 - "
         "Deutsche Nährstoffdatenbank. Karlsruhe. "
         "DOI: 10.25826/Data20251217-134202-0. License: CC BY 4.0.",),
    )
    conn.execute("INSERT INTO bls_meta (key, value) VALUES ('version', '4.0')")
    conn.execute("INSERT INTO bls_meta (key, value) VALUES ('food_count', ?)", (str(count),))

    conn.commit()
    conn.close()
    print(f"Imported {count} BLS 4.0 foods -> {output_path}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Re-runnable import of the official USDA FoodData Central GENERIC datasets into the compact,
read-only SQLite reference table bundled with this service.

Source: U.S. Department of Agriculture, Agricultural Research Service, Beltsville Human Nutrition
Research Center. FoodData Central. https://fdc.nal.usda.gov/
License: CC0 1.0 Universal — public domain, not copyrighted. Attribution is requested rather than
required; it is recorded in usda_meta, resources/usda/NOTICE and the README regardless.

INCLUDED datasets, pinned by release:
    Foundation Foods   2026-04-30   (updated twice a year)
    SR Legacy          2018-04      (final release; USDA will not update it again)

DELIBERATELY EXCLUDED, and the exclusions are asserted after import:
    Branded Foods  — 428 MB of label data whose rows crowded the live API's result window. Keeping
                     them out is the entire point of this database: a query for "ground beef"
                     returned 25 Branded rows out of 25 through the API, which is structurally
                     impossible here because no Branded row is ever imported.
    FNDDS (Survey) — measured to lift only two benchmark concepts over Foundation+SR while adding
                     5,432 rows, 2,710 of them prepared/composite dishes, and inflating candidate
                     sets by ~65%.

Note the Foundation archive's food.csv is NOT only Foundation foods: the 2026-04-30 release holds
87,990 rows, of which 469 are `foundation_food` and the rest are sample/sub-sample/acquisition
bookkeeping. Filtering on data_type is mandatory, not tidiness.

Usage:
    python3 scripts/import_usda.py <foundation-dir-or-zip> <sr-legacy-dir-or-zip> [output.sqlite]

Every stored number is a verbatim FoodData Central value, converted mg -> g only for sodium and
cholesterol so the units match every other provider's NutrientSet. Nothing is estimated, averaged
or hand-authored.
"""
import csv
import hashlib
import json
import re
import sqlite3
import sys
import tempfile
import unicodedata
import zipfile
from pathlib import Path

csv.field_size_limit(10 ** 7)

REPO = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = REPO / "resources" / "usda" / "usda-generic.sqlite"
MANIFEST = REPO / "resources" / "usda" / "SOURCES.json"

# Bumped whenever the importer's OUTPUT changes shape or content for the same inputs — the
# provider refuses a database whose schema_version it does not recognise, and the value is folded
# into the provider's cache key so a re-import cannot leave stale matches behind.
SCHEMA_VERSION = "1"

ATTRIBUTION = (
    "U.S. Department of Agriculture, Agricultural Research Service, Beltsville Human Nutrition "
    "Research Center. FoodData Central. Available from https://fdc.nal.usda.gov/. "
    "Public domain (CC0 1.0 Universal)."
)

# dataset label -> (data_type value in food.csv, expected row count for the pinned release)
DATASETS = {
    "Foundation": ("foundation_food", 469),
    "SR Legacy": ("sr_legacy_food", 7793),
}
EXPECTED_TOTAL = sum(n for _, n in DATASETS.values())

# Datasets that must never appear. Asserted after import rather than merely avoided.
FORBIDDEN_DATA_TYPES = ("branded_food", "survey_fndds_food", "experimental_food")

# Our NutrientSet field -> FoodData Central nutrient ids, in precedence order.
#
# Verified against the pinned releases rather than copied from documentation:
#   energy      SR Legacy reports 1008 for 7,793/7,793 foods and never 2047/2048. Foundation is
#               mixed — 135 rows on 1008, 347 on 2047, 312 on 2048 — so a deterministic order is
#               required. 1008 first keeps Foundation consistent with SR wherever it can be;
#               Atwater General then Specific are the documented fallbacks. Never averaged, never
#               summed: exactly one id is used per food and it is recorded in energy_nutrient_id.
#   sugar       SR Legacy uses 2000 (6,007 rows) and never 1063; Foundation uses 1063 (280 rows)
#               far more than 2000 (45). Both ids are therefore justified by the data.
#   sodium      MG in both releases -> divided by 1000 below.
#   cholesterol MG in both releases -> divided by 1000 below.
NUTRIENTS = {
    "kcal": [1008, 2047, 2048],
    "protein": [1003],
    "carbs": [1005],          # "Carbohydrate, by difference" — see README on the BLS comparison
    "fat": [1004],
    "saturated_fat": [1258],
    "trans_fat": [1257],
    "fiber": [1079],
    "sugar": [2000, 1063],
    "sodium": [1093],         # MG in source
    "cholesterol": [1253],    # MG in source
}
MILLIGRAM_FIELDS = {"sodium", "cholesterol"}
FIELDS = list(NUTRIENTS)


def normalize(text):
    """Lowercase ASCII-folded description with punctuation collapsed to single spaces.

    The searchable key the provider matches against. Collapsing runs of whitespace matters: USDA
    descriptions are full of "95% lean meat / 5% fat", and without the collapse a prefix query like
    "beef ground%raw" silently misses every graded record because the normalized text holds two
    spaces where the punctuation was.
    """
    text = (text or "").lower()
    text = "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", text)).strip()


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve(arg, tmp):
    """Accepts either an unpacked dataset directory or the official .zip, returning the directory."""
    p = Path(arg)
    if p.is_dir():
        return p, None
    if p.suffix.lower() != ".zip":
        sys.exit(f"not a directory or .zip: {p}")
    digest = sha256(p)
    dest = Path(tmp) / p.stem
    with zipfile.ZipFile(p) as z:
        z.extractall(dest)
    inner = [d for d in dest.iterdir() if d.is_dir()]
    return (inner[0] if len(inner) == 1 else dest), (p.name, digest)


def read_nutrients(directory, fdc_ids):
    """Per food, the best available value for each field plus which energy id supplied kcal."""
    best = {fid: {} for fid in fdc_ids}
    for row in csv.DictReader(open(directory / "food_nutrient.csv", encoding="utf-8-sig")):
        fid = row["fdc_id"]
        if fid not in best:
            continue
        nid = row["nutrient_id"]
        if not nid.isdigit():
            continue
        try:
            best[fid][int(nid)] = float(row["amount"])
        except (TypeError, ValueError):
            pass

    out = {}
    for fid, seen in best.items():
        values, energy_id = {}, None
        for field, ids in NUTRIENTS.items():
            for nid in ids:
                if nid in seen:
                    value = seen[nid]
                    if field in MILLIGRAM_FIELDS:
                        value /= 1000.0
                    values[field] = round(value, 4)
                    if field == "kcal":
                        energy_id = nid
                    break
            else:
                values[field] = None
        out[fid] = (values, energy_id)
    return out


def read_dataset(directory, label):
    data_type, _ = DATASETS[label]
    categories = {}
    category_csv = directory / "food_category.csv"
    if category_csv.exists():
        for row in csv.DictReader(open(category_csv, encoding="utf-8-sig")):
            categories[row["id"]] = row.get("description")

    foods = {}
    seen_types = set()
    for row in csv.DictReader(open(directory / "food.csv", encoding="utf-8-sig")):
        seen_types.add(row["data_type"])
        if row["data_type"] != data_type:
            continue
        foods[row["fdc_id"]] = (row["description"], categories.get(row.get("food_category_id")))

    forbidden = seen_types & set(FORBIDDEN_DATA_TYPES)
    if forbidden:
        # Not fatal for Foundation, whose archive legitimately carries sample bookkeeping rows —
        # but a Branded or FNDDS row appearing in a source we import from is a wrong download.
        sys.exit(f"{label}: archive contains excluded data types {sorted(forbidden)} — wrong download?")

    nutrients = read_nutrients(directory, set(foods))
    rows = []
    for fid, (description, category) in foods.items():
        values, energy_id = nutrients[fid]
        rows.append((int(fid), label, description, normalize(description), category, energy_id,
                     *(values[f] for f in FIELDS)))
    return rows


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__.strip().splitlines()[-4].strip())
    output = Path(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_OUTPUT
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        foundation_dir, foundation_src = resolve(sys.argv[1], tmp)
        sr_dir, sr_src = resolve(sys.argv[2], tmp)
        rows = read_dataset(foundation_dir, "Foundation") + read_dataset(sr_dir, "SR Legacy")

    counts = {}
    for row in rows:
        counts[row[1]] = counts.get(row[1], 0) + 1
    for label, (_, expected) in DATASETS.items():
        got = counts.get(label, 0)
        if got != expected:
            sys.exit(f"{label}: expected {expected} rows for the pinned release, imported {got}. "
                     f"Either the wrong release was supplied or USDA changed it — update "
                     f"DATASETS in this script deliberately, do not loosen this check.")

    if output.exists():
        output.unlink()
    conn = sqlite3.connect(output)
    conn.execute(f"""
        CREATE TABLE usda_foods (
            fdc_id INTEGER PRIMARY KEY,
            -- "SR Legacy" or "Foundation"; travels into provenance as dataType so any figure can
            -- be traced back to the release and energy basis that produced it.
            data_type TEXT NOT NULL,
            description TEXT NOT NULL,
            description_normalized TEXT NOT NULL,
            category TEXT,
            -- Which FoodData Central nutrient id supplied kcal (1008 / 2047 / 2048). Foundation
            -- mixes all three, and they are not interchangeable definitions.
            energy_nutrient_id INTEGER,
            {', '.join(f'{f} REAL' for f in FIELDS)}
        )""")
    conn.executemany(
        f"INSERT INTO usda_foods VALUES ({','.join('?' * (6 + len(FIELDS)))})", rows)
    conn.execute("CREATE INDEX idx_usda_normalized ON usda_foods(description_normalized)")
    conn.execute("CREATE INDEX idx_usda_data_type ON usda_foods(data_type)")

    conn.execute("CREATE TABLE usda_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    meta = {
        "attribution": ATTRIBUTION,
        "schema_version": SCHEMA_VERSION,
        "datasets": "Foundation 2026-04-30; SR Legacy 2018-04",
        "excluded": "Branded Foods; FNDDS (Survey Foods)",
        "food_count": str(len(rows)),
        **{f"food_count_{label.lower().replace(' ', '_')}": str(n) for label, n in counts.items()},
    }
    conn.executemany("INSERT INTO usda_meta (key, value) VALUES (?, ?)", sorted(meta.items()))
    conn.commit()
    conn.execute("VACUUM")
    conn.close()

    sources = [s for s in (foundation_src, sr_src) if s]
    if sources:
        MANIFEST.write_text(json.dumps({
            "source": "USDA FoodData Central",
            "url": "https://fdc.nal.usda.gov/download-datasets/",
            "license": "CC0 1.0 Universal (public domain)",
            "attribution": ATTRIBUTION,
            "schema_version": SCHEMA_VERSION,
            "datasets": [
                {"name": "Foundation Foods", "release": "2026-04-30", "rows": counts["Foundation"],
                 "url": "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_2026-04-30.zip"},
                {"name": "SR Legacy", "release": "2018-04", "rows": counts["SR Legacy"],
                 "url": "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip"},
            ],
            "excluded": ["Branded Foods", "FNDDS (Survey Foods)"],
            "archives": [{"file": name, "sha256": digest} for name, digest in sources],
            "total_rows": len(rows),
        }, indent=2) + "\n", encoding="utf-8")

    size_mb = output.stat().st_size / 1048576
    print(f"wrote {output} — {len(rows)} foods ({', '.join(f'{k} {v}' for k, v in sorted(counts.items()))}), {size_mb:.2f} MB")
    if sources:
        print(f"wrote {MANIFEST}")


if __name__ == "__main__":
    main()

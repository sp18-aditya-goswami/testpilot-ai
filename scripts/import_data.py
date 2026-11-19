"""Imports a file made by scripts/export_data.py into this machine's TestPilot.

    .venv/bin/python scripts/import_data.py exports/testpilot-demo.json

Rows keep their ids. Anything that already exists here with the same id is left alone, so running the
import twice is safe and nothing of yours is overwritten. Use --dry-run to see what would be added.
Secret values were not exported: fill them in again in the app (Environments, or step 1 of a test plan).
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from sqlalchemy import DateTime  # noqa: E402

from backend.db import CollectionRow, EnvironmentRow, FolderRow, ItemRow, ProjectRow, StoredObject, session  # noqa: E402

TABLES = [("projects", ProjectRow), ("environments", EnvironmentRow), ("collections", CollectionRow), ("folders", FolderRow), ("items", ItemRow), ("objects", StoredObject)]


def to_row(model, d: dict):
    values = {}
    for col in model.__table__.columns:
        if col.key not in d:
            continue
        value = d[col.key]
        if value is not None and isinstance(col.type, DateTime):
            value = datetime.fromisoformat(value)
        values[col.key] = value
    return model(**values)


def key_of(model, d: dict):
    cols = [c.key for c in model.__table__.primary_key.columns]
    return tuple(d[c] for c in cols) if len(cols) > 1 else d[cols[0]]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file", help="the export file")
    parser.add_argument("--dry-run", action="store_true", help="show what would be added, change nothing")
    args = parser.parse_args()

    data = json.loads(Path(args.file).read_text())
    if data.get("format") != "testpilot-export" or data.get("version") != 1:
        print("This is not a TestPilot export file (or it is from a newer version).", file=sys.stderr)
        return 1

    added, skipped = {}, {}
    with session() as s:
        for name, model in TABLES:
            added[name] = skipped[name] = 0
            for d in data.get(name, []):
                if s.get(model, key_of(model, d)) is not None:
                    skipped[name] += 1
                    continue
                if not args.dry_run:
                    s.add(to_row(model, d))
                added[name] += 1
            if not args.dry_run:
                s.flush()
        if args.dry_run:
            s.rollback()

    verb = "Would add" if args.dry_run else "Added"
    print(f"{verb}: " + ", ".join(f"{n} {k}" for k, n in added.items()))
    if any(skipped.values()):
        print("Already here, left alone: " + ", ".join(f"{n} {k}" for k, n in skipped.items() if n))
    for p in data.get("projects", []):
        print(f"  project: {p['name']}")
    print(f"Exported from revision {data.get('source_revision', 'unknown')} at {data.get('exported_at', '?')}.")
    print("Secret values were not included: re-enter them in the app where a plan needs a login or token.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

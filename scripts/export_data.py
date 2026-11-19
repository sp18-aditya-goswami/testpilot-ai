"""Exports chosen TestPilot projects to one JSON file another machine can import.

    .venv/bin/python scripts/export_data.py "User Management API" "Shop Orders API" --out exports/testpilot-demo.json

Projects are matched by name or id. Everything that belongs to them is exported: environments, collections,
folders, items (saved requests and test plans), and the specs, plans and runs stored as documents.

Secret environment values are never exported: the variable stays, marked secret, with an empty value, so the
importing side knows what to fill in. AI settings and keys (data/settings.json) are never exported. As a last
guard, the export is refused if any removed secret value still appears in the workspace rows, plans or runs.
Specs are not checked: they are the API's own published documentation (a demo spec may name its test accounts).
"""

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from sqlalchemy import select  # noqa: E402

from backend.db import CollectionRow, EnvironmentRow, FolderRow, ItemRow, ProjectRow, StoredObject, session  # noqa: E402

FORMAT = "testpilot-export"
VERSION = 1
TABLES = [("projects", ProjectRow), ("environments", EnvironmentRow), ("collections", CollectionRow), ("folders", FolderRow), ("items", ItemRow), ("objects", StoredObject)]


def row_dict(row) -> dict:
    out = {}
    for col in row.__table__.columns:
        value = getattr(row, col.key)
        out[col.key] = value.isoformat() if isinstance(value, datetime) else value
    return out


def revision() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return "unknown"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("projects", nargs="+", help="project names or ids to export")
    parser.add_argument("--out", default="exports/testpilot-export.json", help="where to write the export")
    args = parser.parse_args()

    with session() as s:
        all_projects = s.execute(select(ProjectRow)).scalars().all()
        wanted = []
        for ref in args.projects:
            hits = [p for p in all_projects if p.id == ref or p.name.strip().lower() == ref.strip().lower()]
            if not hits:
                print(f"No project named or with id {ref!r}. Projects: {', '.join(p.name for p in all_projects)}", file=sys.stderr)
                return 1
            wanted += [p for p in hits if p not in wanted]
        ids = {p.id for p in wanted}

        envs = s.execute(select(EnvironmentRow).where(EnvironmentRow.project_id.in_(ids))).scalars().all()
        collections = s.execute(select(CollectionRow).where(CollectionRow.project_id.in_(ids))).scalars().all()
        col_ids = {c.id for c in collections}
        folders = s.execute(select(FolderRow).where(FolderRow.collection_id.in_(col_ids))).scalars().all() if col_ids else []
        items = s.execute(select(ItemRow).where(ItemRow.project_id.in_(ids))).scalars().all()
        objects = s.execute(select(StoredObject).where(StoredObject.project_id.in_(ids))).scalars().all()

        removed: set[str] = set()
        env_rows = []
        for env in envs:
            d = row_dict(env)
            variables = json.loads(d["variables"] or "[]")
            for v in variables:
                if v.get("secret"):
                    if v.get("value"):
                        removed.add(str(v["value"]))
                    v["value"] = ""
            d["variables"] = json.dumps(variables)
            env_rows.append(d)

        data = {
            "format": FORMAT,
            "version": VERSION,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "source_revision": revision(),
            "projects": [row_dict(p) for p in wanted],
            "environments": env_rows,
            "collections": [row_dict(c) for c in collections],
            "folders": [row_dict(f) for f in folders],
            "items": [row_dict(i) for i in items],
            "objects": [row_dict(o) for o in objects],
        }

    text = json.dumps(data, indent=1)
    checked = json.dumps({k: v for k, v in data.items() if k != "objects"}) + json.dumps([o for o in data["objects"] if o["kind"] in ("plans", "runs")])
    leaked = [secret for secret in removed if len(secret) >= 4 and secret in checked]
    if leaked:
        print(f"Refusing to write: {len(leaked)} removed secret value(s) still appear inside stored plans or runs.", file=sys.stderr)
        return 2

    out = (ROOT / args.out) if not Path(args.out).is_absolute() else Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    print(f"Wrote {out}")
    for p in data["projects"]:
        print(f"  project: {p['name']}")
    counts = {k: len(data[k]) for k, _ in TABLES}
    print("  " + ", ".join(f"{n} {k}" for k, n in counts.items()))
    print(f"  {len(removed)} secret value(s) removed; AI settings and keys not included")
    return 0


if __name__ == "__main__":
    sys.exit(main())

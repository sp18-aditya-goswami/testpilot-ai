"""Persistence for projects, environments, collections, folders and items."""

import json
from dataclasses import dataclass, field
from urllib.parse import urlparse

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from backend.config import get_settings
from backend.db import CollectionRow, EnvironmentRow, FolderRow, ItemRow, ProjectRow, session
from backend.schemas import new_id, utcnow
from backend.store import NotFound, store
from backend.workspace_schemas import (
    CollectionIn,
    CollectionNode,
    CollectionPatch,
    Environment,
    EnvironmentIn,
    EnvironmentPatch,
    EnvVar,
    EnvVarIn,
    FolderIn,
    FolderNode,
    FolderPatch,
    Item,
    ItemIn,
    ItemMove,
    ItemPatch,
    ItemSummary,
    Project,
    ProjectIn,
    ProjectPatch,
    ProjectTree,
    SavedRequest,
    SavedSuite,
)


class Invalid(ValueError):
    """Input that is well-formed but not allowed (becomes a 422)."""


@dataclass
class EnvRuntime:
    name: str
    base_url: str
    variables: dict[str, str] = field(default_factory=dict)
    secret_values: set[str] = field(default_factory=set)


# ---------- helpers ----------

def _get(s: Session, model, object_id: str, label: str):
    row = s.get(model, object_id)
    if row is None:
        raise NotFound(f"{label} not found")
    return row


def host_allowed(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return bool(host) and host in get_settings().allowed_host_set


def _check_base_url(url: str) -> str:
    url = url.strip().rstrip("/")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise Invalid("Base URL must be an http or https URL, for example http://localhost:8000")
    return url


def _next_position(s: Session, model, **where) -> int:
    q = select(func.max(model.position))
    for col, value in where.items():
        attr = getattr(model, col)
        q = q.where(attr.is_(None) if value is None else attr == value)
    current = s.execute(q).scalar()
    return 0 if current is None else current + 1


# ---------- projects ----------

def _project_out(s: Session, row: ProjectRow) -> Project:
    runs = store.list_rows("runs", row.id)
    return Project(
        id=row.id,
        name=row.name,
        description=row.description or "",
        created_at=row.created_at,
        collection_count=s.execute(select(func.count()).select_from(CollectionRow).where(CollectionRow.project_id == row.id)).scalar() or 0,
        environment_count=s.execute(select(func.count()).select_from(EnvironmentRow).where(EnvironmentRow.project_id == row.id)).scalar() or 0,
        run_count=len(runs),
        last_run_at=max((r.created_at for r in runs), default=None),
    )


def list_projects() -> list[Project]:
    with session() as s:
        rows = s.execute(select(ProjectRow).order_by(ProjectRow.created_at)).scalars().all()
        return [_project_out(s, r) for r in rows]


def get_project(project_id: str) -> Project:
    with session() as s:
        return _project_out(s, _get(s, ProjectRow, project_id, "Project"))


def require_project(project_id: str) -> None:
    with session() as s:
        _get(s, ProjectRow, project_id, "Project")


def create_project(body: ProjectIn) -> Project:
    with session() as s:
        row = ProjectRow(id=new_id("prj"), name=body.name.strip(), description=body.description.strip(), created_at=utcnow())
        s.add(row)
        s.flush()
        return _project_out(s, row)


def update_project(project_id: str, body: ProjectPatch) -> Project:
    with session() as s:
        row = _get(s, ProjectRow, project_id, "Project")
        if body.name is not None:
            row.name = body.name.strip()
        if body.description is not None:
            row.description = body.description.strip()
        s.flush()
        return _project_out(s, row)


def delete_project(project_id: str) -> None:
    with session() as s:
        _get(s, ProjectRow, project_id, "Project")
        collection_ids = s.execute(select(CollectionRow.id).where(CollectionRow.project_id == project_id)).scalars().all()
        if collection_ids:
            s.execute(delete(FolderRow).where(FolderRow.collection_id.in_(collection_ids)))
        s.execute(delete(ItemRow).where(ItemRow.project_id == project_id))
        s.execute(delete(CollectionRow).where(CollectionRow.project_id == project_id))
        s.execute(delete(EnvironmentRow).where(EnvironmentRow.project_id == project_id))
        s.execute(delete(ProjectRow).where(ProjectRow.id == project_id))
    store.delete_project(project_id)


# ---------- environments ----------

def _vars_of(row: EnvironmentRow) -> list[dict]:
    try:
        return json.loads(row.variables or "[]")
    except ValueError:
        return []


def _env_out(row: EnvironmentRow) -> Environment:
    return Environment(
        id=row.id,
        project_id=row.project_id,
        name=row.name,
        base_url=row.base_url,
        variables=[
            EnvVar(key=v["key"], value="" if v.get("secret") else v.get("value", ""), secret=bool(v.get("secret")), has_value=bool(v.get("value")))
            for v in _vars_of(row)
        ],
        is_default=row.is_default,
        base_url_allowed=host_allowed(row.base_url),
    )


def _merge_vars(incoming: list[EnvVarIn], existing: list[dict]) -> list[dict]:
    keys = [v.key for v in incoming]
    if len(keys) != len(set(keys)):
        raise Invalid("Variable names must be unique within an environment")
    old = {v["key"]: v for v in existing}
    merged = []
    for v in incoming:
        value = v.value
        if value is None:
            value = old.get(v.key, {}).get("value", "") if v.secret else ""
        merged.append({"key": v.key, "value": value, "secret": v.secret})
    return merged


def _make_default(s: Session, row: EnvironmentRow) -> None:
    for other in s.execute(select(EnvironmentRow).where(EnvironmentRow.project_id == row.project_id)).scalars():
        other.is_default = other.id == row.id


def add_missing_variables(project_id: str, defaults: dict[str, str]) -> list[str]:
    """Adds each variable an environment of the project lacks; never overwrites. Returns the keys added anywhere."""
    added: set[str] = set()
    with session() as s:
        for row in s.execute(select(EnvironmentRow).where(EnvironmentRow.project_id == project_id)).scalars():
            current = _vars_of(row)
            have = {v["key"] for v in current}
            new = [{"key": k, "value": v, "secret": False} for k, v in defaults.items() if k not in have]
            if new:
                row.variables = json.dumps(current + new)
                added.update(v["key"] for v in new)
    return sorted(added)


def list_environments(s: Session, project_id: str) -> list[Environment]:
    rows = s.execute(select(EnvironmentRow).where(EnvironmentRow.project_id == project_id).order_by(EnvironmentRow.created_at)).scalars().all()
    return [_env_out(r) for r in rows]


def create_environment(project_id: str, body: EnvironmentIn) -> Environment:
    with session() as s:
        _get(s, ProjectRow, project_id, "Project")
        first = not s.execute(select(EnvironmentRow.id).where(EnvironmentRow.project_id == project_id)).first()
        row = EnvironmentRow(
            id=new_id("env"),
            project_id=project_id,
            name=body.name.strip(),
            base_url=_check_base_url(body.base_url),
            variables=json.dumps(_merge_vars(body.variables, [])),
            is_default=False,
            created_at=utcnow(),
        )
        s.add(row)
        s.flush()
        if first or body.is_default:
            _make_default(s, row)
        return _env_out(row)


def update_environment(env_id: str, body: EnvironmentPatch) -> Environment:
    with session() as s:
        row = _get(s, EnvironmentRow, env_id, "Environment")
        if body.name is not None:
            row.name = body.name.strip()
        if body.base_url is not None:
            row.base_url = _check_base_url(body.base_url)
        if body.variables is not None:
            row.variables = json.dumps(_merge_vars(body.variables, _vars_of(row)))
        if body.is_default:
            _make_default(s, row)
        s.flush()
        return _env_out(row)


def delete_environment(env_id: str) -> None:
    with session() as s:
        row = _get(s, EnvironmentRow, env_id, "Environment")
        was_default, project_id = row.is_default, row.project_id
        s.delete(row)
        s.flush()
        if was_default:
            nxt = s.execute(select(EnvironmentRow).where(EnvironmentRow.project_id == project_id).order_by(EnvironmentRow.created_at)).scalars().first()
            if nxt:
                nxt.is_default = True


def environment_runtime(environment_id: str) -> EnvRuntime:
    """The values a run needs, including secrets; never return this to a client."""
    with session() as s:
        row = _get(s, EnvironmentRow, environment_id, "Environment")
        variables = {v["key"]: str(v.get("value", "")) for v in _vars_of(row)}
        secrets = {str(v.get("value")) for v in _vars_of(row) if v.get("secret") and v.get("value")}
        return EnvRuntime(name=row.name, base_url=row.base_url, variables=variables, secret_values=secrets)


def environment_project(environment_id: str) -> str:
    with session() as s:
        return _get(s, EnvironmentRow, environment_id, "Environment").project_id


# ---------- collections and folders ----------

def _summary(row: ItemRow) -> ItemSummary:
    method = None
    if row.kind == "request" and row.request:
        method = json.loads(row.request).get("method")
    return ItemSummary(id=row.id, kind=row.kind, name=row.name, method=method, position=row.position)


def _collection_node(s: Session, col: CollectionRow) -> CollectionNode:
    folders = s.execute(select(FolderRow).where(FolderRow.collection_id == col.id)).scalars().all()
    items = s.execute(select(ItemRow).where(ItemRow.collection_id == col.id)).scalars().all()
    children: dict[str | None, list[FolderRow]] = {}
    for f in folders:
        children.setdefault(f.parent_id, []).append(f)
    by_folder: dict[str | None, list[ItemRow]] = {}
    for i in items:
        by_folder.setdefault(i.folder_id, []).append(i)

    def node(f: FolderRow) -> FolderNode:
        return FolderNode(
            id=f.id,
            name=f.name,
            parent_id=f.parent_id,
            position=f.position,
            folders=[node(c) for c in sorted(children.get(f.id, []), key=lambda r: (r.position, r.name))],
            items=[_summary(i) for i in sorted(by_folder.get(f.id, []), key=lambda r: (r.position, r.name))],
        )

    return CollectionNode(
        id=col.id,
        name=col.name,
        description=col.description or "",
        position=col.position,
        folders=[node(f) for f in sorted(children.get(None, []), key=lambda r: (r.position, r.name))],
        items=[_summary(i) for i in sorted(by_folder.get(None, []), key=lambda r: (r.position, r.name))],
    )


def project_tree(project_id: str) -> ProjectTree:
    with session() as s:
        row = _get(s, ProjectRow, project_id, "Project")
        cols = s.execute(select(CollectionRow).where(CollectionRow.project_id == project_id).order_by(CollectionRow.position)).scalars().all()
        return ProjectTree(
            project=_project_out(s, row),
            environments=list_environments(s, project_id),
            collections=[_collection_node(s, c) for c in cols],
        )


def create_collection(project_id: str, body: CollectionIn) -> CollectionNode:
    with session() as s:
        _get(s, ProjectRow, project_id, "Project")
        row = CollectionRow(
            id=new_id("col"),
            project_id=project_id,
            name=body.name.strip(),
            description=body.description.strip(),
            position=_next_position(s, CollectionRow, project_id=project_id),
        )
        s.add(row)
        s.flush()
        return _collection_node(s, row)


def get_collection(collection_id: str) -> CollectionNode:
    with session() as s:
        return _collection_node(s, _get(s, CollectionRow, collection_id, "Collection"))


def collection_meta(collection_id: str) -> tuple[str, str]:
    """(project_id, name)"""
    with session() as s:
        row = _get(s, CollectionRow, collection_id, "Collection")
        return row.project_id, row.name


def update_collection(collection_id: str, body: CollectionPatch) -> CollectionNode:
    with session() as s:
        row = _get(s, CollectionRow, collection_id, "Collection")
        if body.name is not None:
            row.name = body.name.strip()
        if body.description is not None:
            row.description = body.description.strip()
        s.flush()
        return _collection_node(s, row)


def delete_collection(collection_id: str) -> None:
    with session() as s:
        _get(s, CollectionRow, collection_id, "Collection")
        s.execute(delete(ItemRow).where(ItemRow.collection_id == collection_id))
        s.execute(delete(FolderRow).where(FolderRow.collection_id == collection_id))
        s.execute(delete(CollectionRow).where(CollectionRow.id == collection_id))


def _folder_node(s: Session, folder: FolderRow) -> FolderNode:
    col = _collection_node(s, _get(s, CollectionRow, folder.collection_id, "Collection"))

    def find(nodes: list[FolderNode]) -> FolderNode | None:
        for n in nodes:
            if n.id == folder.id:
                return n
            hit = find(n.folders)
            if hit:
                return hit
        return None

    found = find(col.folders)
    assert found is not None
    return found


def create_folder(collection_id: str, body: FolderIn) -> FolderNode:
    with session() as s:
        _get(s, CollectionRow, collection_id, "Collection")
        if body.parent_id is not None:
            parent = _get(s, FolderRow, body.parent_id, "Parent folder")
            if parent.collection_id != collection_id:
                raise Invalid("The parent folder belongs to another collection")
        row = FolderRow(
            id=new_id("fld"),
            collection_id=collection_id,
            parent_id=body.parent_id,
            name=body.name.strip(),
            position=_next_position(s, FolderRow, collection_id=collection_id, parent_id=body.parent_id),
        )
        s.add(row)
        s.flush()
        return _folder_node(s, row)


def folder_meta(folder_id: str) -> tuple[str, str, str]:
    """(project_id, collection_id, name)"""
    with session() as s:
        row = _get(s, FolderRow, folder_id, "Folder")
        col = _get(s, CollectionRow, row.collection_id, "Collection")
        return col.project_id, row.collection_id, row.name


def update_folder(folder_id: str, body: FolderPatch) -> FolderNode:
    with session() as s:
        row = _get(s, FolderRow, folder_id, "Folder")
        if body.name is not None:
            row.name = body.name.strip()
        if "parent_id" in body.model_fields_set and body.parent_id != row.parent_id:
            new_parent = body.parent_id
            if new_parent is not None:
                parent = _get(s, FolderRow, new_parent, "Parent folder")
                if parent.collection_id != row.collection_id:
                    raise Invalid("A folder can only move within its collection")
                cursor: FolderRow | None = parent
                while cursor is not None:
                    if cursor.id == row.id:
                        raise Invalid("A folder cannot move into itself or one of its subfolders")
                    cursor = s.get(FolderRow, cursor.parent_id) if cursor.parent_id else None
            row.parent_id = new_parent
            row.position = _next_position(s, FolderRow, collection_id=row.collection_id, parent_id=new_parent)
        s.flush()
        return _folder_node(s, row)


def _subtree_folder_ids(s: Session, folder_id: str) -> list[str]:
    ids, frontier = [folder_id], [folder_id]
    while frontier:
        kids = s.execute(select(FolderRow.id).where(FolderRow.parent_id.in_(frontier))).scalars().all()
        ids += kids
        frontier = list(kids)
    return ids


def delete_folder(folder_id: str) -> None:
    with session() as s:
        _get(s, FolderRow, folder_id, "Folder")
        ids = _subtree_folder_ids(s, folder_id)
        s.execute(delete(ItemRow).where(ItemRow.folder_id.in_(ids)))
        s.execute(delete(FolderRow).where(FolderRow.id.in_(ids)))


# ---------- items ----------

def _item_out(row: ItemRow) -> Item:
    return Item(
        id=row.id,
        project_id=row.project_id,
        collection_id=row.collection_id,
        folder_id=row.folder_id,
        kind=row.kind,
        name=row.name,
        position=row.position,
        request=SavedRequest.model_validate_json(row.request) if row.request else None,
        suite=SavedSuite.model_validate_json(row.suite) if row.suite else None,
        updated_at=row.updated_at,
    )


def _check_folder(s: Session, collection_id: str, folder_id: str | None) -> None:
    if folder_id is not None:
        folder = _get(s, FolderRow, folder_id, "Folder")
        if folder.collection_id != collection_id:
            raise Invalid("The folder belongs to another collection")


def create_item(collection_id: str, body: ItemIn) -> Item:
    with session() as s:
        col = _get(s, CollectionRow, collection_id, "Collection")
        _check_folder(s, collection_id, body.folder_id)
        request = body.request or (SavedRequest() if body.kind == "request" else None)
        suite = body.suite or (SavedSuite() if body.kind == "suite" else None)
        row = ItemRow(
            id=new_id("itm"),
            project_id=col.project_id,
            collection_id=collection_id,
            folder_id=body.folder_id,
            kind=body.kind,
            name=body.name.strip(),
            position=_next_position(s, ItemRow, collection_id=collection_id, folder_id=body.folder_id),
            request=request.model_dump_json() if body.kind == "request" and request else None,
            suite=suite.model_dump_json() if body.kind == "suite" and suite else None,
            updated_at=utcnow(),
        )
        s.add(row)
        s.flush()
        return _item_out(row)


def get_item(item_id: str) -> Item:
    with session() as s:
        return _item_out(_get(s, ItemRow, item_id, "Item"))


def update_item(item_id: str, body: ItemPatch) -> Item:
    with session() as s:
        row = _get(s, ItemRow, item_id, "Item")
        if body.name is not None:
            row.name = body.name.strip()
        if body.request is not None:
            if row.kind != "request":
                raise Invalid("Only request items hold a request")
            row.request = body.request.model_dump_json()
        if body.suite is not None:
            if row.kind != "suite":
                raise Invalid("Only suite items hold a suite")
            row.suite = body.suite.model_dump_json()
        row.updated_at = utcnow()
        s.flush()
        return _item_out(row)


def _siblings(s: Session, collection_id: str, folder_id: str | None, exclude: str) -> list[ItemRow]:
    q = select(ItemRow).where(ItemRow.collection_id == collection_id, ItemRow.id != exclude)
    q = q.where(ItemRow.folder_id.is_(None) if folder_id is None else ItemRow.folder_id == folder_id)
    return list(s.execute(q.order_by(ItemRow.position, ItemRow.name)).scalars().all())


def move_item(item_id: str, body: ItemMove) -> Item:
    with session() as s:
        row = _get(s, ItemRow, item_id, "Item")
        col = _get(s, CollectionRow, body.collection_id, "Collection")
        if col.project_id != row.project_id:
            raise Invalid("Items can only move within their project")
        _check_folder(s, body.collection_id, body.folder_id)
        siblings = _siblings(s, body.collection_id, body.folder_id, row.id)
        index = len(siblings) if body.position is None else max(0, min(body.position, len(siblings)))
        siblings.insert(index, row)
        row.collection_id, row.folder_id = body.collection_id, body.folder_id
        for pos, sib in enumerate(siblings):
            sib.position = pos
        row.updated_at = utcnow()
        s.flush()
        return _item_out(row)


def duplicate_item(item_id: str) -> Item:
    with session() as s:
        src = _get(s, ItemRow, item_id, "Item")
        siblings = _siblings(s, src.collection_id, src.folder_id, "")
        copy = ItemRow(
            id=new_id("itm"),
            project_id=src.project_id,
            collection_id=src.collection_id,
            folder_id=src.folder_id,
            kind=src.kind,
            name=f"{src.name} copy"[:120],
            position=0,
            request=src.request,
            suite=src.suite,
            updated_at=utcnow(),
        )
        ordered: list[ItemRow] = []
        for sib in siblings:
            ordered.append(sib)
            if sib.id == src.id:
                ordered.append(copy)
        s.add(copy)
        for pos, sib in enumerate(ordered):
            sib.position = pos
        s.flush()
        return _item_out(copy)


def delete_item(item_id: str) -> None:
    with session() as s:
        s.delete(_get(s, ItemRow, item_id, "Item"))


def requests_in(collection_id: str, folder_id: str | None = None) -> list[Item]:
    """Saved requests of a collection or folder subtree in tree order: a level's items, then its folders."""
    with session() as s:
        _get(s, CollectionRow, collection_id, "Collection")
        folders = s.execute(select(FolderRow).where(FolderRow.collection_id == collection_id)).scalars().all()
        items = s.execute(select(ItemRow).where(ItemRow.collection_id == collection_id, ItemRow.kind == "request")).scalars().all()
        children: dict[str | None, list[FolderRow]] = {}
        for f in folders:
            children.setdefault(f.parent_id, []).append(f)
        by_folder: dict[str | None, list[ItemRow]] = {}
        for i in items:
            by_folder.setdefault(i.folder_id, []).append(i)

        out: list[Item] = []

        def walk(fid: str | None) -> None:
            out.extend(_item_out(i) for i in sorted(by_folder.get(fid, []), key=lambda r: (r.position, r.name)))
            for f in sorted(children.get(fid, []), key=lambda r: (r.position, r.name)):
                walk(f.id)

        walk(folder_id)
        return out



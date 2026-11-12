from __future__ import annotations

import json
import re
from typing import TypeVar

from pydantic import BaseModel
from sqlalchemy import delete, select

from backend.db import StoredObject, session
from backend.schemas import utcnow

M = TypeVar("M", bound=BaseModel)
SAFE_ID = re.compile(r"^[a-z]+_[0-9a-f]{10}$")


class NotFound(KeyError):
    pass


class Store:
    """Specs, plans and runs as JSON documents in SQLite. Safe to call from worker threads."""

    def _check(self, object_id: str) -> None:
        if not SAFE_ID.match(object_id):
            raise NotFound(object_id)

    def _put(self, kind: str, object_id: str, text: str, project_id: str | None) -> None:
        self._check(object_id)
        with session() as s:
            row = s.get(StoredObject, (kind, object_id))
            if row is None:
                s.add(StoredObject(kind=kind, id=object_id, project_id=project_id, data=text))
            else:
                row.data = text
                row.updated_at = utcnow()
                if project_id is not None:
                    row.project_id = project_id

    def _get(self, kind: str, object_id: str) -> StoredObject:
        self._check(object_id)
        with session() as s:
            row = s.get(StoredObject, (kind, object_id))
            if row is None:
                raise NotFound(object_id)
            return row

    def save(self, kind: str, object_id: str, model: BaseModel, project_id: str | None = None) -> None:
        if project_id is None:
            project_id = getattr(model, "project_id", None)
        self._put(kind, object_id, model.model_dump_json(), project_id)

    def save_raw(self, kind: str, object_id: str, data: dict, project_id: str | None = None) -> None:
        self._put(kind, object_id, json.dumps(data), project_id)

    def load(self, kind: str, object_id: str, model: type[M]) -> M:
        return model.model_validate_json(self._get(kind, object_id).data)

    def load_raw(self, kind: str, object_id: str) -> dict:
        return json.loads(self._get(kind, object_id).data)

    def project_of(self, kind: str, object_id: str) -> str | None:
        return self._get(kind, object_id).project_id

    def created_at(self, kind: str, object_id: str):
        return self._get(kind, object_id).created_at

    def list(self, kind: str, model: type[M], project_id: str | None = None) -> list[M]:
        with session() as s:
            q = select(StoredObject.data).where(StoredObject.kind == kind)
            if project_id is not None:
                q = q.where(StoredObject.project_id == project_id)
            rows = s.execute(q.order_by(StoredObject.updated_at.desc())).scalars().all()
        return [model.model_validate_json(r) for r in rows]

    def list_rows(self, kind: str, project_id: str | None = None) -> list[StoredObject]:
        with session() as s:
            q = select(StoredObject).where(StoredObject.kind == kind)
            if project_id is not None:
                q = q.where(StoredObject.project_id == project_id)
            return list(s.execute(q.order_by(StoredObject.updated_at.desc())).scalars().all())

    def delete_project(self, project_id: str) -> None:
        with session() as s:
            s.execute(delete(StoredObject).where(StoredObject.project_id == project_id))


store = Store()

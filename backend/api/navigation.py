"""Where a spec or a suite is used: its suites, plans and runs, for navigating a project."""

import json
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from backend.api.core import RunListItem
from backend.db import CollectionRow, ItemRow, session
from backend.schemas import Run, TestPlan
from backend.state import active_runs
from backend.store import NotFound, store

router = APIRouter()


class PlanSummary(BaseModel):
    id: str
    created_at: datetime
    status: Literal["planning", "ready", "failed"]
    case_count: int
    ai_case_count: int
    ai_status: Literal["ok", "disabled", "error", "skipped"]
    suite_item_id: str | None
    spec_id: str


class SuiteRef(BaseModel):
    item_id: str
    name: str
    collection_id: str
    collection_name: str
    last_plan_id: str | None
    last_run_id: str | None


class SpecUsage(BaseModel):
    suites: list[SuiteRef]
    plans: list[PlanSummary]
    runs: list[RunListItem]


class ItemHistory(BaseModel):
    plans: list[PlanSummary]
    runs: list[RunListItem]


def _plan_summary(p: TestPlan) -> PlanSummary:
    return PlanSummary(
        id=p.id,
        created_at=p.created_at,
        status=p.status,
        case_count=len(p.cases),
        ai_case_count=sum(1 for c in p.cases if c.source == "ai"),
        ai_status=p.ai_status,
        suite_item_id=p.suite_item_id,
        spec_id=p.spec_id,
    )


def _runs(project_id: str | None) -> list[Run]:
    runs = {r.id: r for r in store.list("runs", Run, project_id=project_id)}
    runs.update({k: v for k, v in active_runs.items() if project_id is None or v.project_id == project_id})
    return sorted(runs.values(), key=lambda r: r.created_at, reverse=True)


def _run_item(r: Run) -> RunListItem:
    return RunListItem(**r.model_dump(include=set(RunListItem.model_fields)))


@router.get("/api/specs/{spec_id}/usage", response_model=SpecUsage)
def spec_usage(spec_id: str):
    try:
        project_id = store.project_of("specs", spec_id)
    except NotFound:
        raise HTTPException(status_code=404, detail="Specification not found")

    suites: list[SuiteRef] = []
    with session() as s:
        q = select(ItemRow, CollectionRow.name).join(CollectionRow, CollectionRow.id == ItemRow.collection_id).where(ItemRow.kind == "suite")
        if project_id is not None:
            q = q.where(ItemRow.project_id == project_id)
        for item, collection_name in s.execute(q.order_by(ItemRow.updated_at.desc())).all():
            try:
                suite = json.loads(item.suite or "{}")
            except ValueError:
                continue
            if suite.get("spec_id") != spec_id:
                continue
            suites.append(
                SuiteRef(
                    item_id=item.id,
                    name=item.name,
                    collection_id=item.collection_id,
                    collection_name=collection_name,
                    last_plan_id=suite.get("last_plan_id"),
                    last_run_id=suite.get("last_run_id"),
                )
            )

    plans = sorted(
        (p for p in store.list("plans", TestPlan, project_id=project_id) if p.spec_id == spec_id),
        key=lambda p: p.created_at,
        reverse=True,
    )
    plan_ids = {p.id for p in plans}
    runs = [_run_item(r) for r in _runs(project_id) if r.plan_id in plan_ids]
    return SpecUsage(suites=suites, plans=[_plan_summary(p) for p in plans], runs=runs)


@router.get("/api/items/{item_id}/history", response_model=ItemHistory)
def item_history(item_id: str):
    with session() as s:
        item = s.get(ItemRow, item_id)
        if item is None:
            raise HTTPException(status_code=404, detail="Item not found")
        project_id = item.project_id

    plans = sorted(
        (p for p in store.list("plans", TestPlan, project_id=project_id) if p.suite_item_id == item_id),
        key=lambda p: p.created_at,
        reverse=True,
    )
    plan_ids = {p.id for p in plans}
    runs = [_run_item(r) for r in _runs(project_id) if r.source_id == item_id or r.plan_id in plan_ids]
    return ItemHistory(plans=[_plan_summary(p) for p in plans], runs=runs)

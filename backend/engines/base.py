from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from backend.schemas import ApiSummary, RejectedCase, TestCase


@dataclass
class PlanContext:
    api: ApiSummary
    instruction: str = ""
    business_rules: str = ""
    focus_endpoints: list[str] = field(default_factory=list)
    max_cases: int = 25


@dataclass
class EngineOutput:
    cases: list[TestCase]
    rejected: list[RejectedCase] = field(default_factory=list)
    status: str = "ok"
    message: str = ""


class PlanningEngine(ABC):
    name: str

    @abstractmethod
    def plan(self, ctx: PlanContext) -> EngineOutput: ...

    @staticmethod
    def endpoints_in_scope(ctx: PlanContext):
        if not ctx.focus_endpoints:
            return ctx.api.endpoints
        return [e for e in ctx.api.endpoints if e.id in ctx.focus_endpoints]

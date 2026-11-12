import asyncio

from backend.schemas import Run

active_runs: dict[str, Run] = {}
_tasks: set[asyncio.Task] = set()


def spawn(coro) -> None:
    """Run a coroutine in the background and keep a reference until it finishes."""
    task = asyncio.create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request

from demo_api.database import reset_db
from demo_api.routes.users import router as users_router


@asynccontextmanager
async def lifespan(_: FastAPI):
    reset_db()
    yield


app = FastAPI(
    lifespan=lifespan,
    title="User Management API",
    description=(
        "Demo API for TestPilot AI. Business rules: name required, email unique and "
        "valid, password at least 8 characters, deleted users not retrievable."
    ),
    version="1.0.0",
)
app.include_router(users_router)

LATENCY_S = int(os.environ.get("DEMO_API_LATENCY_MS", "0")) / 1000


@app.middleware("http")
async def simulated_latency(request: Request, call_next):
    if LATENCY_S:
        await asyncio.sleep(LATENCY_S)
    return await call_next(request)


@app.get("/health", tags=["meta"])
def health():
    return {"status": "ok"}

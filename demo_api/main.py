import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.openapi.utils import get_openapi

from demo_api.database import reset_db
from demo_api.routes.auth import router as auth_router
from demo_api.routes.shop import reset_shop
from demo_api.routes.shop import router as shop_router
from demo_api.routes.users import router as users_router


@asynccontextmanager
async def lifespan(_: FastAPI):
    reset_db()
    reset_shop()
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
app.include_router(auth_router)
app.include_router(shop_router, include_in_schema=False)  # it has its own spec, below


@app.get("/shop/openapi.json", include_in_schema=False)
def shop_openapi():
    """The login-only Shop API's own spec: sign-in, no sign-up."""
    return get_openapi(
        title="Shop Orders API",
        version="1.0.0",
        description="Demo API for TestPilot AI with a login and no sign-up. Test accounts: alice / alice-pass-1 and bob / bob-pass-2.",
        routes=shop_router.routes,
    )

LATENCY_S = int(os.environ.get("DEMO_API_LATENCY_MS", "0")) / 1000


@app.middleware("http")
async def simulated_latency(request: Request, call_next):
    if LATENCY_S:
        await asyncio.sleep(LATENCY_S)
    return await call_next(request)


@app.get("/health", tags=["meta"])
def health():
    return {"status": "ok"}

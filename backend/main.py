from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api import core, navigation, planning, settings, workspace

app = FastAPI(title="TestPilot AI", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(core.router)
app.include_router(planning.router)
app.include_router(workspace.router)
app.include_router(navigation.router)
app.include_router(settings.router)

import secrets

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from demo_api.database import get_db
from demo_api.models import User
from demo_api.schemas import UserOut

router = APIRouter(prefix="/api/auth", tags=["auth"])
bearer = HTTPBearer(auto_error=False)
_sessions: dict[str, int] = {}  # token -> user id, in memory only


class LoginIn(BaseModel):
    email: str
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


@router.post("/login", response_model=TokenOut, summary="Sign in and get a bearer token")
def login(payload: LoginIn, db: Session = Depends(get_db)):
    user = db.scalars(select(User).where(User.email == payload.email, User.password == payload.password)).first()
    if user is None:
        raise HTTPException(status_code=401, detail="Wrong email or password")
    token = secrets.token_urlsafe(24)
    _sessions[token] = user.id
    return TokenOut(access_token=token)


def signed_in_user(credentials: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)) -> User:
    """The user behind the bearer token; 401 without a valid one."""
    user_id = _sessions.get(credentials.credentials) if credentials else None
    user = db.get(User, user_id) if user_id else None
    if user is None:
        raise HTTPException(status_code=401, detail="Sign in first")
    return user


@router.get("/me", response_model=UserOut, summary="The signed-in user")
def me(user: User = Depends(signed_in_user)):
    return user

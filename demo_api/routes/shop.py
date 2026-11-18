"""A second, login-only demo API: there is no sign-up, so TestPilot must ask for a test login.

Two accounts exist: alice / alice-pass-1 and bob / bob-pass-2. Orders live in memory.
Planted bug: GET /shop/orders/{order_id} returns any user's order, not only your own.
"""

import secrets

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

router = APIRouter(prefix="/shop", tags=["shop"])
bearer = HTTPBearer(auto_error=False)

ACCOUNTS = {"alice": "alice-pass-1", "bob": "bob-pass-2"}
_sessions: dict[str, str] = {}  # token -> username
_orders: dict[int, dict] = {}
_next_id = [1]


def reset_shop() -> None:
    _sessions.clear()
    _orders.clear()
    _next_id[0] = 1


class LoginIn(BaseModel):
    username: str
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


class OrderIn(BaseModel):
    item: str = Field(..., min_length=1, max_length=100, description="What is being ordered.")
    quantity: int = Field(..., ge=1, le=100, description="Between 1 and 100.")


class OrderOut(BaseModel):
    id: int
    item: str
    quantity: int
    owner: str


def signed_in(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> str:
    username = _sessions.get(credentials.credentials) if credentials else None
    if username is None:
        raise HTTPException(status_code=401, detail="Sign in first")
    return username


@router.post("/auth/login", response_model=TokenOut, summary="Sign in and get a bearer token")
def login(payload: LoginIn):
    if ACCOUNTS.get(payload.username) != payload.password:
        raise HTTPException(status_code=401, detail="Wrong username or password")
    token = secrets.token_urlsafe(24)
    _sessions[token] = payload.username
    return TokenOut(access_token=token)


@router.get("/orders", response_model=list[OrderOut], summary="Your orders")
def list_orders(me: str = Depends(signed_in)):
    return [o for o in _orders.values() if o["owner"] == me]


@router.post("/orders", response_model=OrderOut, status_code=201, summary="Place an order")
def create_order(payload: OrderIn, me: str = Depends(signed_in)):
    order = {"id": _next_id[0], "item": payload.item, "quantity": payload.quantity, "owner": me}
    _orders[order["id"]] = order
    _next_id[0] += 1
    return order


@router.get(
    "/orders/{order_id}",
    response_model=OrderOut,
    summary="One of your orders",
    description="Returns 404 when the order does not exist or belongs to someone else.",
    responses={404: {"description": "No such order of yours"}},
)
def get_order(order_id: int, me: str = Depends(signed_in)):
    order = _orders.get(order_id)
    # Planted bug for the demo: the owner check is missing, so anyone signed in can read any order.
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    return order

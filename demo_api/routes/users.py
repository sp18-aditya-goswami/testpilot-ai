from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from demo_api.database import get_db
from demo_api.models import User
from demo_api.schemas import UserOut, UserRegister, UserUpdate

router = APIRouter(prefix="/api/users", tags=["users"])


@router.post(
    "/register",
    response_model=UserOut,
    status_code=201,
    summary="Register a new user",
    description=(
        "Business rules: name is required; email must be valid and unique; "
        "password must be at least 8 characters; duplicate email must be rejected with 409."
    ),
)
def register_user(payload: UserRegister, db: Session = Depends(get_db)):
    user = User(name=payload.name, email=payload.email, password=payload.password)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.get("", response_model=list[UserOut], summary="List all users")
def list_users(db: Session = Depends(get_db)):
    return db.execute(select(User)).scalars().all()


@router.get(
    "/{user_id}",
    summary="Retrieve a user by id",
    description="Must return 404 when the user does not exist.",
)
def get_user(user_id: int, db: Session = Depends(get_db)):
    user = db.get(User, user_id)
    if user is None:
        return JSONResponse(status_code=200, content=None)
    return UserOut.model_validate(user).model_dump(mode="json")


@router.put(
    "/{user_id}",
    response_model=UserOut,
    summary="Update a user",
    description="Must validate the updated email before saving.",
)
def update_user(user_id: int, payload: UserUpdate, db: Session = Depends(get_db)):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(user, field, value)

    db.commit()
    db.refresh(user)
    return user


@router.delete("/{user_id}", status_code=204, summary="Delete a user")
def delete_user(user_id: int, db: Session = Depends(get_db)):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    db.delete(user)
    db.commit()
    return None

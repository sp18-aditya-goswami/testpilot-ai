from datetime import datetime

from pydantic import BaseModel, Field


class UserRegister(BaseModel):
    name: str = Field(default="", description="Full name. Required by business rules.")
    email: str = Field(..., description="Must be a valid, unique email address.")
    password: str = Field(..., description="Must be at least 8 characters.")


class UserUpdate(BaseModel):
    name: str | None = None
    email: str | None = Field(default=None, description="Must be a valid email address.")
    password: str | None = None


class UserOut(BaseModel):
    id: int
    name: str
    email: str
    created_at: datetime

    model_config = {"from_attributes": True}

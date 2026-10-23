"""新版知识页面请求，拒绝未知字段和不明确的修订。"""
from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator


class KnowledgeMutation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: str = Field(min_length=1, max_length=120)
    actorId: str = Field(min_length=1, max_length=100)
    baseRevision: str = Field(pattern=r"^KG-[1-9][0-9]*$")
    changeId: str | None = None
    revision: int | None = Field(default=None, ge=1)
    draft: dict[str, Any] | None = None
    submission: int | None = Field(default=None, ge=1)
    approved: bool | None = None
    opinion: str = Field(default="", max_length=500)
    versionId: str | None = None
    reason: str = Field(default="", max_length=500)


class KnowledgePage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pageNum: int = Field(default=1, ge=1)
    pageSize: Literal[5, 10, 20, 50] = 20
    state: Literal["DRAFT", "PENDING", "APPROVED", "REJECTED", "PUBLISHED"] | None = None

    @field_validator("pageSize", mode="before")
    @classmethod
    def query_page_size(cls, value):
        return int(value) if isinstance(value, str) and value.isdigit() else value


class KnowledgeAttribute(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    value: str = Field(max_length=2000)
    unit: str | None = Field(default=None, max_length=100)


class PrincipleStep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=40)
    description: str = Field(max_length=200)


class PrincipleFlow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    steps: list[PrincipleStep] = Field(min_length=2, max_length=12)


class NetworkCriterion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["EXCELLENT", "GOOD", "WARNING", "FAULT"]
    condition: str = Field(min_length=1, max_length=2000)
    meaning: str = Field(min_length=1, max_length=2000)


class NetworkTransition(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    from_state: Literal["EXCELLENT", "GOOD", "WARNING", "FAULT"] = Field(alias="from")
    to: Literal["EXCELLENT", "GOOD", "WARNING", "FAULT"]
    description: str = Field(min_length=1, max_length=2000)


class NetworkRuleText(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope: str = Field(min_length=1, max_length=500)
    source: str = Field(min_length=1, max_length=500)
    criteria: list[NetworkCriterion] = Field(min_length=4, max_length=4)
    transitions: list[NetworkTransition] = Field(max_length=12)


class KnowledgeEntityInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=120)
    name: str = Field(min_length=1, max_length=200)
    category: Literal["设备知识", "网络态势知识", "故障运维知识"]
    type: str = Field(min_length=1, max_length=80)
    description: str = Field(max_length=4000)
    keywords: list[str] = Field(max_length=50)
    source: str = Field(min_length=1, max_length=2000)
    attributes: list[KnowledgeAttribute] = Field(max_length=50)
    modelIds: list[str] = Field(max_length=100)
    principleFlow: PrincipleFlow | None = None
    networkRule: NetworkRuleText | None = None

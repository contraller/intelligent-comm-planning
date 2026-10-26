"""采集来源声明与离线检查契约，不代表真实采集协议。"""
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import Field, field_validator, model_validator

from .observation_schemas import Identifier, ObservationModel, ObservationPage, utc_time

SourceRevision = Annotated[str, Field(pattern=r"^SPV-[0-9a-f]{64}$")]


class SourceDraft(ObservationModel):
    name: str = Field(min_length=1, max_length=60)
    protocolHint: Literal["HTTP_JSON", "WEBSOCKET_JSON"] | None
    endpoint: Annotated[str, Field(min_length=1, max_length=500)] | None
    intervalSeconds: Annotated[int, Field(ge=1, le=3600)] | None
    minKhz: Annotated[float, Field(gt=0)] | None
    maxKhz: Annotated[float, Field(gt=0)] | None
    enabled: bool
    provenanceNote: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def declared_configuration(self):
        if self.name != self.name.strip() or not self.provenanceNote.strip():
            raise ValueError("名称或来源说明无效")
        if (self.minKhz is None) != (self.maxKhz is None):
            raise ValueError("频段上下限须同时提供或同时未知")
        if self.minKhz is not None and self.minKhz >= self.maxKhz:
            raise ValueError("频段上限须大于下限")
        if self.endpoint is not None:
            if any(char.isspace() or ord(char) < 32 for char in self.endpoint) or "\\" in self.endpoint:
                raise ValueError("地址不可包含空白或反斜杠")
            try:
                parsed = urlsplit(self.endpoint)
                port = parsed.port
            except ValueError as exc:
                raise ValueError("声明地址格式无效") from exc
            schemes = {"http", "https"} if self.protocolHint == "HTTP_JSON" else {"ws", "wss"} if self.protocolHint == "WEBSOCKET_JSON" else {"http", "https", "ws", "wss"}
            if parsed.scheme not in schemes or not parsed.hostname or parsed.username is not None or parsed.password is not None or "#" in self.endpoint or port == 0:
                raise ValueError("声明地址须匹配格式且不含账号或片段")
        return self


class SourceVersion(ObservationModel):
    schemaVersion: Literal[1]
    dataOrigin: Literal["SYNTHETIC_INTEGRATION"]
    sourceId: Identifier
    configRevision: SourceRevision
    contentHash: str = Field(pattern=r"^[0-9a-f]{64}$")
    draft: SourceDraft
    createdAt: str
    actorId: str = Field(min_length=1, max_length=120)

    @field_validator("createdAt")
    @classmethod
    def event_time(cls, value):
        return utc_time(value)


class SourceSave(ObservationModel):
    schemaVersion: Literal[1]
    requestId: Identifier
    sourceId: Identifier
    baseConfigRevision: SourceRevision | None
    draft: SourceDraft

    @field_validator("schemaVersion", mode="before")
    @classmethod
    def integer_schema(cls, value):
        if type(value) is not int:
            raise ValueError("schemaVersion须为整数1")
        return value


class SourceCheck(ObservationModel):
    schemaVersion: Literal[1]
    requestId: Identifier
    configRevision: SourceRevision

    _integer_schema = field_validator("schemaVersion", mode="before")(SourceSave.integer_schema.__func__)


class SourcePage(ObservationPage):
    search: str = Field(default="", max_length=120)
    enabled: bool | None = None


class FieldIssue(ObservationModel):
    field: str
    code: Literal["MISSING", "INVALID"]
    message: str


class OfflineCheck(ObservationModel):
    checkId: Identifier
    sourceId: Identifier
    configRevision: SourceRevision
    checkedAt: str
    validation: Literal["VALID", "INCOMPLETE"]
    connection: Literal["NOT_ATTEMPTED"]
    validationMode: Literal["OFFLINE_ONLY"]
    issues: list[FieldIssue]

    @field_validator("checkedAt")
    @classmethod
    def event_time(cls, value):
        return utc_time(value)


class SourceReceipt(ObservationModel):
    requestId: Identifier
    operationType: Literal["SOURCE_SAVE", "SOURCE_CHECK"]
    sourceId: Identifier
    configRevision: SourceRevision
    changed: bool
    actorId: str = Field(min_length=1, max_length=120)
    committedAt: str
    source: SourceVersion | None
    check: OfflineCheck | None

    @model_validator(mode="after")
    def related_objects(self):
        utc_time(self.committedAt)
        if self.operationType == "SOURCE_SAVE":
            if self.source is None or self.check is not None:
                raise ValueError("保存回执内容不完整")
            child = self.source
        else:
            if self.source is not None or self.check is None or self.changed:
                raise ValueError("离线检查回执内容无效")
            child = self.check
        if child.sourceId != self.sourceId or child.configRevision != self.configRevision:
            raise ValueError("回执来源归属不匹配")
        return self

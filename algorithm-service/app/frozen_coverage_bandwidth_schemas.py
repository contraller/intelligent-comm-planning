"""冻结覆盖的显式接收带宽选择；与信道带宽、设备配置分开。"""
import math

from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt, field_validator


class BandwidthChoice(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    device_id: str = Field(min_length=1, max_length=160)
    rx_bandwidth_khz: StrictInt | StrictFloat

    @field_validator("device_id")
    @classmethod
    def identifier(cls, value):
        if not value.strip() or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("设备编号无效")
        return value

    @field_validator("rx_bandwidth_khz")
    @classmethod
    def bandwidth(cls, value):
        try:
            valid = math.isfinite(value) and 1e-9 <= value <= 1e9
        except OverflowError:
            valid = False
        if not valid:
            raise ValueError("接收带宽须为范围内有限正数")
        return value


class BandwidthSelectionInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    task_id: str
    snapshot_id: str
    request_id: str
    choices: list[BandwidthChoice] = Field(max_length=1024)

    @field_validator("task_id", "snapshot_id", "request_id")
    @classmethod
    def identifier(cls, value):
        if not 1 <= len(value) <= 160 or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("选择锚点或请求编号无效")
        return value

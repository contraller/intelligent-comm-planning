"""建立数据库迁移基线，不创建业务表。

Revision ID: 0001_baseline
Revises:
"""
from typing import Sequence, Union


revision: str = "0001_baseline"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """保留空升级，作为后续公共表迁移的起点。"""


def downgrade() -> None:
    """空基线没有需要回退的数据库对象。"""

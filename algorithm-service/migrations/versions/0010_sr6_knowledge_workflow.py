"""SR6 知识工作流与发布版本。

Revision ID: 0010_sr6_knowledge_workflow
Revises: 0009_fault_task_submissions
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0010_sr6_knowledge_workflow"
down_revision: Union[str, Sequence[str], None] = "0009_fault_task_submissions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table("kg_workspaces",
                    sa.Column("id", sa.Integer(), primary_key=True),
                    sa.Column("current_version", sa.Integer(), nullable=False),
                    sa.Column("revision", sa.Integer(), nullable=False))
    op.create_table("kg_versions",
                    sa.Column("version", sa.Integer(), primary_key=True),
                    sa.Column("parent_version", sa.Integer()),
                    sa.Column("restored_from", sa.Integer()),
                    sa.Column("created_at", sa.Float(), nullable=False),
                    sa.Column("note", sa.Text(), nullable=False),
                    sa.Column("snapshot", sa.JSON(), nullable=False),
                    sa.Column("stats", sa.JSON(), nullable=False))
    op.create_table("kg_changes",
                    sa.Column("change_id", sa.String(40), primary_key=True),
                    sa.Column("state", sa.String(20), nullable=False),
                    sa.Column("revision", sa.Integer(), nullable=False),
                    sa.Column("base_version", sa.Integer(), nullable=False),
                    sa.Column("ops", sa.JSON(), nullable=False),
                    sa.Column("submitter", sa.String(100), nullable=False),
                    sa.Column("note", sa.Text(), nullable=False),
                    sa.Column("created_at", sa.Float(), nullable=False),
                    sa.Column("updated_at", sa.Float(), nullable=False))
    op.create_table("kg_submissions",
                    sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
                    sa.Column("change_id", sa.String(40), sa.ForeignKey("kg_changes.change_id"), nullable=False),
                    sa.Column("number", sa.Integer(), nullable=False),
                    sa.Column("revision", sa.Integer(), nullable=False),
                    sa.Column("ops", sa.JSON(), nullable=False),
                    sa.Column("submitted_at", sa.Float(), nullable=False),
                    sa.Column("outcome", sa.String(20), nullable=False),
                    sa.Column("reviewer", sa.String(100)),
                    sa.Column("opinion", sa.Text()),
                    sa.UniqueConstraint("change_id", "number", name="uq_kg_submission_number"))
    op.create_index("ix_kg_submissions_change_id", "kg_submissions", ["change_id"])
    op.create_table("kg_receipts",
                    sa.Column("request_id", sa.String(120), primary_key=True),
                    sa.Column("digest", sa.String(64), nullable=False),
                    sa.Column("response", sa.JSON(), nullable=False))
    op.create_table("kg_audit",
                    sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
                    sa.Column("created_at", sa.Float(), nullable=False),
                    sa.Column("actor", sa.String(100), nullable=False),
                    sa.Column("action", sa.String(30), nullable=False),
                    sa.Column("change_id", sa.String(40)),
                    sa.Column("version", sa.Integer(), nullable=False),
                    sa.Column("detail", sa.Text(), nullable=False))


def downgrade() -> None:
    op.drop_table("kg_audit")
    op.drop_table("kg_receipts")
    op.drop_index("ix_kg_submissions_change_id", table_name="kg_submissions")
    op.drop_table("kg_submissions")
    op.drop_table("kg_changes")
    op.drop_table("kg_versions")
    op.drop_table("kg_workspaces")

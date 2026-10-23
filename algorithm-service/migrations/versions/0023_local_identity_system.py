"""本地账号密码、会话及系统管理；不预置账户、密码或角色。"""
from alembic import op
import sqlalchemy as sa

revision = "0023_local_identity_system"
down_revision = "0022_interference_workbench"
branch_labels = depends_on = None


def upgrade():
    op.create_table("local_roles",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(40), unique=True, nullable=False),
        sa.Column("description", sa.String(200), nullable=False),
        sa.Column("permissions", sa.JSON(), nullable=False))
    op.create_table("local_accounts",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("username", sa.String(32), unique=True, nullable=False),
        sa.Column("name", sa.String(40), nullable=False),
        sa.Column("department", sa.String(60), nullable=False),
        sa.Column("role_id", sa.String(64), sa.ForeignKey("local_roles.id"), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("identity_revision", sa.Integer(), nullable=False),
        sa.Column("last_login", sa.Integer()))
    op.create_index("ix_local_accounts_role_id", "local_accounts", ["role_id"])
    op.create_table("local_credentials",
        sa.Column("account_id", sa.String(64), sa.ForeignKey("local_accounts.id"), primary_key=True),
        sa.Column("password_hash", sa.String(200), nullable=False),
        sa.Column("must_change_password", sa.Boolean(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("changed_at", sa.Integer(), nullable=False))
    op.create_table("system_state",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("initialized", sa.Boolean(), nullable=False),
        sa.Column("epoch", sa.String(64), nullable=False),
        sa.CheckConstraint("id = 1", name="ck_system_state_singleton"),
        sa.CheckConstraint("revision >= 1", name="ck_system_state_revision"))
    op.create_table("system_parameters",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("value", sa.JSON(), nullable=False))
    op.create_table("system_operations",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("actor_id", sa.String(64), nullable=False),
        sa.Column("request_id", sa.String(120), nullable=False),
        sa.Column("action", sa.String(80), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("permission", sa.String(120), nullable=False),
        sa.Column("result", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.UniqueConstraint("actor_id", "request_id", name="uq_system_operation_actor_request"))
    op.create_table("system_audit_events",
        sa.Column("sequence", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("id", sa.String(64), unique=True, nullable=False),
        sa.Column("time", sa.Integer(), nullable=False),
        sa.Column("actor", sa.JSON()),
        sa.Column("module", sa.String(40), nullable=False),
        sa.Column("action", sa.String(80), nullable=False),
        sa.Column("object_id", sa.String(120), nullable=False),
        sa.Column("request_id", sa.String(120)),
        sa.Column("outcome", sa.String(20), nullable=False),
        sa.Column("error_code", sa.String(40), nullable=False),
        sa.Column("summary", sa.String(500), nullable=False),
        sa.Column("changes", sa.JSON(), nullable=False))
    op.create_index("ix_system_audit_events_time", "system_audit_events", ["time"])
    op.create_table("system_audit_archives",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("through_sequence", sa.Integer(), nullable=False),
        sa.Column("actor_id", sa.String(64), nullable=False),
        sa.Column("reason", sa.String(200), nullable=False),
        sa.Column("time", sa.Integer(), nullable=False))
    op.create_table("local_identity_sessions",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("session_id", sa.String(64), unique=True, nullable=False),
        sa.Column("generation", sa.String(64), nullable=False),
        sa.Column("account_id", sa.String(64), sa.ForeignKey("local_accounts.id"), nullable=False),
        sa.Column("identity_revision", sa.Integer(), nullable=False),
        sa.Column("csrf", sa.String(128), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("last_seen", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=False),
        sa.Column("revoked", sa.Boolean(), nullable=False))
    op.create_index("ix_local_identity_sessions_account_id", "local_identity_sessions", ["account_id"])
    op.create_table("local_identity_challenges",
        sa.Column("client_key", sa.String(64), primary_key=True),
        sa.Column("token_hash", sa.String(64), unique=True, nullable=False),
        sa.Column("csrf", sa.String(128), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=False),
        sa.Column("used", sa.Boolean(), nullable=False))
    op.create_table("local_identity_throttle",
        sa.Column("key", sa.String(130), primary_key=True),
        sa.Column("failures", sa.Integer(), nullable=False),
        sa.Column("window_start", sa.Integer(), nullable=False),
        sa.Column("blocked_until", sa.Integer(), nullable=False))
    # 配置/账户可按版本维护，审计及受理事实不允许SQL修改或删除。
    if op.get_bind().dialect.name == "sqlite":
        for table in ("system_operations", "system_audit_events", "system_audit_archives"):
            for action in ("UPDATE", "DELETE"):
                op.execute(sa.text(f"CREATE TRIGGER {table}_immutable_{action.lower()} BEFORE {action} ON {table} "
                    "BEGIN SELECT RAISE(ABORT, 'system history is immutable'); END"))


def downgrade():
    raise RuntimeError("本地账号、会话及系统审计须保留，不允许破坏性降级")

"""Alembic 运行环境，从 DATABASE_URL 读取目标数据库。"""
from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.database import Base, get_database_url
from app import fault_scenario_models, fault_submission_models, kg_models, planning_job_models, planning_plan_models, task_input_models  # noqa: F401  # 注册模型供迁移比较。
from app import integration_identity_models, fault_frontend_models  # noqa: F401
from app import resource_dataset_models  # noqa: F401  # 注册资源快照与指针。
from app import interference_frontend_models, device_configuration_models  # noqa: F401
from app import device_status_models  # noqa: F401  # 状态与资源基线独立，正式迁移仍为单链。
from app import interference_workbench_models, system_management_models, local_identity_models  # noqa: F401
from app.observation_models import OBSERVATION_METADATA
from app.spectrum_source_models import SPECTRUM_SOURCE_METADATA
from app.observation_status_ref_models import OBSERVATION_REF_METADATA


config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# 后续模型导入完成后，自动生成迁移会读取该元数据。
# 观测模块保留独立模型边界，但迁移仍使用同一库和单一版本链。
target_metadata = [Base.metadata, OBSERVATION_METADATA, SPECTRUM_SOURCE_METADATA, OBSERVATION_REF_METADATA]


def _configure_url() -> str:
    url = get_database_url()
    config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    return url


def run_migrations_offline() -> None:
    """生成离线 SQL，不建立数据库连接。"""
    context.configure(
        url=_configure_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """建立连接并执行在线迁移。"""
    _configure_url()
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

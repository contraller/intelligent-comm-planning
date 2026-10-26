"""初始化不自动开户，只有显式参数可在空测试库原子创建。"""
import secrets
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from test_system_management_api import seed_store
from app.database import Base
from app.local_identity_models import IDENTITY_TABLES
from app.system_management_models import SYSTEM_TABLES, LocalAccount, SystemState
from app.system_management_schemas import SystemManagementError
from app.system_management_service import SystemManagementService


def test_empty_database_never_creates_default_account(seed_store, tmp_path):
    engine = create_engine("sqlite:///" + (tmp_path / "explicit.sqlite").as_posix(), connect_args={"timeout": 10})
    Base.metadata.create_all(engine, tables=SYSTEM_TABLES + IDENTITY_TABLES)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    service = SystemManagementService(session_factory=factory, permission_registry=seed_store.registry, request_key=secrets.token_bytes(32))
    with factory() as session:
        assert session.scalar(select(func.count()).select_from(LocalAccount)) == 0
        assert session.get(SystemState, 1) is None
    password = secrets.token_urlsafe(24)
    def initialize():
        try:
            return service.initialize(username="explicit", password=password, name="显式管理员", department="测试")
        except SystemManagementError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: initialize(), range(2)))
    assert sum(isinstance(result, str) for result in results) == 1
    assert results.count(1203) == 1
    with factory() as session:
        assert session.scalar(select(func.count()).select_from(LocalAccount)) == 1
        assert session.get(SystemState, 1).initialized
    engine.dispose()


def test_unsafe_or_absent_configuration_rejected(seed_store):
    from app.local_identity_schemas import LocalIdentitySettings
    with pytest.raises(SystemManagementError):
        SystemManagementService(session_factory=None, permission_registry=seed_store.registry, request_key=b"weak")
    for origins in (frozenset(), frozenset(("http://host/path",)), frozenset(("https://user:password@host",))):
        with pytest.raises(ValueError):
            LocalIdentitySettings(allowed_origins=origins)
    with pytest.raises(ValueError):
        LocalIdentitySettings(allowed_origins=frozenset(("https://local.example",)), allow_insecure_loopback="false")


@pytest.mark.parametrize("target", ["sqlite:///F:/work/project2026-1/data/runtime/int-a.sqlite", "sqlite:///F:/work/project2026-1/data/runtime/collab.sqlite", None])
def test_cli_rejects_old_databases_and_noninteractive_initialization(monkeypatch, target):
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("p05_explicit_init", root / "scripts/init_local_identity.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module.sys, "argv", ["init_local_identity.py", "--database-url", target or "sqlite:///" + (root / "data/runtime/r2.sqlite").as_posix(), "--registry-json", "not-read.json", "--request-key-env", "P05_NOT_READ", "--username", "explicit", "--name", "显式", "--department", "测试"])
    monkeypatch.setattr(module.sys, "stdin", SimpleNamespace(isatty=lambda: False))
    def forbidden(*args, **kwargs):
        raise AssertionError("Unsafe CLI input must be rejected before database connection or password input")
    monkeypatch.setattr(module, "create_engine", forbidden)
    monkeypatch.setattr(module.getpass, "getpass", forbidden)
    with pytest.raises(SystemExit) as error:
        module.main()
    assert error.value.code == 2

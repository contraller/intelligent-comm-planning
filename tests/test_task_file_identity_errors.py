"""使用真实身份异常验证任务路由，不启动主应用或访问运行数据库。"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
DEPENDENCIES = Path(os.environ.get("TASK_FILE_TEST_DEPENDENCY_ROOT", ROOT)).resolve()
sys.path.insert(0, str(DEPENDENCIES / "algorithm-service"))
from app.integration_identity_service import IdentityError
from app.system_management_schemas import SystemManagementError

# 隔离工作树可显式借用主已审依赖；始终测试本文件同树的新router，不复制源码。
spec = importlib.util.spec_from_file_location("app._task_file_identity_test_router", ROOT / "algorithm-service/app/task_file_router.py")
assert spec is not None and spec.loader is not None
router_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(router_module)


@pytest.mark.parametrize("path", ["preview", "template"])
@pytest.mark.parametrize("code,status", [(1101, 401), (1102, 401), (1103, 403), (1104, 403), (1105, 403), (1106, 409), (1107, 409), (1119, 429)])
@pytest.mark.parametrize("error_type", [IdentityError, SystemManagementError])
def test_identity_errors_preserve_original_envelope(path, code, status, error_type):
    data = {"reason": "identity-changed"} if error_type is SystemManagementError else None
    def authorize(_request, _permission, writing=False):
        assert writing is True
        if error_type is SystemManagementError:
            raise error_type("身份状态拒绝", code, status, data=data)
        raise error_type("身份状态拒绝", code, status)
    app = FastAPI()
    app.include_router(router_module.create_task_file_router(authorize))
    with TestClient(app) as client:
        response = client.post("/api/v1/task-files/" + path, json={})
    assert response.status_code == status
    assert response.json() == {"code": code, "message": "身份状态拒绝", "data": data}


def test_unknown_error_is_not_silently_converted_to_identity_failure():
    def authorize(*_args, **_kwargs):
        raise RuntimeError("unexpected-programming-error")
    app = FastAPI()
    app.include_router(router_module.create_task_file_router(authorize))
    with TestClient(app) as client, pytest.raises(RuntimeError, match="unexpected-programming-error"):
        client.post("/api/v1/task-files/preview", json={})

"""LOCAL的公共请求前置边界；不取代专用router的细权限和业务校验。"""
from __future__ import annotations

from starlette.requests import Request

from .permission_registry import SERVER_PERMISSION_REGISTRY
from .system_management_schemas import SystemManagementError

_API = "/api/v1"
_PLANNING = ("planning", "plan", "task-inputs", "task", "tasks", "jobs", "planning-operations")
_RESOURCE_PLANNING = frozenset(("context", "map", "nodes", "devices", "interference-sources",
    "device-models", "antenna-models", "frequency-pool", "param-presets"))
_RESOURCE_GIS = frozenset(("gis-directory", "gis-scene"))
_CONTEXT_PERMISSION = {"ledger": "resources.view", "gis": "situation.view", "planning": "planning.view"}
_REGISTRY = {entry["code"]: tuple(entry["requires"]) for entry in SERVER_PERMISSION_REGISTRY}


def _under(path: str, root: str) -> bool:
    return path == root or path.startswith(root + "/")


def _deny(message: str) -> None:
    raise SystemManagementError(message, 1104, 403)


def _require_permission(permissions: frozenset[str], code: str) -> None:
    pending, required = [code], set()
    while pending:
        current = pending.pop()
        if current in required:
            continue
        if current not in _REGISTRY:
            raise SystemManagementError("本地权限目录配置不可用", 5001, 503)
        required.add(current)
        pending.extend(_REGISTRY[current])
    if not required <= permissions:
        _deny("当前本地身份无此操作权限")


def _resource_permission(request: Request, path: str) -> str:
    contexts = request.query_params.getlist("context")
    if len(contexts) > 1 or contexts and contexts[0] not in _CONTEXT_PERMISSION:
        raise SystemManagementError("资源context必须是单一ledger、gis或planning", 1001, 422)
    if contexts:
        return _CONTEXT_PERMISSION[contexts[0]]
    suffix = path.removeprefix(_API + "/resource").lstrip("/").split("/", 1)[0]
    context = "gis" if suffix in _RESOURCE_GIS else "planning" if suffix in _RESOURCE_PLANNING else "ledger"
    return _CONTEXT_PERMISSION[context]


def authorize_local_request(request: Request) -> None:
    adapter = getattr(getattr(request.app, "state", None), "local_identity_adapter", None)
    if adapter is None:
        return
    path = request.scope["path"].rstrip("/")
    if not _under(path, _API) or _under(path, _API + "/auth"):
        return

    # 身份和CSRF只从正式adapter验证一次；后续权限只读该可信返回值。
    principal = adapter.require(request, writing=request.method != "GET")
    codes = principal.get("permissions") if isinstance(principal, dict) else None
    if not isinstance(codes, list) or any(not isinstance(code, str) for code in codes):
        raise SystemManagementError("本地身份适配返回不可用", 5001, 503)
    permissions = frozenset(codes)

    blocked = ("integration/sr4", "legacy", "interference/analyze", "interference/adopt")
    if any(_under(path, _API + "/" + root) for root in blocked):
        _deny("本地正式模式不开放遗留联调或直接干扰入口")

    if _under(path, _API + "/resource"):
        _require_permission(permissions, _resource_permission(request, path))
    elif _under(path, _API + "/plans"):
        parts = path.removeprefix(_API + "/plans").strip("/").split("/")
        if request.method == "GET" or request.method == "POST" and parts == ["compare"]:
            permission = "planning.view"
        elif request.method == "POST" and len(parts) == 2 and parts[1] == "confirm":
            permission = "planning.confirm"
        else:
            permission = "planning.save"
        _require_permission(permissions, permission)
    elif any(_under(path, _API + "/" + root) for root in _PLANNING):
        _require_permission(permissions, "planning.view" if request.method == "GET" else "planning.execute")
    elif _under(path, _API + "/files"):
        _require_permission(permissions, "diagnosis.export")
    else:
        for root, module in (("fault", "diagnosis"), ("kg", "knowledge")):
            prefix = _API + "/" + root
            if not _under(path, prefix):
                continue
            if not _under(path, prefix + "/workbench"):
                if request.method != "GET":
                    _deny("本地正式模式不开放旧版诊断或知识写入口")
                _require_permission(permissions, module + ".view")
            if root == "fault" and request.method == "GET" and (
                    path.endswith("/export") or _under(path, prefix + "/workbench/export")):
                _require_permission(permissions, "diagnosis.export")

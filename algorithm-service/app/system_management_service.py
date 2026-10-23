"""本地账号、角色、参数与回执事务；数据库和鉴权均显式注入。"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import hmac
import json
import copy
import time
import uuid

from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from .local_password_service import hash_password, verify_password
from .system_audit_service import actor_snapshot, append_system_audit, audit_revision, event_dto, log_rows
from .system_management_models import (
    LocalAccount, LocalCredential, LocalRole, SystemAuditArchive, SystemAuditEvent,
    SystemOperation, SystemParameter, SystemState,
)
from .system_management_schemas import (
    ADMIN_PERMISSIONS, AccountCreate, AccountPassword, AccountState, AccountUpdate,
    AuditArchive, NewAccountProfile, ParameterReset, ParameterSave, RoleSave,
    SystemActor, SystemManagementError, parse_request, safe_text,
)

PARAMETERS = {
    "PAR-01": dict(name="状态展示间隔", value=30, unit="s", description="持久化的展示周期；消费者未接线时不表示实际采集生效。", readonly=False, min=1, max=3600, applicationState="STORED_ONLY", appliesTo="状态展示/回放"),
    "PAR-02": dict(name="接口请求超时", value=15, unit="s", description="持久化的超时配置；共享客户端接线后只作用于新请求。", readonly=False, min=1, max=120, applicationState="STORED_ONLY", appliesTo="后续HTTP请求"),
    "PAR-03": dict(name="默认坐标系", value="EPSG:4326", unit="", description="固定WGS84，经度在前、纬度在后。", readonly=True, min=None, max=None, applicationState="APPLIED", appliesTo="坐标约定"),
}
_ACTIONS = {
    "account.create": (AccountCreate, "system.accounts"), "account.update": (AccountUpdate, "system.accounts"),
    "account.state": (AccountState, "system.accounts"), "account.password": (AccountPassword, "system.accounts"),
    "role.create": (RoleSave, "system.roles"), "role.update": (RoleSave, "system.roles"),
    "parameter.save": (ParameterSave, "system.parameters"), "parameter.reset": (ParameterReset, "system.parameters"),
    "logs.archive": (AuditArchive, "system.logs"),
}


class SystemManagementService:
    def __init__(self, *, session_factory, permission_registry: list[dict], request_key: bytes, clock=time.time):
        if type(request_key) is not bytes or len(request_key) < 32:
            raise SystemManagementError("系统请求签名密钥未安全配置", 5001, 503)
        self.factory, self.clock, self._request_key = session_factory, clock, request_key
        self.registry = {}
        for item in permission_registry:
            code = safe_text(item.get("code"))
            if code in self.registry or not isinstance(item.get("requires"), list):
                raise SystemManagementError("服务端权限目录无效", 5001, 503)
            self.registry[code] = {"code": code, "name": safe_text(item.get("name"), maximum=80),
                "group": safe_text(item.get("group"), maximum=40), "requires": list(item["requires"])}
        if not ADMIN_PERMISSIONS <= self.registry.keys() or any(p not in self.registry for item in self.registry.values() for p in item["requires"]):
            raise SystemManagementError("服务端权限目录不完整", 5001, 503)

    def fingerprint(self, action: str, actor_id: str, body: dict) -> str:
        raw = json.dumps([action, actor_id, body], ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        return hmac.new(self._request_key, raw, hashlib.sha256).hexdigest()

    @staticmethod
    def _lock(session):
        if session.bind.dialect.name == "sqlite":
            session.execute(text("BEGIN IMMEDIATE"))

    @staticmethod
    def _state(session):
        state = session.get(SystemState, 1, with_for_update=True)
        if state is None or not state.initialized:
            raise SystemManagementError("本地系统尚未显式初始化", 5002, 503, reason="INITIALIZATION_REQUIRED")
        return state

    @staticmethod
    def revision(state):
        return "SYS-" + str(state.revision)

    def check_actor(self, session, actor: SystemActor, permission: str | None = None):
        if type(actor) is not SystemActor or actor.auth_source != "LOCAL_PASSWORD":
            raise SystemManagementError("需要正式本地身份", 1101, 401)
        account = session.get(LocalAccount, actor.account_id)
        if account is None or not account.enabled:
            raise SystemManagementError("本地身份已停用或不可用", 1103, 403)
        role = session.get(LocalRole, account.role_id)
        if role is None or actor.identity_revision != str(account.identity_revision):
            raise SystemManagementError("身份权限版本已变化", 1106, 409)
        current = frozenset(role.permissions)
        if current != actor.permissions or (permission and permission not in current):
            raise SystemManagementError("当前身份无此权限", 1104, 403)
        return account

    def initialize(self, *, username: str, password: str, name: str, department: str) -> str:
        profile = parse_request(NewAccountProfile, dict(username=username, name=name, department=department, roleId="initialization"))
        encoded, now = hash_password(password), int(self.clock())
        try:
            with self.factory() as session, session.begin():
                self._lock(session)
                if session.get(SystemState, 1) is not None or session.scalar(select(func.count()).select_from(LocalAccount)):
                    raise SystemManagementError("系统已经初始化，不能重复开户", 1203, 409)
                role = LocalRole(id="ROLE-" + uuid.uuid4().hex, name="系统管理角色", description="操作员显式初始化", permissions=sorted(ADMIN_PERMISSIONS))
                session.add(role)
                session.flush()
                account = LocalAccount(id="ACC-" + uuid.uuid4().hex, username=profile.username, name=safe_text(profile.name, maximum=40),
                    department=safe_text(profile.department, maximum=60), role_id=role.id, enabled=True, identity_revision=1, last_login=None)
                session.add(account)
                session.flush()
                session.add(LocalCredential(account_id=account.id, password_hash=encoded, must_change_password=False, revision=1, changed_at=now))
                session.add(SystemState(id=1, revision=1, initialized=True, epoch=uuid.uuid4().hex))
                for key, definition in PARAMETERS.items():
                    session.add(SystemParameter(id=key, value=definition["value"]))
                actor = SystemActor(account.id, "explicit-initialization", "1", ADMIN_PERMISSIONS)
                append_system_audit(session, actor, now=now, action="system.initialize", object_id=account.id)
                return account.id
        except IntegrityError:
            raise SystemManagementError("初始化发生并发冲突", 1203, 409) from None

    def _permissions(self, codes):
        if len(set(codes)) != len(codes) or any(code not in self.registry for code in codes):
            raise SystemManagementError("权限重复或未登记")
        if any(required not in codes for code in codes for required in self.registry[code]["requires"]):
            raise SystemManagementError("权限缺少必要依赖")
        if "knowledge.edit" in codes and any(code in codes for code in ("knowledge.review", "knowledge.publish", "knowledge.rollback")):
            raise SystemManagementError("知识编辑与审核权限必须分离")
        return sorted(codes)

    @staticmethod
    def _last_admin(session):
        session.flush()
        accounts = session.scalars(select(LocalAccount).where(LocalAccount.enabled.is_(True)))
        for account in accounts:
            role = session.get(LocalRole, account.role_id)
            if role and ADMIN_PERMISSIONS <= set(role.permissions) and session.get(LocalCredential, account.id):
                return
        raise SystemManagementError("必须保留至少一个可用系统管理账号", 1203, 409, reason="LAST_ADMIN")

    @staticmethod
    def account_dto(session, account):
        role, credential = session.get(LocalRole, account.role_id), session.get(LocalCredential, account.id)
        return dict(id=account.id, username=account.username, name=account.name, department=account.department,
            roleId=account.role_id, roleName=role.name, enabled=account.enabled,
            lastLogin=datetime.fromtimestamp(account.last_login, timezone.utc).isoformat() if account.last_login is not None else None,
            mustChangePassword=credential.must_change_password if credential else True)

    @staticmethod
    def role_dto(session, role):
        count = session.scalar(select(func.count()).select_from(LocalAccount).where(LocalAccount.role_id == role.id))
        return dict(id=role.id, name=role.name, description=role.description, permissions=list(role.permissions), permissionCount=len(role.permissions), accountCount=count)

    @staticmethod
    def parameter_dto(parameter):
        return {"id": parameter.id, **PARAMETERS[parameter.id], "value": parameter.value}

    def read(self, kind: str, actor: SystemActor, *, object_id: str | None = None, query: dict | None = None):
        permission = {"options": "system.view", "accounts": "system.accounts", "roles": "system.roles", "parameters": "system.parameters", "logs": "system.logs", "operations": None}[kind]
        query = dict(query or {})
        allowed = {"pageNum", "pageSize", "search"} | ({"roleId", "enabled"} if kind == "accounts" else {"actorId", "module", "action", "outcome", "date", "includeArchived"} if kind == "logs" else set())
        if set(query) - allowed:
            raise SystemManagementError("查询含未知字段")
        with self.factory() as session:
            self.check_actor(session, actor, permission)
            state = self._state(session)
            revision = self.revision(state)
            if kind == "options":
                return dict(revision=revision, roles=[{"id": r.id, "name": r.name} for r in session.scalars(select(LocalRole).order_by(LocalRole.name, LocalRole.id))],
                    permissions=copy.deepcopy(list(self.registry.values())), capabilities={"authSource": "LOCAL_PASSWORD", "passwordMaintenance": True, "nonDestructiveReset": True})
            if kind == "operations":
                row = session.scalar(select(SystemOperation).where(SystemOperation.actor_id == actor.account_id, SystemOperation.request_id == object_id))
                if row is None:
                    return {"status": "NOT_FOUND"}
                self.check_actor(session, actor, row.permission)
                return {"status": "FOUND", **row.result}
            model = {"accounts": LocalAccount, "roles": LocalRole, "parameters": SystemParameter, "logs": SystemAuditEvent}[kind]
            if object_id:
                row = session.scalar(select(model).where(model.id == object_id))
                if row is None:
                    raise SystemManagementError("对象不存在", 1002, 404)
                if kind == "logs":
                    return event_dto(row)
                value = self.account_dto(session, row) if kind == "accounts" else self.role_dto(session, row) if kind == "roles" else self.parameter_dto(row)
                return {"revision": revision, {"accounts": "account", "roles": "role", "parameters": "parameter"}[kind]: value}
            if kind == "logs":
                items = log_rows(session, query)
                revision = audit_revision(session)
            else:
                rows = list(session.scalars(select(model).order_by(model.id)))
                if kind == "accounts":
                    if "enabled" in query and type(query["enabled"]) is not bool:
                        raise SystemManagementError("账号状态筛选无效")
                    rows = [r for r in rows if ("enabled" not in query or r.enabled == query["enabled"]) and (not query.get("roleId") or r.role_id == query["roleId"])]
                items = [self.account_dto(session, r) if kind == "accounts" else self.role_dto(session, r) if kind == "roles" else self.parameter_dto(r) for r in rows]
            search = safe_text(query.get("search", ""), maximum=200, empty=True).casefold()
            if search:
                items = [r for r in items if search in " ".join(str(r.get(k, "")) for k in ("id", "username", "name", "description", "summary", "action")).casefold()]
            page, size = query.get("pageNum", 1), query.get("pageSize", 20)
            if type(page) is not int or page < 1 or type(size) is not int or size not in (5, 10, 20, 50):
                raise SystemManagementError("分页无效")
            result = dict(items=items[(page - 1) * size:page * size], total=len(items), pageNum=page, pageSize=size, revision=revision, epoch=state.epoch)
            if kind == "logs":
                result.update(auditRevision=revision, snapshotSequence=int(revision.split("-")[1]))
            return result

    def execute(self, action: str, actor: SystemActor, body: object, *, object_id: str = ""):
        if action not in _ACTIONS:
            raise SystemManagementError("未知管理动作")
        schema, permission = _ACTIONS[action]
        value = parse_request(schema, body)
        raw = value.model_dump(mode="python")
        # SecretStr 仅在本次内存校验/指纹中解封，不写入回执、审计或异常。
        raw = {k: (v.get_secret_value() if hasattr(v, "get_secret_value") else v) for k, v in raw.items()}
        fingerprint = self.fingerprint(action, actor.account_id, {**raw, "objectId": object_id})
        with self.factory() as check:
            self.check_actor(check, actor, permission)
        if action == "account.password":
            self._verify_operator_password(actor, raw["operatorPassword"])
        encoded = hash_password(raw["initialPassword"] if action == "account.create" else raw["newPassword"]) if action in ("account.create", "account.password") else None
        try:
            with self.factory() as session, session.begin():
                self._lock(session)
                self.check_actor(session, actor, permission)
                if action in ("parameter.reset", "logs.archive"):
                    self.check_actor(session, actor, "system.reset")
                previous = session.scalar(select(SystemOperation).where(SystemOperation.actor_id == actor.account_id, SystemOperation.request_id == value.requestId))
                if previous:
                    if not hmac.compare_digest(previous.fingerprint, fingerprint):
                        raise SystemManagementError("请求编号复用内容不同", 1206, 409)
                    return {**previous.result, "replayed": True}
                state = self._state(session)
                expected = value.baseAuditRevision if action == "logs.archive" else value.baseRevision
                current = audit_revision(session) if action == "logs.archive" else self.revision(state)
                if expected != current:
                    raise SystemManagementError("系统版本已变化", 1203, 409, reason="REVISION_CONFLICT")
                before_actor = actor_snapshot(session, actor)
                target, changed, changes = self._mutate(session, action, actor, value, object_id, encoded)
                self._last_admin(session)
                if changed and action != "logs.archive":
                    state.revision += 1
                event = append_system_audit(session, actor, now=int(self.clock()), action=action, object_id=target,
                    request_id=value.requestId, outcome="SUCCESS" if changed else "UNCHANGED", changes=changes, snapshot=before_actor)
                result = dict(revision=self.revision(state), objectId=target, changed=changed, operationId="OP-" + uuid.uuid4().hex)
                if action == "logs.archive":
                    result.update(auditRevision="AUD-" + str(event.sequence), archivedThroughSequence=value.throughSequence)
                if action in ("parameter.save", "parameter.reset"):
                    result.update(applicationState="STORED_ONLY", appliesTo="参数消费者接线后新请求/展示周期")
                if action in ("account.password", "account.state", "account.update", "role.update"):
                    result["reauthenticationRequired"] = self._actor_changed(session, actor)
                session.add(SystemOperation(id=result["operationId"], actor_id=actor.account_id, request_id=value.requestId,
                    action=action, fingerprint=fingerprint, permission=permission, result=result, created_at=int(self.clock())))
                return result
        except IntegrityError:
            raise SystemManagementError("唯一性或并发状态冲突", 1203, 409, reason="UNIQUENESS_CONFLICT") from None
        except SQLAlchemyError:
            raise SystemManagementError("系统事务未能完成", 5002, 503) from None

    def _verify_operator_password(self, actor, password):
        from .local_identity_models import LocalIdentityThrottle
        now, failed = int(self.clock()), False
        # 维护他人密码同样是重新认证；失败计数提交后再抛错，防止异常回滚限流。
        with self.factory() as session, session.begin():
            self._lock(session)
            self.check_actor(session, actor, "system.accounts")
            key = "account:" + actor.account_id
            row = session.get(LocalIdentityThrottle, key)
            if row is None:
                row = LocalIdentityThrottle(key=key, failures=0, window_start=now, blocked_until=0)
                session.add(row)
            if row.blocked_until <= now and row.window_start + 300 <= now:
                row.failures, row.window_start, row.blocked_until = 0, now, 0
            if row.blocked_until > now:
                raise SystemManagementError("重新认证请求过于频繁", 1101, 429, reason="THROTTLED")
            credential = session.get(LocalCredential, actor.account_id)
            if credential is None or not verify_password(password, credential.password_hash):
                failed = True
                row.failures += 1
                if row.failures >= 5:
                    row.blocked_until = now + 300
            else:
                row.failures, row.blocked_until = 0, 0
        if failed:
            raise SystemManagementError("重新认证失败", 1101, 401)

    @staticmethod
    def _actor_changed(session, actor):
        account = session.get(LocalAccount, actor.account_id)
        return not account.enabled or str(account.identity_revision) != actor.identity_revision

    def _mutate(self, session, action, actor, value, object_id, encoded):
        now = int(self.clock())
        if action.startswith("account."):
            account = session.get(LocalAccount, object_id) if object_id else None
            if action == "account.create":
                profile = value.account
                if session.get(LocalRole, profile.roleId) is None:
                    raise SystemManagementError("角色不存在", 1002, 404)
                account = LocalAccount(id="ACC-" + uuid.uuid4().hex, username=profile.username, name=safe_text(profile.name, maximum=40),
                    department=safe_text(profile.department, maximum=60), role_id=profile.roleId, enabled=True, identity_revision=1, last_login=None)
                session.add(account)
                session.flush()
                session.add(LocalCredential(account_id=account.id, password_hash=encoded, must_change_password=True, revision=1, changed_at=now))
                return account.id, True, {"roleId": account.role_id, "enabled": True}
            if account is None:
                raise SystemManagementError("账号不存在", 1002, 404)
            if action == "account.password":
                credential = session.get(LocalCredential, account.id)
                credential.password_hash, credential.changed_at, credential.must_change_password = encoded, now, True
                credential.revision += 1
                account.identity_revision += 1
                return account.id, True, {}
            before = {"name": account.name, "department": account.department, "roleId": account.role_id, "enabled": account.enabled}
            if action == "account.state":
                account.enabled = value.enabled
            else:
                if session.get(LocalRole, value.account.roleId) is None:
                    raise SystemManagementError("角色不存在", 1002, 404)
                account.name, account.department, account.role_id = safe_text(value.account.name, maximum=40), safe_text(value.account.department, maximum=60), value.account.roleId
            after = {"name": account.name, "department": account.department, "roleId": account.role_id, "enabled": account.enabled}
            changed = before != after
            if changed:
                account.identity_revision += 1
            return account.id, changed, {"before": before, "after": after}
        if action.startswith("role."):
            profile = value.role
            permissions = self._permissions(profile.permissions)
            role = session.get(LocalRole, object_id) if object_id else None
            if action == "role.create":
                role = LocalRole(id="ROLE-" + uuid.uuid4().hex, name=safe_text(profile.name, maximum=40), description=safe_text(profile.description, maximum=200, empty=True), permissions=permissions)
                session.add(role)
                return role.id, True, {"name": role.name, "permissions": permissions}
            if role is None:
                raise SystemManagementError("角色不存在", 1002, 404)
            before = dict(name=role.name, description=role.description, permissions=role.permissions)
            role.name, role.description, role.permissions = safe_text(profile.name, maximum=40), safe_text(profile.description, maximum=200, empty=True), permissions
            after = dict(name=role.name, description=role.description, permissions=role.permissions)
            changed = before != after
            if changed:
                for account in session.scalars(select(LocalAccount).where(LocalAccount.role_id == role.id)):
                    account.identity_revision += 1
            return role.id, changed, {"before": before, "after": after}
        if action == "logs.archive":
            maximum = session.scalar(select(func.max(SystemAuditEvent.sequence))) or 0
            if value.throughSequence > maximum:
                raise SystemManagementError("归档边界超出当前日志")
            previous = session.scalar(select(func.max(SystemAuditArchive.through_sequence))) or 0
            changed = value.throughSequence > previous
            if changed:
                session.add(SystemAuditArchive(id="ARC-" + uuid.uuid4().hex, through_sequence=value.throughSequence,
                    actor_id=actor.account_id, reason=safe_text(value.reason, maximum=200), time=now))
            return "audit-view", changed, {"throughSequence": value.throughSequence}
        ids = value.parameterIds if action == "parameter.reset" else [object_id]
        if len(set(ids)) != len(ids):
            raise SystemManagementError("参数重复")
        changes = {}
        for key in ids:
            parameter = session.get(SystemParameter, key)
            definition = PARAMETERS.get(key)
            if parameter is None or definition is None:
                raise SystemManagementError("参数不存在", 1002, 404)
            if definition["readonly"]:
                raise SystemManagementError("固定参数不可修改")
            new_value = definition["value"] if action == "parameter.reset" else value.value
            if type(new_value) is not int or not definition["min"] <= new_value <= definition["max"]:
                raise SystemManagementError("参数须为范围内整数")
            if parameter.value != new_value:
                changes[key] = {"before": parameter.value, "after": new_value}
                parameter.value = new_value
        return object_id or "parameters", bool(changes), changes

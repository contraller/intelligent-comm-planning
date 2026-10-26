"""共享入口接线桩；事务身份与真实HTTP证据另行验证。"""
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'algorithm-service'))
from app import main
from app.system_management_schemas import SystemManagementError


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv('AUTH_MODE', 'OFF')
    monkeypatch.setenv('FRONTEND_INTEGRATION_DEMO', '0')
    monkeypatch.setenv('INTERFERENCE_WORKBENCH_ENABLED', '0')
    monkeypatch.setattr(main.app.state, 'local_identity_adapter', None, raising=False)
    monkeypatch.setattr(main.app.state, 'auth_mode', 'OFF', raising=False)
    with TestClient(main.app) as client:
        yield client


@pytest.mark.parametrize('method,path,schema,target,job,status', [
    ('PUT', '/api/v1/task-inputs/TASK', 'TaskSaveRequest', 'save_task_input', False, 200),
    ('POST', '/api/v1/plan/sr4-flow', 'PlanningJobSubmitRequest', 'planning_job_service.submit_planning_job', True, 202),
    ('DELETE', '/api/v1/tasks/JOB', 'PlanningJobCancelRequest', 'planning_job_service.cancel_planning_job', True, 200),
    ('POST', '/api/v1/plans', 'PlanningPlanSaveRequest', 'planning_plan_service.save_planning_plan', False, 200),
    ('POST', '/api/v1/plans/PLAN/confirm', 'PlanningPlanConfirmRequest', 'planning_plan_service.confirm_planning_plan', False, 200),
    ('GET', '/api/v1/planning-operations/REQ?context=planning&task_id=TASK&kind=saveTask', 'OperationQuery', 'planning_operation_service.query_operation', False, 200),
])
def test_handlers_forward_internal_context_not_client_actor(api, monkeypatch, method, path, schema, target, job, status):
    marker, seen = object(), []
    monkeypatch.setattr(main, schema, SimpleNamespace(model_validate=lambda body: SimpleNamespace(request_id='REQ')))

    def context(request, *, job=False):
        seen.append((request.method, request.url.path, job))
        return {'audit_context': marker, **({'local_owner': True, 'actor_id': 'verified'} if job else {})}

    def service(*args, **kwargs):
        assert kwargs['audit_context'] is marker
        assert kwargs.get('actor_id') == ('verified' if job else None)
        assert kwargs.get('local_owner') == (True if job else None)
        return {'source': 'service'}

    monkeypatch.setattr(main, '_planning_business_kwargs', context)
    module, _, name = target.rpartition('.')
    monkeypatch.setattr(getattr(main, module) if module else main, name, service)
    response = api.request(method, path, **({} if method == 'GET' else {'json': {'actorId': 'untrusted'}}))
    assert response.status_code == status, response.text
    assert seen == [(method, path.split('?')[0], job)]


def test_transaction_identity_error_retains_envelope(api, monkeypatch):
    monkeypatch.setattr(main, 'PlanningPlanSaveRequest', SimpleNamespace(model_validate=lambda body: body))
    monkeypatch.setattr(main, '_planning_business_kwargs', lambda request: {})

    def revoked(*args, **kwargs):
        raise SystemManagementError('会话已撤销', 1102, 401)

    monkeypatch.setattr(main.planning_plan_service, 'save_planning_plan', revoked)
    response = api.post('/api/v1/plans', json={})
    assert (response.status_code, response.json()['code']) == (401, 1102)
    assert response.json()['data'] is None


def test_local_context_cannot_silently_fall_back_without_installed_adapter(monkeypatch):
    monkeypatch.setenv('AUTH_MODE', 'LOCAL_PASSWORD')
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(auth_mode='LOCAL_PASSWORD', local_identity_adapter=None)))
    with pytest.raises(SystemManagementError) as error:
        main._planning_business_kwargs(request)
    assert (error.value.status, error.value.code) == (503, 5001)


def test_non_local_entry_keeps_legacy_signature(monkeypatch):
    monkeypatch.setenv('AUTH_MODE', 'OFF')
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(auth_mode='OFF', local_identity_adapter=None)))
    assert main._planning_business_kwargs(request, job=True) == {}

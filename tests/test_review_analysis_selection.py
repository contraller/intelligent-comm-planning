"""Explicit reference-plan analysis must never change formal current selection."""
import pytest
from copy import deepcopy
from sqlalchemy import select
from test_interference_frontend_api import api, seed, body, save, data, read, headers
from test_interference_workbench_api import EngineStub
from app.interference_workbench_service import InterferenceWorkbenchService
from app.interference_workbench_schemas import TaskQuery, RunSubmit
from app.planning_plan_models import PlanningPlan, PlanningCurrentPlan


@pytest.mark.parametrize('state', ['SAVED', 'REFERENCE'])
def test_saved_reference_analysis_uses_selected_version_without_confirming(api, state):
    client, factory, baseline, _, original = api
    seed(factory, baseline, plan_id='P2', plan_no=2, current=False)
    with factory.begin() as session:
        plan = session.get(PlanningPlan, 'P2')
        plan.state = state
        plan.confirmed_at = None
        plan.revision_id = 'REV-P1'
        before = deepcopy(session.get(PlanningPlan, 'P1').raw_snapshot)
    service = InterferenceWorkbenchService(factory, engine=EngineStub())
    options = service.sources(TaskQuery(task_id='T1'))
    selected = next(row for row in options['items'] if row['plan_id'] == 'P2')
    assert selected['eligible'] and not selected['current']
    payload = body(api, request_id='reference-scene', plan_id='P2', plan_version='V2', interference_ids=[])
    data(save(api, payload))
    scene = data(read(api))['version']
    receipt = service.submit_run(RunSubmit(request_id='reference-run', task_id='T1',
        plan_id='P2', plan_version='V2', resource_revision=scene['resource_revision'],
        scene_id='SC1', scene_version_id=scene['version_id'], snapshot_hash=scene['snapshot_hash']),
        {'account_id': 'integration-planner'})
    assert service.run_once()
    result = service.detail(receipt['object_id'], TaskQuery(task_id='T1'))
    assert result['state'] == 'SUCCESS' and result['plan_id'] == 'P2'
    assert result['source']['plan_version'] == 'V2'
    with factory() as session:
        assert session.get(PlanningCurrentPlan, 'T1').plan_id == 'P1'
        assert session.get(PlanningPlan, 'P2').state == state
        assert session.get(PlanningPlan, 'P1').raw_snapshot == before


def test_reference_analysis_still_rejects_wrong_version_and_incomplete_topology(api):
    _, factory, _, _, _ = api
    with factory.begin() as session:
        plan = session.get(PlanningPlan, 'P1')
        plan.state = 'REFERENCE'
    assert save(api, body(api, plan_version='V2')).status_code == 409
    with factory.begin() as session:
        session.get(PlanningPlan, 'P1').raw_snapshot = None
    assert save(api, body(api)).status_code == 409

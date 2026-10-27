"""Reading a saved analysis scene must report the frozen plan's actual freshness."""
from copy import deepcopy

import pytest

from test_interference_frontend_api import api, body, data, read, save, seed
from app.planning_plan_models import PlanningCurrentPlan, PlanningPlan
from app.task_input_models import PlanningTask


@pytest.mark.parametrize('mutation,reason', [
    ('task-input', '任务输入'),
    ('plan-version', '方案版本'),
    ('plan-condition', '方案版本'),
    ('plan-raw', '冻结内容'),
    ('plan-input', '冻结内容'),
])
def test_scene_detail_marks_changed_input_or_plan_historical_without_rewriting_frozen_scene(api, mutation, reason):
    _, factory, baseline, _, _ = api
    receipt = data(save(api))
    before = data(read(api))['version']
    assert data(read(api))['source_state']['state'] == 'CURRENT'
    if mutation == 'task-input':
        seed(factory, baseline, plan_id='P2', plan_no=2, current=False)
    with factory.begin() as session:
        plan = session.get(PlanningPlan, 'P1')
        if mutation == 'task-input':
            session.get(PlanningTask, 'T1').current_revision_id = 'REV-P2'
        elif mutation == 'plan-version':
            plan.version_no = 2
        elif mutation == 'plan-condition':
            plan.condition_version = 'COND-2'
        elif mutation == 'plan-raw':
            changed = deepcopy(plan.raw_snapshot)
            changed['summary']['review-change'] = 'mutated'
            plan.raw_snapshot = changed
        else:
            changed = deepcopy(plan.input_snapshot)
            changed['review-change'] = 'mutated'
            plan.input_snapshot = changed
    detail = data(read(api, version_id=receipt['version_id']))
    assert detail['version'] == before
    assert detail['source_state']['state'] == 'HISTORICAL'
    assert reason in '；'.join(detail['source_state']['reasons'])


@pytest.mark.parametrize('state', ['SAVED', 'REFERENCE'])
def test_current_saved_reference_scene_does_not_need_formal_current_pointer(api, state):
    _, factory, _, _, _ = api
    with factory.begin() as session:
        plan = session.get(PlanningPlan, 'P1')
        plan.state = state
        plan.confirmed_at = None
        session.delete(session.get(PlanningCurrentPlan, 'T1'))
    data(save(api, body(api, interference_ids=[])))
    detail = data(read(api))
    assert detail['source_state'] == {'state': 'CURRENT', 'reasons': []}
    with factory() as session:
        assert session.get(PlanningCurrentPlan, 'T1') is None
        assert session.get(PlanningPlan, 'P1').state == state


def test_formally_confirmed_scene_keeps_current_pointer_gate(api):
    _, factory, baseline, _, _ = api
    data(save(api))
    before = data(read(api))['version']
    seed(factory, baseline, plan_id='P2', plan_no=2, current=True)
    detail = data(read(api))
    assert detail['version'] == before
    assert detail['source_state']['state'] == 'HISTORICAL'
    assert '当前确认方案已切换' in detail['source_state']['reasons']

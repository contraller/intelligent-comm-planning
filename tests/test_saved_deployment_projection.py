"""Historical saved-plan display projection preserves original persisted data."""
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import sys
from types import SimpleNamespace
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'algorithm-service'))
from app import planning_result_adapter as adapter
from app import planning_plan_service as plans


def fixture():
    result = {'snapshot_id': 'SNP-SOLUTION', 'nodes': [
        {'id': 'N1', 'name': 'Existing', 'coordinate': [0, 0]},
        {'id': 'R1', 'name': 'New relay', 'coordinate': [114.2, 37.3]},
    ], 'configuration': {'deployment': [
        {'stationId': 'N1', 'deviceIds': ['D1'], 'role': 'TASK'},
        {'stationId': 'R1', 'deviceIds': ['D2'], 'role': 'RELAY'},
    ]}}
    raw = {'solution_id': 'SOLUTION', 'detail': {'nodes': [
        {'node_id': 'N1', 'lon': 0, 'lat': 0},
        {'node_id': 'R1', 'lon': 114.2, 'lat': 37.3, '_added_relay': True},
    ], 'deployment': {'added': ['R1']}}}
    return result, raw


def test_saved_plan_dto_projects_legacy_fields_without_mutating_storage_or_reading_live(monkeypatch):
    result, raw = fixture()
    plan = SimpleNamespace(plan_id='PLAN', task_id='TASK', job_id='JOB', revision_id='INPUT',
        version_no=1, name='Saved', note='', condition_version='COND', resource_revision='RES',
        input_snapshot={}, parent_plan_id=None, state='REFERENCE', saved_at=datetime.now(timezone.utc),
        confirmed_at=None, source='frozen', result_snapshot=result, raw_snapshot=raw,
        outcome_snapshot={'code': 3001}, adjustment=None)
    original = deepcopy(plan.__dict__)
    monkeypatch.setattr(plans.frontend_integration, 'resource_revision', lambda: pytest.fail('reads live resource'))
    monkeypatch.setattr(adapter.planning_w4, '_load', lambda *_: pytest.fail('reads live CSV'))
    dto = plans._dto(plan, source_changed=False)
    assert [node['isNewDeployment'] for node in dto['result']['nodes']] == [False, True]
    assert [row['plannedCoordinate'] for row in dto['result']['configuration']['deployment']] == [[0, 0], [114.2, 37.3]]
    assert plan.__dict__ == original
    dto['result']['nodes'][0]['name'] = 'Client display only'
    assert plan.__dict__ == original


def test_explicit_saved_marker_and_planned_coordinate_are_preserved():
    result, raw = fixture()
    result['nodes'][1]['isNewDeployment'] = False
    result['configuration']['deployment'][1]['plannedCoordinate'] = [115, 38]
    dto = adapter.project_saved_deployment_display(result, raw)
    assert dto['nodes'][1]['isNewDeployment'] is False
    assert dto['configuration']['deployment'][1]['plannedCoordinate'] == [115, 38]


@pytest.mark.parametrize('change', ['absent', 'snapshot', 'node', 'ambiguous', 'invalid-coordinate'])
def test_missing_or_mismatched_raw_data_never_guesses_deployment(change):
    result, raw = fixture()
    if change == 'absent': raw = None
    elif change == 'snapshot': raw['solution_id'] = 'OTHER'
    elif change == 'node': raw['detail']['nodes'][1]['node_id'] = 'OTHER'
    elif change == 'ambiguous': raw['detail']['nodes'].append(dict(raw['detail']['nodes'][1]))
    elif change == 'invalid-coordinate': raw['detail']['nodes'][1]['lon'] = 200
    before = deepcopy((result, raw))
    dto = adapter.project_saved_deployment_display(result, raw)
    assert (result, raw) == before
    assert 'plannedCoordinate' not in dto['configuration']['deployment'][1]
    if change != 'invalid-coordinate':
        assert 'isNewDeployment' not in dto['nodes'][1]

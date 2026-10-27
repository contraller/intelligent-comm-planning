"""Deployment identity and coordinates belong to the frozen result, not live CSVs."""
from copy import deepcopy
from pathlib import Path
import sys
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'algorithm-service'))
from app import planning_result_adapter as adapter


@pytest.mark.parametrize('marker', ['native', 'deployment-list'])
def test_frozen_coordinates_and_explicit_new_deployment_identity(monkeypatch, marker):
    monkeypatch.setattr(adapter.planning_w4, '_load', lambda *a: pytest.fail('reads live CSV'))
    nodes = [dict(node_id='N1', node_name='Original', lon=0, lat=0),
             dict(node_id='R1', node_name='Added relay', lon=114.2, lat=37.3)]
    if marker == 'native':
        nodes[1]['_added_relay'] = True
    detail = {'nodes': nodes, 'links': [], 'devices': [], 'deployment': {'added': ['R1'] if marker == 'deployment-list' else []}}
    plan = {'solution_id': 'TEST', 'summary': {}, 'detail': detail}
    inputs, resources = {'demands': []}, {'device_model.csv': [], 'device.csv': []}
    original = deepcopy((plan, inputs, resources))
    result, _ = adapter.adapt_planning_result(plan, inputs, resource_rows=resources)
    assert [row['isNewDeployment'] for row in result['nodes']] == [False, True]
    assert [row['plannedCoordinate'] for row in result['configuration']['deployment']] == [[0, 0], [114.2, 37.3]]
    assert (plan, inputs, resources) == original

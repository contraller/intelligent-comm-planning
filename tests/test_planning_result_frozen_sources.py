"""冻结结果适配不得读取当前型号CSV或把显式空设备误作缺失。"""
from copy import deepcopy
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'algorithm-service'))
from app import planning_result_adapter as adapter


def fixture():
    device = {'device_id':'D1','node_id':'N1','model_id':'M1','tx_power_dbm':'0','antenna_height_m':'1'}
    plan = {'solution_id':'fixture-plan','summary':{},'detail':{'nodes':[], 'links':[], 'devices':[device]}}
    rows = {'device_model.csv':[{'model_id':'M1','model_name':'冻结型号名称','device_class':'HF'}],
            'device.csv':[{'device_id':'current-should-not-be-used'}]}
    return plan, {'demands':[]}, rows


def test_frozen_model_and_plan_devices_are_not_current_csv(monkeypatch):
    monkeypatch.setattr(adapter.planning_w4, '_load', lambda *a: pytest.fail('读取当前CSV'))
    plan, input_data, rows = fixture()
    originals = deepcopy((plan, input_data, rows))
    result, _ = adapter.adapt_planning_result(plan, input_data, resource_rows=rows)
    assert [row['id'] for row in result['devices']] == ['D1']
    assert result['devices'][0]['modelName'] == '冻结型号名称'
    assert result['devices'][0]['txPowerDbm'] == 0
    assert (plan, input_data, rows) == originals


def test_explicit_empty_devices_do_not_trigger_truthy_fallback(monkeypatch):
    monkeypatch.setattr(adapter.planning_w4, '_load', lambda *a: pytest.fail('读取当前CSV'))
    plan, input_data, rows = fixture()
    plan['detail']['devices'] = []
    assert adapter.adapt_planning_result(plan, input_data, resource_rows=rows)[0]['devices'] == []


@pytest.mark.parametrize('missing', ['device.csv','device_model.csv','detail.devices'])
def test_missing_frozen_source_fails_instead_of_current_fallback(monkeypatch, missing):
    monkeypatch.setattr(adapter.planning_w4, '_load', lambda *a: pytest.fail('读取当前CSV'))
    plan, input_data, rows = fixture()
    if missing == 'detail.devices':
        plan['detail'].pop('devices')
    else:
        rows.pop(missing)
    with pytest.raises(ValueError, match='冻结规划结果缺少'):
        adapter.adapt_planning_result(plan, input_data, resource_rows=rows)


def test_legacy_none_preserves_existing_loader(monkeypatch):
    calls = []
    monkeypatch.setattr(adapter.planning_w4, '_load', lambda name: calls.append(name) or [])
    plan, input_data, _ = fixture()
    plan['detail']['devices'] = []
    assert adapter.adapt_planning_result(plan, input_data)[0]['devices'] == []
    assert calls == ['device_model.csv', 'device.csv']

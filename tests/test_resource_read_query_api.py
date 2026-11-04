"""现有资源 GET 统一委托严格查询；使用隔离库验证页面参数。"""
from collections import Counter
from copy import deepcopy

import pytest

from test_resource_export_api import api  # noqa: F401


def get(client, snapshot, path, **query):
    return client.get('/api/v1/resource/' + path, params={
        'context': 'ledger', 'revision': snapshot['revision'], **query})


@pytest.mark.parametrize('path', ['devices', 'nodes', 'interference-sources'])
def test_pages_reject_unknown_duplicate_and_invalid_paging(api, path):
    client, _, snapshot = api
    for patch in ({'page_size': 15}, {'page': '1.0'}, {'unexpected': 'x'}):
        result = get(client, snapshot, path, **patch)
        assert result.status_code == 422, result.text
        assert result.json()['code'] == 1001
    result = client.get('/api/v1/resource/' + path, params=[
        ('context', 'ledger'), ('revision', snapshot['revision']), ('page', '1'), ('page', '2')])
    assert result.status_code == 422, result.text


def test_device_filter_sort_and_detail_use_one_frozen_version(api):
    client, _, snapshot = api
    result = get(client, snapshot, 'devices', device_class='HF', sort='id', order='desc', page_size=5)
    assert result.status_code == 200, result.text
    data = result.json()['data']
    assert data['revision'] == snapshot['revision'] and data['total'] > 5
    assert all(row['device_class'] == 'HF' for row in data['items'])
    assert [row['device_id'] for row in data['items']] == sorted(
        (row['device_id'] for row in data['items']), reverse=True)
    item = data['items'][0]
    detail = get(client, snapshot, 'devices/' + item['device_id'])
    assert detail.status_code == 200, detail.text
    detail = detail.json()['data']
    assert detail['item'] == item
    assert detail['node']['node_id'] == item['node_id']
    assert detail['model']['model_id'] == item['model_id']
    assert detail['antenna']['antenna_id'] == item['antenna_id']


@pytest.mark.parametrize('filters', [
    {}, {'page': 2, 'page_size': 5}, {'search': 'DV-0001'},
    {'device_class': 'HF', 'mobility': 'VEHICLE'}, {'search': 'not-an-existing-device'},
])
def test_device_deployment_totals_remain_full_revision_counts(api, filters):
    client, _, snapshot = api
    response = get(client, snapshot, 'devices', **filters)
    assert response.status_code == 200, response.text
    data = response.json()['data']
    tables = snapshot['tables']
    nodes = {row['node_id']: row for row in tables['node.csv']}
    models = {row['model_id']: row for row in tables['device_model.csv']}
    groups = Counter((models[row['model_id']]['device_class'], nodes[row['node_id']]['mobility'])
                     for row in tables['device.csv'])
    expected = {band: {mode: groups[band, mode] for mode in ('FIXED', 'VEHICLE', 'MANPACK', 'UNKNOWN')}
                for band in ('HF', 'VUHF')}
    assert data['stats']['deployments'] == expected
    assert sum(expected['HF'].values()) == data['stats']['hf'] == 174
    assert sum(expected['VUHF'].values()) == data['stats']['vuhf'] == 240
    context = client.get('/api/v1/resource/context', params={'context': 'ledger'}).json()['data']
    assert context['revision'] == data['revision'] == snapshot['revision']
    assert context['stats']['deployments'] == data['stats']['deployments']


def test_unknown_station_deployment_is_not_counted_as_fixed(api, monkeypatch):
    from app import resource_read_projection as projection
    client, _, snapshot = api
    frozen = deepcopy(snapshot)
    node = frozen['tables']['node.csv'][0]
    node['mobility'] = ''
    affected = sum(device['node_id'] == node['node_id'] for device in frozen['tables']['device.csv'])
    original = get(client, snapshot, 'devices').json()['data']['stats']['deployments']
    monkeypatch.setattr(projection.datasets, 'current', lambda: frozen)
    stats = get(client, snapshot, 'devices', search='not-an-existing-device').json()['data']['stats']
    assert stats['deployments']['HF']['UNKNOWN'] == original['HF']['UNKNOWN'] + affected
    assert stats['deployments']['HF']['FIXED'] == original['HF']['FIXED'] - affected
    assert sum(stats['deployments']['HF'].values()) == stats['hf']


def test_node_association_map_frequency_and_missing_object(api):
    client, _, snapshot = api
    nodes = get(client, snapshot, 'nodes', parent_id='', page_size=50)
    assert nodes.status_code == 200, nodes.text
    assert all(not row['parent_node_id'] for row in nodes.json()['data']['items'])
    frame = get(client, snapshot, 'map', bbox='-180,-90,180,90', zoom=9,
                frequency_mode='DEVICE', frequency_presence='MISSING', show_interferences='false')
    assert frame.status_code == 200, frame.text
    assert frame.json()['data']['total_interferences'] == 0
    assert all(row['kind'] == 'node' for row in frame.json()['data']['points'])
    missing = get(client, snapshot, 'devices/not-present')
    assert (missing.status_code, missing.json()['code']) == (404, 1002)
    stale = get(client, snapshot, 'nodes', revision='resource-0000000000000000')
    assert (stale.status_code, stale.json()['code']) == (409, 1205)


@pytest.mark.parametrize('path,patch', [
    ('devices', {'status_mode': 'observed'}),
    ('devices', {'observation_snapshot_id': 'unbound'}),
    ('nodes', {'status_mode': 'observed', 'observation_snapshot_id': 'unbound'}),
    ('map', {'bbox': '-180,-90,180,90', 'zoom': 'nan'}),
    ('map', {'bbox': '180,-90,-180,90', 'zoom': 9}),
])
def test_ambiguous_status_and_invalid_viewport_fail_closed(api, path, patch):
    client, _, snapshot = api
    result = get(client, snapshot, path, **patch)
    assert (result.status_code, result.json()['code']) == (422, 1001), result.text

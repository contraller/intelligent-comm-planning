"""GIS导出共享路由分派；隔离库验证，非浏览器下载证据。"""
from io import StringIO
import csv

import pytest

from test_resource_export_api import api, headers, counts  # noqa: F401


def payload(snapshot, **patch):
    return {'context':'gis','revision':snapshot['revision'],'format':'csv','kinds':['devices'],
            'range':'all','browse':'devices',**patch}


def send(client, body, *, file=False):
    return client.post('/api/v1/resource/export' + ('' if file else '/preview'),
        json=body,headers=headers(client))


def test_gis_dispatch_preserves_source_and_full_count_without_writes(api):
    client, factory, snapshot = api
    before = counts(factory)
    request = payload(snapshot)
    preview = send(client,request)
    assert preview.status_code == 200, preview.text
    data = preview.json()['data']
    assert data['revision'] == snapshot['revision']
    assert data['tables'] == [{'kind':'devices','count':414}]
    assert data['warnings'] and data['added'] == 0
    response = send(client,request,file=True)
    assert response.status_code == 200, response.text
    assert response.headers['x-resource-revision'] == snapshot['revision']
    assert len(list(csv.DictReader(StringIO(response.content.decode('utf-8'))))) == 414
    assert counts(factory) == before


def test_gis_selected_bucket_is_not_full_library_fallback(api):
    client, factory, snapshot = api
    before = counts(factory)
    request = payload(snapshot,range='selected',selected_ids={'devices':['DV-0001']})
    data = send(client,request).json()['data']
    assert data['tables'] == [{'kind':'devices','count':1}]
    rows = list(csv.DictReader(StringIO(send(client,request,file=True).content.decode('utf-8'))))
    assert len(rows) == 1 and rows[0]['device_id'] == 'DV-0001'
    invalid = payload(snapshot,range='selected',selected_ids={'nodes':['ND-0001']})
    assert send(client,invalid).status_code == 422
    assert counts(factory) == before


def test_gis_candidate_file_stays_separate_and_carries_reference_warning(api):
    client, _, snapshot = api
    request = payload(snapshot,kinds=['topology_links'])
    data = send(client,request).json()['data']
    assert data['tables'] == [{'kind':'topology_links','count':0}]
    assert data['warnings']
    response = send(client,request,file=True)
    assert response.status_code == 200, response.text
    assert response.content.decode('utf-8').startswith('link_id,node_a_id,')
    assert len(next(csv.reader(StringIO(response.content.decode('utf-8'))))) == 15


@pytest.mark.parametrize('patch,status,code', [
    ({'revision':'resource-0000000000000000'},409,1205),
    ({'range':'selected','selected_ids':{'devices':['not-found']}},404,1002),
    ({'range':'filtered','filter':{'status_mode':'observed','observation_snapshot_id':'missing'}},422,1001),
    ({'kinds':['devices','topology_links'],'format':'xlsx'},422,1001),
])
def test_gis_export_rejects_invalid_scopes_as_one_batch(api, patch, status, code):
    client, factory, snapshot = api
    before = counts(factory)
    result = send(client,payload(snapshot,**patch))
    assert (result.status_code,result.json()['code']) == (status,code), result.text
    assert counts(factory) == before


@pytest.mark.parametrize('download', [False, True])
def test_gis_export_requires_csrf_even_when_read_only(api, download):
    client, factory, snapshot = api
    before = counts(factory)
    response = client.post('/api/v1/resource/export' + ('' if download else '/preview'),
                           json=payload(snapshot), headers={**headers(client), 'X-CSRF-Token': 'invalid'})
    assert (response.status_code, response.json()['code']) == (403, 1105)
    assert counts(factory) == before


@pytest.mark.parametrize('download', [False, True])
def test_gis_export_requires_situation_permission_in_addition_to_resource_read(api, monkeypatch, download):
    from app import resource_export_router
    client, factory, snapshot = api
    before = counts(factory)
    original = resource_export_router.identity.require

    def scoped(request, permission, **options):
        if permission == 'situation.view':
            raise resource_export_router.identity.IdentityError('无GIS权限', 1104, 403)
        return original(request, permission, **options)

    monkeypatch.setattr(resource_export_router.identity, 'require', scoped)
    response = send(client, payload(snapshot), file=download)
    assert (response.status_code, response.json()['code']) == (403, 1104)
    assert counts(factory) == before

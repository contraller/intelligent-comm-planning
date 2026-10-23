"""Regression checks for native DEM integration and the regenerated static demo."""
import base64
import csv
import json
import math
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'scripts'), str(ROOT / 'scripts/planning'), str(ROOT / 'algorithm-service')]
from terrain import BBOX, DEM_HEADER, default_terrain
from app.candidate_sites import DEFAULT_AREA_BBOX, _in_bbox
from planning import viewshed


def demo():
    html = (ROOT / 'W1-W3算法演示.html').read_text(encoding='utf-8')
    return json.loads(re.search(r'<script id="demo-data" type="application/json">(.*?)</script>', html, re.S)[1])


def test_native_dem_and_planning_extent():
    meta = json.loads(Path(DEM_HEADER).read_text(encoding='utf-8'))
    assert meta['bbox'] == meta['source_bbox']
    # 源文件以哈希为准：「太行山东麓_20261009」批次的 dem/dem_taihang.tif
    assert meta['source_sha256'] == 'a42f42e17d38218f539cb04323696cacb296c4bcc11bb50a77cccf927f91bf7f'
    assert meta['nodata_count'] == 0
    assert tuple(meta['planning_bbox']) == BBOX
    assert list(BBOX) == DEFAULT_AREA_BBOX
    ml = 111320 * math.cos(math.radians((BBOX[1] + BBOX[3]) / 2))
    assert abs((BBOX[2] - BBOX[0]) * ml - 120000) < .001
    assert abs((BBOX[3] - BBOX[1]) * 111320 - 120000) < .001
    assert meta['bbox'][0] < BBOX[0] < BBOX[2] < meta['bbox'][2]
    assert meta['bbox'][1] < BBOX[1] < BBOX[3] < meta['bbox'][3]


def test_unmeasured_landcover_is_not_clamped():
    t = default_terrain(False)
    # 2026-10-12 起地物覆盖整个 DEM 范围，规划区内不应再有「未知」；数据范围外仍不外推边缘值
    assert t.landcover(113.5, 37) != '未知'
    assert t.landcover(113.0, 37) == '未知'


def test_candidate_rounding_at_boundary_is_accepted():
    site = {'lon': str(BBOX[0]), 'lat': str(round(BBOX[3], 6))}
    assert _in_bbox(site, list(BBOX))
    assert not _in_bbox({'lon': str(BBOX[0] - .0001), 'lat': str(BBOX[1])}, list(BBOX))


def test_full_120_km_blind_grid_does_not_lose_boundary_row():
    zones = viewshed.blind_zones(set(), BBOX)
    assert zones[0][0] == 14400
    assert len(zones[0][1]) == 120 * 120


def test_html_sources_nodes_and_all_detailed_results_are_fresh():
    d = demo()
    assert d['meta']['bbox'] == list(BBOX)
    assert d['basemap']['extent'] == d['meta']['dem']['source_bbox']
    assert 'replacement_run' not in d['meta']
    with (ROOT / 'data/synthetic/nodes/nodes_v1.csv').open(encoding='utf-8', newline='') as f:
        rows = list(csv.DictReader(f))
    nodes = {n['id']: n for n in d['nodes']}
    for r in rows:
        n = nodes[r['node_id']]
        assert (n['lon'], n['lat'], n['elev']) == (float(r['lon']), float(r['lat']), float(r['elevation_m']))
        assert n['radio']
    total = d['w1']['quantity']['demands']
    assert total == len(d['w3']['demands'])
    assert all(len(v) == total for v in d['w3']['routes'].values())
    assert len(d['w4']['routes']['routes']) == total
    assert set(d['w2']['hf']['rings']) <= nodes.keys()
    assert all(r['node_id'] in nodes for r in d['w4']['nodes'])
    for plan in [d['w2']['pre']] + d['w2']['plans'] + d['w2']['fixed']:
        assert plan['metrics']['total_demand_count'] == total
        assert all(a['id'] in nodes and nodes[a['id']]['radio'] for a in plan['added'])
        if plan['metrics']['unconnected']:
            assert plan['metrics']['gap'] is None
            assert not plan['metrics']['proved_optimal']
    cov = d['w2']['coverage']
    assert len(base64.b64decode(cov['cnt'])) == cov['hx'] * cov['hy']
    assert len(base64.b64decode(cov['maxm'])) == cov['hx'] * cov['hy']
    assert cov['planning_km2'] == 14400
    assert all(0 <= c < 14400 for z in cov['blind'] for c in z['cells'])


def test_html_embeds_traceable_fault_knowledge():
    d = demo()
    kg = d['sr5']
    with (ROOT / 'data/fault/cases/fault_cases_v1.csv').open(encoding='utf-8', newline='') as f:
        cases = list(csv.DictReader(f))
    with (ROOT / 'data/fault/knowledge_graph/fault_triples_v1.csv').open(
            encoding='utf-8', newline='') as f:
        triples = list(csv.DictReader(f))
    assert kg['stats']['cases'] == len(cases) == 240
    assert kg['stats']['triples'] == len(triples) == 2022
    assert len(kg['symptoms']) == 15
    assert {row[1] for row in kg['cases']} == {
        'HW_FAILURE', 'LINK_DOWN', 'SW_CONFIG', 'EMI'}
    assert all('[CONSTRUCTED]' in row[7] for row in kg['triples'])
    assert kg['stats']['relations']['diagnosedBy'] == 960


def test_html_embeds_sr5_flow_and_sr6_platform_results():
    d = demo()
    sr5 = d['sr5']
    sr6 = d['sr6']

    assert len(sr5['scenarios']) == 5
    assert all(s['diagnosis']['results'] for s in sr5['scenarios'])
    assert all('affected_nodes' in s['impact'] for s in sr5['scenarios'])
    assert all(s['suggestions']['suggestions'] for s in sr5['scenarios'])

    assert sr6['stats']['entities'] == 1835
    assert sr6['stats']['triples'] == 5853
    assert sr6['stats']['by_graph'] == {
        'device': 1449,
        'network': 1662,
        'fault': 2742,
    }
    assert sr6['quality']['status'] == 'PASS'
    assert not sr6['quality']['errors']
    assert len(sr6['device_models']) == 8
    assert len(sr6['link_examples']) == 4
    assert set(sr6['triple_samples']) == {'device', 'network', 'fault'}


def test_html_discloses_requirements_gaps():
    html = (ROOT / 'W1-W3算法演示.html').read_text(encoding='utf-8')
    assert '需规复核后的未闭环项' in html
    assert '图谱到网络规划的规则共享尚未接入' in html
    assert '地形使用当前导入 DEM，其来源与授权待确认' in html
    assert '或要求独立场景切换，仍需确认' in html


def test_coverage_cache_identity_changes_with_dem_input(tmp_path, monkeypatch):
    from app.coverage import _key
    import terrain
    header = tmp_path / 'dem.json'
    header.write_text('{"source_sha256":"old"}', encoding='utf-8')
    monkeypatch.setattr(terrain, 'DEM_HEADER', str(header))
    first = _key(['ND-0001'], 'VUHF', {})
    header.write_text('{"source_sha256":"new"}', encoding='utf-8')
    assert first != _key(['ND-0001'], 'VUHF', {})

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
    assert meta['source'] == 'dem_taihang(1).tif'
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
    assert t.landcover(113.5, 37) == '未知'


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


def test_coverage_cache_identity_changes_with_dem_input(tmp_path, monkeypatch):
    from app.coverage import _key
    import terrain
    header = tmp_path / 'dem.json'
    header.write_text('{"source_sha256":"old"}', encoding='utf-8')
    monkeypatch.setattr(terrain, 'DEM_HEADER', str(header))
    first = _key(['ND-0001'], 'VUHF', {})
    header.write_text('{"source_sha256":"new"}', encoding='utf-8')
    assert first != _key(['ND-0001'], 'VUHF', {})

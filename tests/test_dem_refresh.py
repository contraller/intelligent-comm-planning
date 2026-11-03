"""当前 DEM 与算法边界回归；旧 HTML 检查原文可从 Git 历史追溯。"""
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'scripts'), str(ROOT / 'scripts/planning'), str(ROOT / 'algorithm-service')]
from terrain import BBOX, DEM_HEADER, default_terrain
from app.candidate_sites import DEFAULT_AREA_BBOX, _in_bbox
from planning import viewshed


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


def test_coverage_cache_identity_changes_with_dem_input(tmp_path, monkeypatch):
    from app.coverage import _key
    import terrain
    header = tmp_path / 'dem.json'
    header.write_text('{"source_sha256":"old"}', encoding='utf-8')
    monkeypatch.setattr(terrain, 'DEM_HEADER', str(header))
    first = _key(['ND-0001'], 'VUHF', {})
    header.write_text('{"source_sha256":"new"}', encoding='utf-8')
    assert first != _key(['ND-0001'], 'VUHF', {})

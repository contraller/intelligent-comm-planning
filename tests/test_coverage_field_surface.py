"""预测覆盖专项：构造DEM验证物理响应与几何，不作为现场实测验收。"""
from copy import deepcopy
import math

import pytest

from test_frozen_coverage_engine import scenario, compute, hf, SMALL, FINGERPRINT
from app import coverage_field_surface as surface, frozen_coverage_engine as engine


def field_compute(scenario, **kwargs):
    return engine.compute_frozen_field_coverage(scenario.raw, scenario.tables,
        terrain=scenario.factory, fingerprint=lambda:FINGERPRINT, params={**SMALL, **kwargs})


def test_field_conversion_matches_independent_free_space_electric_field():
    # 1W EIRP、100MHz、1km：E=sqrt(30*EIRP)/r；不由本实现反算预期。
    from propagation import fspl_db
    expected = 20*math.log10(math.sqrt(30)/1000*1e6)
    assert surface.field_strength(30-fspl_db(100000,1000),100000) == pytest.approx(expected, abs=0.02)
    for power, frequency in ((float('nan'),1000),(1,0),(1,float('inf'))):
        with pytest.raises(ValueError):surface.field_strength(power,frequency)


def test_v5_grid_faces_field_units_and_parent_immutable(scenario):
    original=deepcopy(scenario.raw)
    result=field_compute(scenario)
    assert result['provenance']['engine_version']=='V01-5'
    assert result['provenance']['units']['field_strength']=='dBuV/m'
    features=result['devices'][0]['computations'][0]['geojson']['features']
    assert features and all(f['geometry']['type']=='Polygon' for f in features)
    assert all(f['properties']['surface_kind']=='TERRAIN_CELL' for f in features)
    assert scenario.raw==original
    engine.validate_field_result(result)


def test_power_change_causes_ten_db_field_change_without_mutating_saved_result(scenario):
    first=field_compute(scenario)
    scenario.raw['detail']['params']['params'][0]['tx_power_dbm']+=10
    second=field_compute(scenario)
    before=first['devices'][0]['computations'][0]['geojson']['features']
    after=second['devices'][0]['computations'][0]['geojson']['features']
    assert len(before)==len(after)>0
    assert [b['properties']['field_strength_dbuvm']-a['properties']['field_strength_dbuvm'] for a,b in zip(before,after)]==pytest.approx([10]*len(before))


def test_real_dem_ridge_reduces_east_field_without_forcing_circle(scenario):
    # 原栅格约1km；增加东侧一道山脊，比较东西目标的真实P.1812预算。
    parameters=dict(radius_m=5000,cell_m=1000,az_step_deg=10,margin_min_db=-100)
    first=field_compute(scenario,**parameters)
    raster=scenario.dem._dem
    col=int((114.015-raster.origin_lon)/raster.pixel_lon)
    for row in range(raster.height):raster.data[row*raster.width+col]=1600
    second=field_compute(scenario,**parameters)
    def cells(result):return {(r['gx'],r['gy']):r['field_strength_dbuvm'] for r in result['devices'][0]['computations'][0]['cells']}
    flat,ridge=cells(first),cells(second)
    assert ridge[(4,0)] < flat[(4,0)]-10
    assert ridge[(-4,0)]==pytest.approx(flat[(-4,0)])


def test_hf_budgeted_bands_keep_static_zone_and_do_not_use_skip_multiplier(scenario):
    hf(scenario)
    result=field_compute(scenario,hf_max_km=900,margin_min_db=6)
    part=result['devices'][0]['computations'][0]
    assert len(part['radial_samples'])==900
    assert part['skip_distance_m']>0
    assert any(not row['is_coverage'] and row['surface_kind']=='SKIP_ZONE' for row in part['rings'])
    for ring in part['rings']:
        assert ring['outer_m']<=900000
        assert ring['outer_m']/1000==int(ring['outer_m']/1000)
    for feature in part['geojson']['features']:
        if feature['properties']['inner_m']>0:assert len(feature['geometry']['coordinates'])==2
    assert result['provenance']['hf_ionosphere']['assumed'] is True


def test_hf_nvis_no_forced_hole_and_power_dependent_extent(scenario):
    hf(scenario)
    for row in scenario.raw['detail']['frequency']['link_assignments']:row['freq_khz']=5000
    result=field_compute(scenario,hf_max_km=60,margin_min_db=6)
    part=result['devices'][0]['computations'][0]
    assert part['skip_distance_m']==0
    assert not any(row['surface_kind']=='SKIP_ZONE' for row in part['rings'])
    scenario.raw['detail']['params']['params'][0]['tx_power_dbm']=-50
    lower=field_compute(scenario,hf_max_km=60,margin_min_db=6)
    covered=lambda p:sum(row['outer_m']-row['inner_m'] for row in p['rings'] if row['is_coverage'])
    assert covered(lower['devices'][0]['computations'][0])<covered(part)


@pytest.mark.parametrize('change',['field','unit','margin','grade','point','version'])
def test_field_contract_rejects_forged_measurement_or_geometry(scenario,change):
    result=field_compute(scenario)
    feature=result['devices'][0]['computations'][0]['geojson']['features'][0]
    if change=='field':feature['properties']['field_strength_dbuvm']+=2
    if change=='margin':feature['properties']['margin_db']+=2
    if change=='unit':result['provenance']['units']['field_strength']='dB'
    if change=='grade':feature['properties']['strength_class']='INVALID'
    if change=='point':feature['geometry']['type']='Point'
    if change=='version':result['provenance']['engine_version']='V01-4'
    with pytest.raises(engine.FrozenCoverageError):engine.validate_field_result(result)


def test_old_v4_engine_remains_old_prediction_without_relabelling(scenario):
    result=compute(scenario)
    assert result['provenance']['engine_version']=='V01-4'
    assert 'field_strength' not in result['provenance']['units']
    assert result['devices'][0]['computations'][0]['geojson']['features'][0]['geometry']['type']=='Point'


def test_out_of_model_band_is_unavailable_not_extrapolated(scenario):
    hf(scenario)
    scenario.tables['device_model.csv'][0]['freq_max_khz']='60000'
    for row in scenario.raw['detail']['frequency']['link_assignments']:row['freq_khz']=45000
    result=field_compute(scenario)
    assert result['status']=='UNAVAILABLE'
    assert all(not device['computations'] and device['radio_parameters'] is None for device in result['devices'])

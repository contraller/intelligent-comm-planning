import { afterEach, describe, expect, it } from 'vitest';
import { effectScope, reactive, ref, type EffectScope } from 'vue';
import { defaultGisResultLayers, gisResultLayerRows, splitGisRegions, type GisResultLayerContext } from '../src/maps/gis-result-layers';
import { useGisResultLayers } from '../src/composables/useGisResultLayers';
import type { MapRegion } from '../src/types/domain';

// 只用已声明的 kind 判断来源；名称故意带有不同业务词，防止按文案推测。
const regions: MapRegion[] = ['coverage', 'blind', 'uncalculated', 'impact'].map((kind, i) => ({
  id: String(i), kind: kind as MapRegion['kind'], label: '故障与干扰示意', rings: [],
}));
const context = (): GisResultLayerContext => ({ mode: 'resource', readable: true, paused: false, regions,
  deviceMode: false, deviceCoverageAvailable: false, interferenceAvailable: true, interferenceFilteredOut: false });
const scopes: EffectScope[] = [];
function setup() {
  const state = reactive(context()), generation = ref(1), scope = effectScope(); scopes.push(scope);
  const layers = scope.run(() => useGisResultLayers(() => state, () => generation.value))!;
  return { state, generation, scope, layers, row: (id: string) => layers.rows.value.find(row => row.id === id)! };
}
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); });

describe('GIS 结果图层独立显示状态', () => {
  it('默认值彼此独立，分类不按名称猜测且不改写来源', () => {
    const first = defaultGisResultLayers(), second = defaultGisResultLayers(), before = JSON.stringify(regions);
    expect(Object.values(first)).toEqual(Array.from({ length: 4 }, () => ({ visible: true, opacity: 0.8 })));
    first.coverage.visible = false; expect(first.illustration.visible).toBe(true); expect(second.coverage.visible).toBe(true);
    const groups = splitGisRegions([...regions, { ...regions[0], kind: 'unknown' as MapRegion['kind'] }]);
    expect(groups.coverage.map(row => row.kind)).toEqual(['coverage', 'blind', 'uncalculated']);
    expect(groups.illustration).toEqual([regions[3]]); expect(JSON.stringify(regions)).toBe(before);
  });
  it('每组开关与透明度只改变自身，覆盖入口只开启覆盖', () => {
    const s = setup(); s.state.mode = 'analysis';
    s.layers.change.value('interference', { visible: false, opacity: 0.3 });
    s.layers.change.value('illustration', { visible: false, opacity: 0.4 });
    s.layers.change.value('coverage', { visible: false, opacity: 0.6 });
    s.state.mode = 'resource'; s.layers.enableCoverage();
    expect(s.row('coverage')).toMatchObject({ visible: true, opacity: 0.6 });
    expect(s.row('interference')).toMatchObject({ visible: false, opacity: 0.3 });
    expect(s.row('illustration')).toMatchObject({ visible: false, opacity: 0.4 });
  });
  it.each([NaN, Infinity, -0.1, 1.1])('拒绝越界或非有限透明度 %s', value => {
    const s = setup(); s.layers.change.value('coverage', { opacity: value }); expect(s.row('coverage').opacity).toBe(0.8);
  });
  it('未知组和非法开关不能污染配置，边界值 0 与 1 可用', () => {
    const s = setup(); s.layers.change.value('other' as 'coverage', { visible: false });
    s.layers.change.value('coverage', { visible: 'false' as unknown as boolean }); expect(s.row('coverage').visible).toBe(true);
    s.layers.change.value('coverage', { opacity: 0 }); expect(s.row('coverage').opacity).toBe(0);
    s.layers.change.value('coverage', { opacity: 1 }); expect(s.row('coverage').opacity).toBe(1);
  });
  it('监控、无权限、资源已脏均暂停区域，不能用陈旧事件打开', () => {
    const s = setup(); s.layers.change.value('coverage', { opacity: 0.4 }); const old = s.layers.change.value;
    s.state.mode = 'monitoring'; expect(Object.values(s.layers.rendered.value).every(row => !row.visible)).toBe(true);
    expect(s.row('coverage').reason).toContain('监控网络'); s.layers.change.value('coverage', { opacity: 0.1 });
    s.state.mode = 'resource'; old('coverage', { opacity: 0.2 }); expect(s.row('coverage').opacity).toBe(0.4);
    s.state.paused = true; s.layers.enableCoverage(); expect(s.layers.rendered.value.coverage.visible).toBe(false);
    expect(s.row('illustration').reason).toContain('旧区域暂停');
    s.state.paused = false; s.state.readable = false; expect(s.row('coverage').available).toBe(false);
    expect(s.row('coverage').reason).toContain('权限'); s.state.readable = true;
    expect(s.layers.rendered.value.coverage).toEqual({ visible: true, opacity: 0.4 });
  });
  it('分析冻结结果不受资源草稿暂停，筛选为空只说明当前无区域', () => {
    const s = setup(); s.state.mode = 'analysis'; s.state.paused = true; s.state.interferenceFilteredOut = true;
    expect(s.row('coverage').available).toBe(true); expect(s.row('interference').available).toBe(true);
    expect(s.row('interference').reason).toContain('等级筛选');
    s.state.interferenceAvailable = false; expect(s.row('interference').available).toBe(false);
    expect(s.row('interference').reason).toContain('未提供');
  });
  it('无样例设备及空多选不借用整网数据，整网切回后恢复偏好', () => {
    const s = setup(); s.layers.change.value('coverage', { opacity: 0.3 });
    s.state.deviceMode = true; expect(s.layers.rendered.value.coverage.visible).toBe(false);
    expect(s.row('coverage').reason).toContain('所选设备'); expect(s.layers.rendered.value.illustration.visible).toBe(true);
    s.state.deviceCoverageAvailable = true; expect(s.layers.rendered.value.coverage).toEqual({ visible: true, opacity: 0.3 });
    s.state.deviceCoverageAvailable = false; s.state.deviceMode = false;
    expect(s.layers.rendered.value.coverage).toEqual({ visible: true, opacity: 0.3 });
  });
  it('缺失区域禁用相应组，保留关闭偏好且不改来源', () => {
    const s = setup(); s.layers.change.value('illustration', { visible: false }); const before = JSON.stringify(regions);
    s.state.regions = []; expect(s.row('coverage').available).toBe(false); expect(s.row('illustration').available).toBe(false);
    s.layers.change.value('illustration', { visible: true }); s.state.regions = regions;
    expect(s.row('illustration').visible).toBe(false); expect(JSON.stringify(regions)).toBe(before);
    expect(gisResultLayerRows(context(), defaultGisResultLayers())[1].available).toBe(false);
  });
  it('新页面与身份变更恢复默认；旧身份回调不能修改新设置', () => {
    const s = setup(); s.layers.change.value('coverage', { visible: false, opacity: 0.1 }); const old = s.layers.change.value;
    expect(setup().layers.rendered.value.coverage).toEqual({ visible: true, opacity: 0.8 });
    s.generation.value++; old('coverage', { visible: false });
    expect(s.layers.rendered.value.coverage).toEqual({ visible: true, opacity: 0.8 });
  });
  it('诊断快照仅开放第四组，资源草稿不隐藏冻结结果，筛空与未提供原因分开', () => {
    const s = setup(); expect(s.row('diagnosis')).toMatchObject({ available: false, visible: true, opacity: 0.8 });
    expect(s.row('diagnosis').reason).toContain('进入诊断快照');
    s.state.mode = 'diagnosis'; s.state.paused = true;
    expect(s.row('diagnosis').reason).toContain('未提供');
    s.state.diagnosisAvailable = true;
    expect(s.row('diagnosis')).toMatchObject({ available: true, reason: '' });
    for (const id of ['coverage', 'interference', 'illustration']) {
      expect(s.row(id).available).toBe(false); expect(s.row(id).reason).toContain('诊断快照仅显示');
    }
    s.state.diagnosisFilteredOut = true;
    expect(s.row('diagnosis')).toMatchObject({ available: true, reason: '当前等级筛选未显示诊断影响区域。' });
    s.layers.change.value('diagnosis', { opacity: 0 }); expect(s.row('diagnosis').opacity).toBe(0);
    s.layers.change.value('diagnosis', { visible: false, opacity: 1 }); expect(s.row('diagnosis')).toMatchObject({ visible: false, opacity: 1 });
    s.state.readable = false; expect(s.row('diagnosis').available).toBe(false); expect(s.row('diagnosis').reason).toContain('权限');
  });
  it('同页诊断偏好保留，新报告、模式、权限和卸载均拒绝旧控件闭包', () => {
    const s = setup(); s.state.mode = 'diagnosis'; s.state.diagnosisAvailable = true; s.state.contextId = 1;
    s.layers.change.value('diagnosis', { opacity: 0.3 }); const first = s.layers.change.value;
    s.state.contextId = 2; first('diagnosis', { opacity: 0.1 }); expect(s.row('diagnosis').opacity).toBe(0.3);
    const second = s.layers.change.value; s.state.mode = 'resource'; s.state.mode = 'diagnosis';
    second('diagnosis', { visible: false }); expect(s.row('diagnosis').visible).toBe(true);
    const third = s.layers.change.value; s.state.readable = false; s.state.readable = true;
    third('diagnosis', { visible: false }); expect(s.row('diagnosis').visible).toBe(true);
    s.layers.change.value('diagnosis', { visible: false }); s.generation.value++;
    expect(s.row('diagnosis')).toMatchObject({ visible: true, opacity: 0.8 });
    const last = s.layers.change.value; s.scope.stop(); last('diagnosis', { opacity: 0.4 });
    expect(s.row('diagnosis').opacity).toBe(0.8);
  });
});

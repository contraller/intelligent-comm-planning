import { afterEach, describe, expect, it } from 'vitest';
import { effectScope, reactive, type EffectScope } from 'vue';
import { initialResources } from '../src/mocks/resource-presets';
import { defaultGisDeviceSettings, gisDevicePoints, gisDeviceStatus, gisDeviceSummary, gisDeviceTone, matchesGisDeviceState, sortGisDevices, visibleGisDevices } from '../src/maps/gis-device-display';
import { emptyDeviceFrequencyInput, type DeviceFrequencyInput } from '../src/services/device-frequency-filter';
import { useGisDeviceDisplay } from '../src/composables/useGisDeviceDisplay';

const scopes: EffectScope[] = [];
function setup() {
  const resources = initialResources(), state = reactive({ resources, stationIds: resources.stations.map(row => row.id),
    deviceIds: undefined as string[] | undefined, enabled: true, readable: true, generation: 1, sourceKey: 'initial', selectedDeviceId: '' });
  const scope = effectScope(); scopes.push(scope);
  const display = scope.run(() => useGisDeviceDisplay(() => ({ ...state, stationIds: [...state.stationIds] })))!;
  return { state, display, version: () => display.frame.value!.version };
}
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()));

describe('GIS 设备显示数据', () => {
  // 可选显示副本不修改原资源，未接入入口保留既有断言。
  it('独立观测覆盖设备显示，缺省使用中性色且不算正常无告警', () => {
    const resources = initialResources(), before = JSON.stringify(resources);
    const result = gisDevicePoints(resources, { 'DV-0001': { mode: 'observed', status: null, alert: null, sourceLabel: '教学', retained: false, note: '未上报' } });
    const row = result.points[0]; expect(gisDeviceTone(row)).toBe('UNKNOWN'); expect(gisDeviceStatus(row)).toContain('状态未提供');
    expect(matchesGisDeviceState(row, 'NORMAL')).toBe(false); expect(matchesGisDeviceState(row, 'UNKNOWN')).toBe(true);
    expect(matchesGisDeviceState(row, 'UNKNOWN_ALERT')).toBe(true); expect(JSON.stringify(resources)).toBe(before);
    row.status = 'NORMAL'; expect(gisDeviceTone(row)).toBe('UNKNOWN'); expect(matchesGisDeviceState(row, 'NORMAL')).toBe(false);
  });
  it('414 台设备按实例关联型号和站点，来源及坐标不被修改', () => {
    const resources = initialResources(), before = JSON.stringify(resources), result = gisDevicePoints(resources);
    expect(result.points).toHaveLength(414); expect(result.missingCount).toBe(0);
    for (const row of result.points) {
      const device = resources.devices.find(d => d.id === row.id)!, station = resources.stations.find(s => s.id === device.stationId)!;
      expect(row.coordinate).toEqual(station.coordinate); expect(row.coordinate).not.toBe(station.coordinate);
      expect(row.deviceClass).toBe(resources.models.find(m => m.id === device.modelId)!.deviceClass);
      expect([row.status, row.alert]).toEqual([device.status, device.alert]);
    }
    expect(JSON.stringify(resources)).toBe(before);
  });
  it('状态不借用站点，附加告警和下架不覆盖设备运行状态', () => {
    const resources = initialResources(); resources.stations[0].status = 'FAULT'; resources.stations[0].alert = true;
    const device = resources.devices[0]; device.status = 'OFFLINE'; device.alert = true; device.availability = 'OFF_SHELF';
    const row = gisDevicePoints(resources).points.find(p => p.id === device.id)!;
    expect(gisDeviceTone(row)).toBe('OFFLINE'); expect(gisDeviceStatus(row)).toBe('离线 · 告警'); expect(row.offShelf).toBe(true);
    expect(matchesGisDeviceState(row, 'ALERT')).toBe(true); expect(matchesGisDeviceState(row, 'OFFLINE')).toBe(true);
    row.status = 'NORMAL'; expect(gisDeviceTone(row)).toBe('ALERT'); expect(matchesGisDeviceState(row, 'NORMAL')).toBe(false);
    row.alert = false; expect(matchesGisDeviceState(row, 'NORMAL')).toBe(true);
  });
  it.each(['model', 'class', 'station', 'coordinate'])('缺失或无效 %s 不猜测类型与位置', reason => {
    const resources = initialResources(), device = resources.devices[0];
    if (reason === 'model') device.modelId = 'MISSING';
    if (reason === 'class') resources.models.find(row => row.id === device.modelId)!.deviceClass = 'HF;VUHF' as 'HF';
    if (reason === 'station') device.stationId = 'MISSING';
    if (reason === 'coordinate') resources.stations.find(row => row.id === device.stationId)!.coordinate = [181, 37];
    const result = gisDevicePoints(resources); expect(result.missingCount).toBeGreaterThan(0);
    expect(result.points.some(row => row.id === device.id)).toBe(false);
  });
  it('站点条件、设备类别、透明度和状态求交集；统计的是设备，排序不修改输入', () => {
    const rows = gisDevicePoints(initialResources()).points, settings = defaultGisDeviceSettings(), before = JSON.stringify(rows);
    settings.VUHF.visible = false; const visible = visibleGisDevices(rows, ['ND-0001'], settings, 'ALL');
    expect(visible.length).toBeGreaterThan(0); expect(visible.every(row => row.stationId === 'ND-0001' && row.deviceClass === 'HF')).toBe(true);
    expect(gisDeviceSummary(visible).HF).toBe(visible.length); settings.HF.opacity = 0;
    expect(visibleGisDevices(rows, ['ND-0001'], settings, 'ALL')).toEqual([]);
    const sorted = sortGisDevices(rows); expect(sorted[0].status).toBe('FAULT'); expect(JSON.stringify(rows)).toBe(before);
  });
});

// 同一资源上下文中的频点筛选只改变显示集合，不提交资源或业务结果。
describe('GIS 设备频率显示', () => {
  const ids = (s: ReturnType<typeof setup>) => s.display.points.value.map(row => row.id);
  function apply(s: ReturnType<typeof setup>, patch: Partial<DeviceFrequencyInput>) {
    s.display.frequencyActions.value.update({ ...emptyDeviceFrequencyInput(), ...patch });
    s.display.frequencyActions.value.apply();
  }
  it('默认保留全部点位，型号交集含端点，设备空频点不从型号补齐', () => {
    const s = setup(), before = JSON.stringify(s.state.resources), version = s.version();
    s.display.frequencyActions.value.update({ mode: 'MODEL', presence: 'ALL', min: '30000', max: '30000' });
    expect(ids(s)).toHaveLength(414); expect(s.version()).toBe(version); expect(s.display.frequencyPending.value).toBe(true);
    s.display.frequencyActions.value.apply();
    const models = new Map(s.state.resources.models.map(row => [row.id, row]));
    expect(ids(s)).toEqual(s.state.resources.devices.filter(row => {
      const model = models.get(row.modelId)!; return model.freqMinKhz <= 30000 && model.freqMaxKhz >= 30000;
    }).map(row => row.id));
    expect(ids(s)).toContain('DV-0001');
    apply(s, { mode: 'DEVICE', min: '30000', max: '30000' }); expect(ids(s)).toEqual([]);
    expect(JSON.stringify(s.state.resources)).toBe(before);
  });
  it('工作频点范围包含边界，空值与零区分，有值/为空使用相同成员口径', () => {
    const s = setup(); [0, 6000, 9000].forEach((value, i) => s.state.resources.devices[i].workFreqKhz = value);
    apply(s, { mode: 'DEVICE', min: '6000', max: '9000' });
    expect(ids(s)).toEqual(s.state.resources.devices.slice(1, 3).map(row => row.id));
    apply(s, { mode: 'DEVICE', presence: 'PRESENT' }); expect(ids(s)).toHaveLength(3);
    apply(s, { mode: 'DEVICE', min: '0', max: '0' }); expect(ids(s)).toEqual(['DV-0001']);
    apply(s, { mode: 'DEVICE', presence: 'MISSING', min: 'bad', max: '-1' });
    expect(ids(s)).toHaveLength(411); expect(ids(s)).not.toContain('DV-0001'); expect(s.display.frequencyError.value).toBe('');
  });
  it.each([['-1', ''], ['Infinity', ''], ['9000', '6000']])('非法范围 %s / %s 保留已应用条件、点位和帧版本', (min, max) => {
    const s = setup(); apply(s, { mode: 'MODEL', min: '6000', max: '6000' });
    const previous = ids(s), applied = { ...s.display.frequency.value }, version = s.version();
    s.display.frequencyActions.value.update({ mode: 'DEVICE', presence: 'ALL', min, max });
    s.display.frequencyActions.value.apply();
    expect(s.display.frequencyError.value).not.toBe(''); expect(s.display.frequencyPending.value).toBe(true);
    expect(s.display.frequency.value).toEqual(applied); expect(ids(s)).toEqual(previous); expect(s.version()).toBe(version);
  });
  it('与节点/目录/类型/状态交集；清除频率不恢复其他条件或清空选择', () => {
    const s = setup(); s.state.deviceIds = ['DV-0001', 'DV-0002']; s.state.selectedDeviceId = 'DV-0001';
    s.display.configure.value('VUHF', { visible: false, opacity: 0.3 }); s.display.filter.value('FAULT');
    const before = ids(s); apply(s, { mode: 'DEVICE', presence: 'PRESENT' }); expect(ids(s)).toEqual([]);
    s.display.frequencyActions.value.clear();
    expect(ids(s)).toEqual(before); expect(s.state.deviceIds).toEqual(['DV-0001', 'DV-0002']);
    expect(s.display.state.value).toBe('FAULT'); expect(s.state.selectedDeviceId).toBe('DV-0001');
    expect(s.display.settings.value.VUHF).toEqual({ visible: false, opacity: 0.3 });
  });
  it('聚合成员和点位同步裁剪，旧帧及被隐藏成员不能继续选择，空清单关闭', () => {
    const s = setup(), members = s.state.resources.devices.slice(0, 3);
    members.forEach((row, i) => row.workFreqKhz = i === 0 ? null : 6000);
    const version = s.version(); expect(s.display.open(members.map(row => row.id), version)).toBe(true);
    const captured = s.display.capture(members[0].id, version, s.display.clusterRevision.value)!;
    apply(s, { mode: 'DEVICE', min: '6000', max: '6000' });
    expect(ids(s)).toEqual(members.slice(1).map(row => row.id)); expect(s.display.members.value.map(row => row.id)).toEqual(ids(s));
    expect(captured()).toBeUndefined(); expect(s.display.open(members.map(row => row.id), version)).toBe(false);
    apply(s, { mode: 'DEVICE', min: '9000' }); expect(s.display.members.value).toEqual([]);
    expect(s.display.capture(members[1].id, s.version())).toBeUndefined();
  });
  it('资源频点变化重筛但不自动显出已选设备，只有明确定位解除限制并保留输入', () => {
    const s = setup(); s.state.selectedDeviceId = 'DV-0001'; s.state.resources.devices[0].workFreqKhz = 6000;
    apply(s, { mode: 'DEVICE', min: '6000', max: '6000' });
    s.display.reveal('DV-0001'); expect(s.display.frequency.value.mode).toBe('DEVICE'); expect(s.display.frequencyNotice.value).toBe('');
    s.state.resources.devices[0].workFreqKhz = 9000;
    expect(ids(s)).toEqual([]); expect(s.display.hiddenSelection.value).toBe(true);
    s.display.frequencyActions.value.update({ ...s.display.frequencyInput.value, min: 'bad' }); s.display.frequencyActions.value.apply();
    const input = { ...s.display.frequencyInput.value }, error = s.display.frequencyError.value;
    s.display.reveal('UNKNOWN'); expect(s.display.frequency.value.mode).toBe('DEVICE');
    s.display.reveal('DV-0001');
    expect(s.display.frequency.value.mode).toBe('ALL'); expect(s.display.frequencyInput.value).toEqual(input);
    expect(s.display.frequencyError.value).toBe(error); expect(s.display.frequencyPending.value).toBe(true);
    expect(s.display.frequencyNotice.value).toContain('解除频率限制'); expect(s.display.hiddenSelection.value).toBe(false);
    s.display.frequencyActions.value.clear(); expect(s.display.frequencyNotice.value).toBe(''); expect(s.display.frequencyError.value).toBe('');
  });
  it.each(['mode', 'permission', 'identity', 'source'])('%s 切换拒绝旧频率事件，模式/权限往返保留，换身份重置', kind => {
    const s = setup(); apply(s, { mode: 'DEVICE', presence: 'PRESENT' });
    s.display.frequencyActions.value.update({ ...s.display.frequencyInput.value, min: '123' });
    const stale = s.display.frequencyActions.value;
    if (kind === 'mode') { s.state.enabled = false; stale.clear(); s.state.enabled = true; }
    if (kind === 'permission') { s.state.readable = false; stale.apply(); s.state.readable = true; }
    if (kind === 'identity') s.state.generation++;
    if (kind === 'source') s.state.sourceKey = 'next';
    stale.clear(); stale.update(emptyDeviceFrequencyInput()); stale.apply();
    if (kind === 'identity') {
      expect(s.display.frequency.value.mode).toBe('ALL'); expect(s.display.frequencyInput.value).toEqual(emptyDeviceFrequencyInput());
    } else {
      expect(s.display.frequency.value.mode).toBe('DEVICE'); expect(s.display.frequency.value.minKhz).toBeNull();
      expect(s.display.frequencyInput.value.min).toBe('123');
    }
  });
});

describe('GIS 目录设备匹配范围', () => {
  it('可选范围不传保持全量，空范围清空点位，与类型、状态和站点条件求交集', () => {
    const s = setup(), before = JSON.stringify(s.state.resources);
    expect(s.display.points.value).toHaveLength(414);
    s.state.deviceIds = ['DV-0001', 'DV-0002']; expect(s.display.points.value.map(row => row.id)).toEqual(['DV-0001', 'DV-0002']);
    s.display.filter.value('FAULT'); expect(s.display.points.value).toEqual([]);
    s.display.filter.value('ALL'); s.display.configure.value('HF', { visible: false }); expect(s.display.points.value).toEqual([]);
    s.display.configure.value('HF', { visible: true }); s.state.stationIds = ['ND-0003']; expect(s.display.points.value).toEqual([]);
    s.state.stationIds = ['ND-0001']; expect(s.display.points.value).toHaveLength(2);
    s.state.deviceIds = []; expect(s.display.points.value).toEqual([]);
    s.state.deviceIds = undefined; expect(s.display.points.value.length).toBeGreaterThan(2);
    expect(JSON.stringify(s.state.resources)).toBe(before);
  });
  it('范围缩小裁剪聚合成员并拒绝陈旧帧，不因保留设备详情自动恢复范围', () => {
    const s = setup(), ids = ['DV-0001', 'DV-0002', 'DV-0003'], version = s.version();
    s.display.open(ids, version); const capture = s.display.capture(ids[0], version, s.display.clusterRevision.value)!;
    s.state.selectedDeviceId = ids[0]; s.state.deviceIds = ids.slice(1);
    expect(s.display.members.value.map(row => row.id)).toEqual(ids.slice(1)); expect(capture()).toBeUndefined();
    expect(s.display.capture(ids[1], version)).toBeUndefined(); expect(s.display.hiddenSelection.value).toBe(true);
    s.state.deviceIds = []; expect(s.display.members.value).toEqual([]); expect(s.state.selectedDeviceId).toBe(ids[0]);
  });
});

describe('GIS 页内设备显示与选择守卫', () => {
  it('默认类型各自开启，显示调整保留资源与选中对象；新实例独立', () => {
    const s = setup(), before = JSON.stringify(s.state.resources); s.state.selectedDeviceId = 'DV-0001';
    s.display.configure.value('HF', { visible: false, opacity: 0.4 });
    expect(s.display.hiddenSelection.value).toBe(true); expect(s.display.settings.value.VUHF).toEqual({ visible: true, opacity: 1 });
    expect(JSON.stringify(s.state.resources)).toBe(before); expect(setup().display.settings.value.HF).toEqual({ visible: true, opacity: 1 });
  });
  it.each([NaN, Infinity, -1, 1.1])('拒绝非法透明度 %s', opacity => {
    const s = setup(); s.display.configure.value('HF', { opacity }); expect(s.display.settings.value.HF.opacity).toBe(1);
  });
  it('未知类型、状态和非法布尔值不污染设置', () => {
    const s = setup(); s.display.configure.value('ALL' as 'HF', { visible: false });
    s.display.configure.value('HF', { visible: 'false' as unknown as boolean }); s.display.filter.value('OTHER' as 'ALL');
    expect(s.display.settings.value).toEqual(defaultGisDeviceSettings()); expect(s.display.state.value).toBe('ALL');
  });
  it('聚合只接收本帧有效设备；过滤后裁剪成员，空清单关闭', () => {
    const s = setup(), ids = s.display.points.value.slice(0, 3).map(row => row.id);
    expect(s.display.open([ids[0], 'UNKNOWN'], s.version())).toBe(false);
    expect(s.display.open(ids, s.version())).toBe(true); expect(s.display.members.value).toHaveLength(3);
    s.state.resources.devices = s.state.resources.devices.filter(row => row.id !== ids[0]);
    expect(s.display.members.value.map(row => row.id)).not.toContain(ids[0]);
    s.display.configure.value('HF', { visible: false }); expect(s.display.members.value).toEqual([]);
    expect(s.display.open(ids, s.version())).toBe(false);
  });
  it('模式、权限和来源切换清理清单，偏好保留；旧回调失效', () => {
    const s = setup(), ids = s.display.points.value.slice(0, 2).map(row => row.id);
    s.display.configure.value('HF', { opacity: 0.3 }); s.display.open(ids, s.version());
    const change = s.display.configure.value, capture = s.display.capture(ids[0], s.version())!;
    s.state.enabled = false; expect(s.display.frame.value).toBeUndefined(); expect(s.display.members.value).toEqual([]);
    s.state.enabled = true; expect(capture()).toBeUndefined(); change('HF', { opacity: 0.9 });
    expect(s.display.settings.value.HF.opacity).toBe(0.3);
    s.state.readable = false; expect(s.display.frame.value).toBeUndefined(); s.state.readable = true;
    const current = s.display.capture(ids[0], s.version())!; s.state.sourceKey = 'new'; expect(current()).toBeUndefined();
    s.state.generation++; expect(s.display.settings.value).toEqual(defaultGisDeviceSettings());
  });
  it('确认等待期重新检查成员及归属，应用其他草稿字段仍可选择有效设备', () => {
    const s = setup(), id = s.display.points.value[0].id, capture = s.display.capture(id, s.version())!;
    s.state.resources.devices[1].antennaHeightM = 20; expect(capture()?.id).toBe(id);
    s.state.resources = structuredClone(initialResources()); expect(capture()?.id).toBe(id);
    s.state.resources.devices[0].stationId = 'ND-0003'; expect(capture()).toBeUndefined();
  });
  it('过期帧、已收起或已替换清单和隐藏成员不能接收选择', () => {
    const s = setup(), ids = s.display.points.value.slice(0, 3).map(row => row.id), oldVersion = s.version();
    s.display.open(ids, oldVersion); const capture = s.display.capture(ids[0], oldVersion, s.display.clusterRevision.value)!;
    s.display.close(); expect(capture()).toBeUndefined();
    s.display.configure.value('HF', { opacity: 0.5 }); expect(s.display.capture(ids[0], oldVersion)).toBeUndefined();
    const current = s.display.capture(ids[0], s.version())!; s.display.filter.value('FAULT'); expect(current()).toBeUndefined();
  });
  it('显式定位只解除目标的阻挡条件，不开启另一类型；普通选中不改显示版本', () => {
    const s = setup(); const version = s.version(); s.state.selectedDeviceId = 'DV-0001'; expect(s.version()).toBe(version);
    s.display.configure.value('HF', { visible: false, opacity: 0 }); s.display.configure.value('VUHF', { visible: false, opacity: 0.4 });
    s.display.filter.value('FAULT'); s.display.reveal('UNKNOWN'); expect(s.display.state.value).toBe('FAULT');
    s.display.reveal('DV-0001'); expect(s.display.settings.value.HF).toEqual({ visible: true, opacity: 1 });
    expect(s.display.settings.value.VUHF).toEqual({ visible: false, opacity: 0.4 }); expect(s.display.state.value).toBe('ALL');
  });
});

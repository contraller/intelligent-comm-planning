import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature';
import { initialResources } from '../src/mocks/resource-presets';
import { defaultGisDeviceSettings, gisDevicePoints, type GisDeviceMapFrame } from '../src/maps/gis-device-display';
import { gisHoverPlacement, gisHoverSummary } from '../src/maps/gis-hover';
import type { ResourceMapFrame, ResourceMapPoint, ResourceMapCluster } from '../src/types/resource-read';

function fixture() {
  const raw = initialResources();
  const devices: GisDeviceMapFrame = { points: gisDevicePoints(raw).points.slice(0, 3), settings: defaultGisDeviceSettings(), selectedDeviceId: '', version: 7 };
  return { context: { key: 'resource/r1', source: '已保存资源', models: raw.models }, stations: raw.stations, devices,
    deviceTarget: { ids: [devices.points[0].id], version: 7 } };
}
const deviceFeature = () => new Feature({ kind: 'gis-device-cluster' });
const values = (summary: ReturnType<typeof gisHoverSummary>) => Object.fromEntries(summary!.rows.map(row => [row.label, row.value]));

describe('GIS 悬浮摘要的数据边界', () => {
  it('单设备使用自身身份、型号、站点和状态，不采用同站状态', () => {
    const input = fixture(), row = input.devices.points[0];
    row.status = 'OFFLINE'; row.alert = true; row.offShelf = true;
    input.stations.find(s => s.id === row.stationId)!.status = 'NORMAL';
    const before = JSON.stringify(input), summary = gisHoverSummary(deviceFeature(), input)!;
    expect(summary.kind).toBe('device'); expect(summary.title).toBe(row.id);
    expect(values(summary)).toMatchObject({ 类别: row.deviceClass, 运行状态: '离线 · 告警', 在架状态: '已下架' });
    expect(values(summary).型号).toContain(input.context.models.find(m => m.id === row.modelId)!.name);
    expect(values(summary).所属站点).toContain(row.stationId); expect(JSON.stringify(input)).toBe(before);
  });
  it('缺失型号名称与未知状态明确提示，来源只使用当前资源上下文', () => {
    const input = fixture(), row = input.devices.points[0]; input.context.models = [];
    row.status = null; row.alert = null;
    const summary = gisHoverSummary(deviceFeature(), input)!;
    expect(values(summary).型号).toContain('名称未提供');
    expect(values(summary).运行状态).toBe('状态未提供 · 告警未提供');
    expect(summary.source).toBe('已保存资源 · 当前地图状态');
    expect(values(summary)).not.toHaveProperty('在架状态');
  });
  it('多设备聚合只展示真实数量、类型和状态，不拿首个成员冒充对象', () => {
    const input = fixture(), rows = input.devices.points;
    rows[0].deviceClass = 'HF'; rows[0].status = 'FAULT'; rows[0].alert = true;
    rows[1].deviceClass = 'VUHF'; rows[1].status = 'OFFLINE'; rows[1].alert = false;
    rows[2].deviceClass = 'HF'; rows[2].status = null; rows[2].alert = null;
    input.deviceTarget.ids = [...rows.map(p => p.id), rows[0].id];
    const summary = gisHoverSummary(deviceFeature(), input)!;
    expect(summary.kind).toBe('devices'); expect(summary.title).toBe('设备聚合（3 台）');
    expect(values(summary)).toEqual({ 类别分布: 'HF 2 台 / VUHF 1 台', 状态摘要: '正常 0 / 故障 1 / 离线 1 台', 告警数量: '1 台', 未提供: '状态 1 台 / 告警 1 台' });
    expect(values(summary)).not.toHaveProperty('型号');
  });
  it.each(['version', 'missing', 'hidden', 'transparent', 'empty'] as const)('%s 设备目标不能显示过期或隐藏摘要', reason => {
    const input = fixture(), row = input.devices.points[0];
    if (reason === 'version') input.deviceTarget.version++;
    if (reason === 'missing') input.devices.points = [];
    if (reason === 'hidden') input.devices.settings[row.deviceClass].visible = false;
    if (reason === 'transparent') input.devices.settings[row.deviceClass].opacity = 0;
    if (reason === 'empty') input.deviceTarget.ids = [];
    expect(gisHoverSummary(deviceFeature(), input)).toBeNull();
  });
  it('站点只统计当前可见设备，聚合点明确为站点数量', () => {
    const input = fixture(), station = input.stations[0];
    input.devices.points.forEach(p => { p.stationId = station.id; p.deviceClass = 'HF'; });
    input.devices.points[1].deviceClass = 'VUHF'; input.devices.settings.VUHF.visible = false;
    const members = [new Feature({ station })], feature = new Feature({ features: members });
    expect(values(gisHoverSummary(feature, input)).当前显示设备).toBe('2 台（HF 2 / VUHF 0）');
    members.push(new Feature({ station: input.stations[1] }));
    const summary = gisHoverSummary(feature, input)!;
    expect(summary.kind).toBe('stations'); expect(summary.title).toBe('站点聚合（2 个）'); expect(summary.rows).toEqual([]);
    expect(gisHoverSummary(new Feature({ features: [new Feature({ station: { ...station } })] }), input)).toBeNull();
  });
  it('轻地图站点复用当前帧，聚合数量沿用服务值；干扰源与旧帧同名对象均排除', () => {
    const input = fixture(), point: ResourceMapPoint = { kind: 'node', id: input.stations[0].id, name: '测试站点', coordinate: [114, 37], status: null, alert: null, active: null };
    const cluster: ResourceMapCluster = { kind: 'node', id: 'server-cluster', coordinate: [114, 37], count: 205, bounds: [113, 36, 115, 38], expansionZoom: 12 };
    const resources: ResourceMapFrame = { revision: 'r1', bbox: [113, 36, 115, 38], zoom: 8, points: [point], clusters: [cluster], totalNodes: 206, totalInterferences: 0 };
    const current = { ...input, resources };
    expect(values(gisHoverSummary(new Feature({ kind: 'resource-read-point', object: point }), { ...current, devices: undefined })).运行状态).toBe('状态未提供 · 告警未提供');
    expect(gisHoverSummary(new Feature({ kind: 'resource-read-cluster', cluster }), current)!.title).toBe('站点聚合（205 个）');
    expect(gisHoverSummary(new Feature({ kind: 'resource-read-point', object: { ...point } }), current)).toBeNull();
    point.kind = 'interference'; expect(gisHoverSummary(new Feature({ kind: 'resource-read-point', object: point }), current)).toBeNull();
    expect(gisHoverSummary(new Feature({ kind: 'planning-link' }), current)).toBeNull();
  });
  it.each([[960, 640], [540, 280], [180, 100]])('摘要在 %s 地图边缘仍保留容器内边距', (width, height) => {
    for (const pixel of [[0, 0], [width - 1, height - 1], [width / 2, height / 2]]) {
      const pos = gisHoverPlacement(pixel, [width, height]);
      expect(pos.left).toBeGreaterThanOrEqual(8); expect(pos.top).toBeGreaterThanOrEqual(8);
      expect(pos.left + pos.width).toBeLessThanOrEqual(width - 8); expect(pos.top + pos.maxHeight).toBeLessThanOrEqual(height - 8);
    }
  });
});

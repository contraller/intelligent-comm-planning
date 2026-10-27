import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import Point from 'ol/geom/Point';
import Circle from 'ol/style/Circle';
import type { Style } from 'ol/style';
import PlanningApiResultPanel from '../src/components/PlanningApiResultPanel.vue';
import { readPlanningResult } from '../src/services/planning-api-validation';
import { deploymentDisplayRows } from '../src/services/planning-deployment-display';
import { planningApiLayer } from '../src/maps/planning-api-layers';
import { frozenCoverageDeviceLayer } from '../src/maps/frozen-coverage-layers';
import { projectCoordinate } from '../src/maps/layers';
import { resultDto } from './fixtures/planning-api';
import { coverageV5Case } from './helpers/frozen-coverage';
import { clientTemplate, renderer, node, find, all, textOf, type HostNode } from './helpers/vue-client';

vi.mock('../src/components/AppTable.vue', () => ({ default: { props: ['rows', 'columns', 'selected'], emits: ['select'],
  setup(props: any, { emit, slots }: any) { return () => h('table-probe', { ...props, select: (row: unknown) => emit('select', row) },
    (props.rows ?? []).map((row: any) => h('row-probe', { id: row.id }, [slots.stationName?.({ row }), slots.stationId?.({ row }), slots.actions?.({ row })]))); } } }));
vi.mock('../src/components/AppDrawer.vue', () => ({ default: { props: ['visible'], setup: (props: any, { slots }: any) => () => props.visible ? h('aside', {}, slots.default?.()) : null } }));
await clientTemplate(PlanningApiResultPanel, 'src/components/PlanningApiResultPanel.vue', 'deployment-review-render.ts');
let app: App<HostNode> | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.restoreAllMocks(); });

describe('修改意见：新增部署与冻结位置', () => {
  it('历史配置从同一快照节点回读缺失位置，并优先保留明确规划位置', () => {
    const result = readPlanningResult(resultDto()), before = JSON.stringify(result);
    expect(deploymentDisplayRows(result).map(row => row.plannedCoordinate)).toEqual([[114, 37], [115.1, 38.1]]);
    expect(deploymentDisplayRows(result)[0]).toMatchObject({ stationName: '节点一', deviceLabels: 'E1 · 短波设备' });
    expect(JSON.stringify(result)).toBe(before);
  });
  it('显式新增标志经过HTTP边界保留；错误标志拒收且历史缺省保持缺省', () => {
    const dto = resultDto(); Object.assign(dto.nodes[1]!, { isNewDeployment: true });
    expect(readPlanningResult(dto).nodes[1]!.isNewDeployment).toBe(true);
    Object.assign(dto.nodes[1]!, { isNewDeployment: 'true' });
    expect(() => readPlanningResult(dto)).toThrow('isNewDeployment');
    expect(readPlanningResult(resultDto()).nodes[1]).not.toHaveProperty('isNewDeployment');
  });
  it('新增节点常态为橙色，选中时沿用定位高亮，不改动冻结结果', () => {
    const result = readPlanningResult(resultDto()); result.nodes[1]!.isNewDeployment = true;
    const before = JSON.stringify(result), layer = planningApiLayer(result), features = layer.getSource()!.getFeatures();
    const added = features.find(feature => feature.get('kind') === 'api-planning-node' && feature.get('objectId') === 'N2')!;
    expect(((added.getStyle() as Style).getImage()! as Circle).getFill()!.getColor()).toBe('#ff9f43');
    const selected = planningApiLayer(result, 'N2').getSource()!.getFeatures().find(feature => feature.get('objectId') === 'N2')!;
    expect(((selected.getStyle() as Style).getImage()! as Circle).getFill()!.getColor()).toBe('#ffe08a');
    expect(JSON.stringify(result)).toBe(before);
  });
  it('实际结果组件显示新增名称、设备、定位操作；完整配置读取冻结坐标；没有重复覆盖标签', async () => {
    const result = readPlanningResult(resultDto()); result.nodes[1]!.isNewDeployment = true;
    const focus = vi.fn(); app = renderer.createApp({ render: () => h(PlanningApiResultPanel, { result, historical: false, ownerKey: 'owner', radioCount: 1, onFocus: focus }) });
    app.provide(ssrContextKey, {}); const root = node('root'); app.mount(root); await nextTick();
    const tables = all(root, element => element.tag === 'table-probe');
    const addedTable = tables.find(table => (table.props.columns as {field:string}[]).some(column => column.field === 'deviceLabels'))!;
    expect((addedTable.props.rows as any[]).map(row => [row.stationName, row.deviceLabels])).toEqual([['节点二', 'E2 · 短波设备']]);
    const locate = find(addedTable, element => element.tag === 'button' && textOf(element) === '定位')!;
    await (locate.props.onClick as () => unknown)(); await nextTick();
    expect(focus).toHaveBeenCalledWith('owner', expect.objectContaining({ stationId: 'N2', stationIds: ['N2'] }));
    expect(all(root, element => element.tag === 'button').map(textOf)).not.toContain('覆盖与场强');
    const full = find(root, element => element.tag === 'button' && textOf(element) === '查看完整配置')!;
    await (full.props.onClick as () => unknown)(); await nextTick();
    const drawer = find(root, element => element.tag === 'aside')!;
    const deployment = all(drawer, element => element.tag === 'table-probe').find(table => (table.props.rows as any[]).some(row => row.stationId === 'N1' && row.deviceIds))!;
    expect((deployment.props.rows as any[]).map(row => row.plannedCoordinate)).toEqual([[114, 37], [115.1, 38.1]]);
  });
});

describe('覆盖设备高亮的版本边界', () => {
  it('独立高亮层标明设备与节点，不改变原覆盖格面或分级颜色', () => {
    const fixture = coverageV5Case(), before = JSON.stringify(fixture.result);
    const layer = frozenCoverageDeviceLayer({ anchor: fixture.anchor, result: fixture.result, deviceId: 'D1' }, fixture.query.snapshotId, fixture.query.planId);
    const marker = layer.getSource()!.getFeatures()[0]!;
    expect(layer.getZIndex()).toBe(75);
    expect(marker.get('deviceId')).toBe('D1'); expect(marker.get('objectId')).toBe('N1');
    expect((marker.getGeometry() as Point).getCoordinates()).toEqual(projectCoordinate([fixture.result.devices[0]!.lon, fixture.result.devices[0]!.lat]));
    expect((marker.getStyle() as Style).getText()!.getText()).toContain('D1');
    expect(JSON.stringify(fixture.result)).toBe(before);
  });
  it.each(['plan', 'snapshot', 'device', 'status', 'engine'] as const)('错%s不能高亮另一方案设备', change => {
    const fixture = coverageV5Case(), overlay = { anchor: fixture.anchor, result: fixture.result, deviceId: 'D1' };
    if (change === 'device') overlay.deviceId = 'D-other';
    if (change === 'status') fixture.result.devices[0]!.status = 'UNAVAILABLE';
    if (change === 'engine') fixture.result.provenance.engine_version = 'V01-3';
    const layer = frozenCoverageDeviceLayer(overlay, change === 'snapshot' ? 'SNP-other' : fixture.query.snapshotId, change === 'plan' ? 'P-other' : fixture.query.planId);
    expect(layer.getSource()!.getFeatures()).toHaveLength(0);
  });
});

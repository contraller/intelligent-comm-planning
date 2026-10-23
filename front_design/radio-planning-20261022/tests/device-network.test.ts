import { describe, expect, it } from 'vitest';
import { createMockService } from '../src/services/mock';
import { createDeviceNetworkContext, selectDeviceNetwork, selectDeviceRole } from '../src/services/device-network';
import historical from '../src/mocks/planning.json';
import catalog from '../src/mocks/device-network.json';
import { TestStorage } from './helpers/storage';
import { monitoringFixture } from './helpers/monitoring';

async function fixture() {
  const storage = new TestStorage(), service = createMockService(() => storage), data = await service.loadPreview();
  return { storage, service, data, context: (dirty = false) => createDeviceNetworkContext(data.situation, data.resources, data.resourceMeta, dirty) };
}
// 角色是网络资料扩展，不能从同站设备或节点角色补配。
describe('设备角色与网络归属', () => {
  it('不同设备、同站缺失及读取副本不影响基线', async () => {
    const s = await fixture(), before = [...s.storage.entries];
    expect(selectDeviceRole(s.context(), 'DV-0001').role?.role).toBe('教学角色 A');
    expect(selectDeviceRole(s.context(), 'DV-0027').role?.role).toBe('教学角色 B');
    expect(selectDeviceRole(s.context(), 'DV-0002').role).toBeNull();
    s.data.situation.deviceNetwork!.roles!.items[0].role = '服务的新角色文字';
    expect(selectDeviceRole(s.context(), 'DV-0001').role?.role).toBe('服务的新角色文字');
    expect((await s.service.loadPreview()).situation.deviceNetwork!.roles!.items[0].role).toBe('教学角色 A');
    expect([...s.storage.entries]).toEqual(before);
  });
  it.each(['missing', 'null', 'empty'])('%s 目录保留缺失语义及原业务', async mode => {
    const s = await fixture(), c = s.data.situation.deviceNetwork!;
    if (mode === 'missing') delete c.roles; else if (mode === 'null') c.roles = null; else c.roles!.items = [];
    expect(s.context().state).toBe('ready'); expect(selectDeviceRole(s.context(), 'DV-0001').role).toBeNull();
    expect(selectDeviceNetwork(s.context(), 'DV-0001').services.length).toBeGreaterThan(0);
    expect(s.context().roleData?.state).toBe(mode === 'empty' ? 'ready' : 'missing');
  });
  it.each(['snapshot', 'unknown', 'duplicate', 'role', 'source', 'description', 'sparse'])('角色 %s 损坏单独隔离', async mode => {
    const s = await fixture(), c = s.data.situation.deviceNetwork!.roles!;
    if (mode === 'snapshot') c.snapshotId = 'OTHER';
    if (mode === 'unknown') c.items[0].deviceId = 'UNKNOWN';
    if (mode === 'duplicate') c.items.push(c.items[0]);
    if (mode === 'role') c.items[0].role = '';
    if (mode === 'source') c.items[0].source = '';
    if (mode === 'description') c.items[0].description = 12 as never;
    if (mode === 'sparse') c.items = new Array(1);
    expect(s.context().state).toBe('ready'); expect(s.context().roleData?.state).toBe('invalid');
    expect(selectDeviceRole(s.context(), 'DV-0001').role).toBeNull(); expect(selectDeviceNetwork(s.context(), 'DV-0001').services.length).toBeGreaterThan(0);
  });
  it('脏态、保存变更与错网络均不能继续展示角色', async () => {
    const s = await fixture(); expect(selectDeviceRole(s.context(true), 'DV-0001').role).toBeNull();
    s.data.resourceMeta.changedDeviceIds.push('DV-0001'); expect(selectDeviceRole(s.context(), 'DV-0001').role).toBeNull();
    s.data.resourceMeta.changedDeviceIds = []; s.data.situation.snapshotId = 'OTHER';
    expect(selectDeviceRole(s.context(), 'DV-0001').role).toBeNull();
  });
});

describe('设备网络关联契约', () => {
  it('新快照独立提供七条链路、两项业务和四条主备路径，原六条与旧方案保留', async () => {
    const s = await fixture(), context = s.context();
    expect(context.state).toBe('ready'); expect(context.snapshotId).toBe('NET-DEMO-03');
    expect(context.links).toHaveLength(7); expect(context.services).toHaveLength(2); expect(context.routes).toHaveLength(4);
    expect(context.links.slice(0, 6).map(({ isBackbone: _mark, ...link }) => link)).toEqual(historical.plans[0].links);
    expect(context.links.at(-1)).toMatchObject({ id: 'PL-007', a: 'ND-0003', b: 'ND-0005', deviceA: 'DV-0027', deviceB: 'DV-0047', backup: true, isBackbone: false });
    expect(context.routes.map(row => row.linkIds)).toEqual([
      ['PL-002', 'PL-003'], ['PL-001', 'PL-007'], ['PL-002', 'PL-003', 'PL-004'], ['PL-001', 'PL-007', 'PL-004'],
    ]);
    expect(s.data.planning.plans).toEqual(historical.plans); expect(s.storage.writes).toBe(0);
  });
  it('按设备实例关联，区分主路径参与、备用保障、同站其他设备和无业务链路', async () => {
    const s = await fixture(), context = s.context(), before = JSON.stringify(context);
    const source = selectDeviceNetwork(context, 'DV-0001');
    expect(source.links.map(row => row.id)).toEqual(['PL-001', 'PL-002']); expect(source.services).toHaveLength(2);
    expect(selectDeviceNetwork(context, 'DV-0002')).toEqual({ links: [], services: [] });
    expect(selectDeviceNetwork(context, 'UNKNOWN')).toEqual({ links: [], services: [] });
    expect(selectDeviceNetwork(context, 'DV-0037').services.map(row => row.routes.map(route => route.participates))).toEqual([[true, false], [true, false]]);
    expect(selectDeviceNetwork(context, 'DV-0027').services.map(row => row.routes.map(route => route.participates))).toEqual([[false, true], [false, true]]);
    expect(selectDeviceNetwork(context, 'DV-0067').links.map(row => row.id)).toEqual(['PL-005']);
    expect(selectDeviceNetwork(context, 'DV-0067').services).toEqual([]);
    expect(JSON.stringify(context)).toBe(before); expect(s.storage.writes).toBe(0);
  });
  it('路径可反向经过已声明链路，不按链路的端点书写顺序推算路线', async () => {
    const s = await fixture(), link = s.data.situation.links.find(row => row.id === 'PL-007')!;
    [link.a, link.b] = [link.b, link.a]; [link.deviceA, link.deviceB] = [link.deviceB, link.deviceA];
    expect(s.context().state).toBe('ready');
    expect(selectDeviceNetwork(s.context(), 'DV-0027').services).toHaveLength(2);
  });
  it.each(['version', 'snapshot', 'duplicate-link', 'duplicate-service', 'duplicate-route', 'unknown-service', 'unknown-link',
    'disconnected', 'source-device', 'link-device', 'no-primary', 'duplicate-primary', 'missing-array', 'service-name', 'link-state', 'link-frequency'])(
    '不完整关联 %s 明确不可用，不套用旧网络', async kind => {
      const s = await fixture(), data = s.data.situation.deviceNetwork!;
      if (kind === 'version') data.version = 'unknown';
      if (kind === 'snapshot') data.snapshotId = 'NET-DEMO-01';
      if (kind === 'duplicate-link') s.data.situation.links.push(s.data.situation.links[0]);
      if (kind === 'duplicate-service') data.services.push(data.services[0]);
      if (kind === 'duplicate-route') data.routes.push(data.routes[0]);
      if (kind === 'unknown-service') data.routes[0].demandId = 'UNKNOWN';
      if (kind === 'unknown-link') data.routes[0].linkIds[0] = 'CL-DEMO-01';
      if (kind === 'disconnected') data.routes[0].nodeIds[1] = 'ND-0003';
      if (kind === 'source-device') data.services[0].sourceDeviceId = 'DV-0002';
      if (kind === 'link-device') s.data.situation.links[0].deviceA = 'DV-0002';
      if (kind === 'no-primary') data.routes = data.routes.filter(row => row.id !== 'GIS-VOICE-PRIMARY');
      if (kind === 'duplicate-primary') data.routes[1].routeType = 'PRIMARY';
      if (kind === 'missing-array') data.routes = undefined as never;
      if (kind === 'service-name') data.services[0].name = '';
      if (kind === 'link-state') s.data.situation.links[0].state = 'UNKNOWN' as never;
      if (kind === 'link-frequency') s.data.situation.links[0].frequencyKhz = NaN;
      const context = s.context(); expect(context.state).toBe('invalid');
      expect(selectDeviceNetwork(context, 'DV-0001')).toEqual({ links: [], services: [] }); expect(s.storage.writes).toBe(0);
    },
  );
  it('缺目录与合法空业务分别表达，无备用路径时不补造一条', async () => {
    const s = await fixture(), data = s.data.situation.deviceNetwork!;
    data.routes = data.routes.filter(row => row.routeType === 'PRIMARY');
    expect(s.context().state).toBe('ready'); expect(selectDeviceNetwork(s.context(), 'DV-0001').services[0].routes).toHaveLength(1);
    data.services = []; data.routes = [];
    expect(s.context().state).toBe('ready'); expect(selectDeviceNetwork(s.context(), 'DV-0001').links).toHaveLength(2);
    delete s.data.situation.deviceNetwork;
    expect(s.context().state).toBe('missing'); expect(s.context().message).toContain('暂无');
  });
  it.each(['draft', 'station', 'device', 'interference'])('%s 变更暂停关联，恢复原条件后重新显示', async kind => {
    const s = await fixture();
    if (kind === 'station') s.data.resourceMeta.changedStationIds.push('ND-0001');
    if (kind === 'device') s.data.resourceMeta.changedDeviceIds.push('DV-0001');
    if (kind === 'interference') s.data.resourceMeta.interferenceVersion = 'changed';
    expect(s.context(kind === 'draft').state).toBe('stale');
    expect(selectDeviceNetwork(s.context(kind === 'draft'), 'DV-0001').links).toEqual([]);
    s.data.resourceMeta.changedStationIds = []; s.data.resourceMeta.changedDeviceIds = []; s.data.resourceMeta.interferenceVersion = 'initial';
    expect(s.context().state).toBe('ready'); expect(s.storage.writes).toBe(0);
  });
  it('实际保存后暂停，显式恢复演示资源才恢复关联；目录副本不影响后续读取', async () => {
    const s = await fixture();
    const saved = await s.service.commitResources({ baseRevision: s.data.resourceMeta.revision, stations: [], devices: [{ id: 'DV-0001', txPowerDbm: 40 }] });
    const changed = await s.service.loadPreview();
    expect(createDeviceNetworkContext(changed.situation, changed.resources, changed.resourceMeta).state).toBe('stale');
    const reset = await s.service.resetResources(saved.meta.revision);
    expect(createDeviceNetworkContext(reset.preview.situation, reset.resources, reset.meta).state).toBe('ready');
    reset.preview.situation.deviceNetwork!.routes[0].linkIds.push('WRONG');
    // 原目录完整保留；新增角色单独核对，不降低原业务路径校验。
    const { roles, ...base } = (await s.service.loadPreview()).situation.deviceNetwork!;
    expect(base).toEqual(catalog); expect(roles?.snapshotId).toBe(catalog.snapshotId);
    expect(roles?.items.map(row => row.deviceId)).toEqual(['DV-0001', 'DV-0027']);
  });
  it('已有确认方案及监控网络不增加备用链路或业务，不写回历史记录', async () => {
    const s = await monitoringFixture(), service = createMockService(() => s.storage), before = [...s.storage.entries], writes = s.storage.writes;
    const preview = await service.loadPreview(), { workspace } = await service.loadPlanningWorkspace();
    const plan = workspace.plans.find(row => row.id === s.plan.id)!;
    const monitor = await service.loadMonitoringContext(s.plan.taskId);
    expect(preview.situation.snapshotId).toBe('NET-DEMO-03'); expect(plan).toEqual(s.plan);
    expect(plan.links.some(row => row.id === 'PL-007')).toBe(false); expect(plan).not.toHaveProperty('deviceNetwork');
    expect(monitor.network!.links).toEqual(plan.links); expect(monitor.network).not.toHaveProperty('deviceNetwork');
    expect([...s.storage.entries]).toEqual(before); expect(s.storage.writes).toBe(writes);
  });
});

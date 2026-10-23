import type { ResourcesData, SituationData } from '../types/domain';
import type { DeviceNetworkCatalog, DeviceNetworkContext, NetworkServiceRoute, DeviceNetworkRoleContext } from '../types/device-network';
import type { ResourceMeta } from '../types/resource-edit';
import { LINK_STATUS_STYLES } from '../config/link-status';

const uniqueIds = (rows: { id: string }[]) => rows.every(row => row && typeof row.id === 'string' && row.id.trim())
  && new Set(rows.map(row => row.id)).size === rows.length;

// 只核对已给出的路径，不搜索或生成路由；错配时整个关联区明确不可用。
function validCatalog(catalog: DeviceNetworkCatalog, situation: SituationData, resources: ResourcesData) {
  if (catalog.version !== 'device-network-v1' || catalog.snapshotId !== situation.snapshotId
    || typeof catalog.source !== 'string' || !catalog.source.trim()
    || !Array.isArray(catalog.services) || !Array.isArray(catalog.routes)
    || !uniqueIds(catalog.services) || !uniqueIds(catalog.routes) || !uniqueIds(situation.links)) return false;
  const stations = new Set(resources.stations.map(row => row.id));
  const devices = new Map(resources.devices.map(row => [row.id, row]));
  const links = new Map(situation.links.map(row => [row.id, row]));
  const services = new Map(catalog.services.map(row => [row.id, row]));
  if (situation.links.some(link => !stations.has(link.a) || !stations.has(link.b) || link.a === link.b
    || devices.get(link.deviceA)?.stationId !== link.a || devices.get(link.deviceB)?.stationId !== link.b
    || !Object.hasOwn(LINK_STATUS_STYLES, link.state) || !Number.isFinite(link.frequencyKhz) || link.frequencyKhz <= 0)) return false;
  if (catalog.services.some(service => typeof service.name !== 'string' || !service.name.trim()
    || !['话音', '数据'].includes(service.serviceType) || !devices.has(service.sourceDeviceId)
    || !devices.has(service.targetDeviceId) || service.sourceDeviceId === service.targetDeviceId)) return false;
  for (const route of catalog.routes) {
    const service = services.get(route.demandId);
    if (!service || !['PRIMARY', 'BACKUP'].includes(route.routeType)
      || !Array.isArray(route.nodeIds) || !Array.isArray(route.linkIds) || !route.linkIds.length
      || route.nodeIds.length !== route.linkIds.length + 1
      || new Set(route.nodeIds).size !== route.nodeIds.length || new Set(route.linkIds).size !== route.linkIds.length) return false;
    const source = devices.get(service.sourceDeviceId)!, target = devices.get(service.targetDeviceId)!;
    if (route.nodeIds[0] !== source.stationId || route.nodeIds.at(-1) !== target.stationId) return false;
    for (let index = 0; index < route.linkIds.length; index++) {
      const link = links.get(route.linkIds[index]), from = route.nodeIds[index], to = route.nodeIds[index + 1];
      if (!link || !(link.a === from && link.b === to || link.b === from && link.a === to)) return false;
      // 同节点可能有多台电台，首尾必须落在业务声明的设备实例上。
      const fromDevice = link.a === from ? link.deviceA : link.deviceB;
      const toDevice = link.a === to ? link.deviceA : link.deviceB;
      if (index === 0 && fromDevice !== source.id || index === route.linkIds.length - 1 && toDevice !== target.id) return false;
    }
  }
  return catalog.services.every(service => {
    const routes = catalog.routes.filter(route => route.demandId === service.id);
    return routes.filter(route => route.routeType === 'PRIMARY').length === 1
      && routes.filter(route => route.routeType === 'BACKUP').length <= 1;
  });
}

export function createDeviceNetworkContext(
  situation: SituationData, resources: ResourcesData, meta: ResourceMeta, draftDirty = false,
): DeviceNetworkContext {
  const context: DeviceNetworkContext = {
    state: 'missing', message: '暂无当前演示网络的关联资料', title: situation.title,
    snapshotId: situation.snapshotId, source: '', links: [], services: [], routes: [],
  };
  // 与原 GIS 结果隐藏条件一致；手工改回已保存值不能重新认证旧结果。
  if (draftDirty || meta.changedStationIds.length || meta.changedDeviceIds.length || (meta.interferenceVersion ?? 'initial') !== 'initial')
    return { ...context, state: 'stale', message: draftDirty
      ? '资源存在未保存修改，暂停展示网络关联；撤销或取消修改后可恢复。'
      : '资源已变更，暂无匹配的网络关联样例；恢复演示基线后可查看。' };
  const catalog = situation.deviceNetwork;
  if (!catalog) return context;
  if (!validCatalog(catalog, situation, resources))
    return { ...context, state: 'invalid', message: '网络关联资料不完整或版本不匹配，暂不可用。' };
  return { ...context, state: 'ready', message: '', source: catalog.source,
    links: situation.links, services: catalog.services, routes: catalog.routes,
    roleData: readRoles(catalog, resources) };
}

// 可选角色独立失效，不使原本合法的链路和业务资料一起消失。
function readRoles(catalog: DeviceNetworkCatalog, resources: ResourcesData): DeviceNetworkRoleContext {
  const empty: DeviceNetworkRoleContext = { state: 'missing', message: '未提供设备网络角色目录', source: '', items: [] };
  const roles = catalog.roles;
  if (roles == null) return empty;
  const text = (v: unknown) => typeof v === 'string' && !!v.trim();
  if (typeof roles !== 'object' || Array.isArray(roles) || roles.version !== 'device-network-roles-v1' || roles.snapshotId !== catalog.snapshotId
    || !text(roles.source) || !Array.isArray(roles.items) || Array.from(roles.items).some(row => !row || typeof row !== 'object'
      || !resources.devices.some(device => device.id === row.deviceId) || !text(row.role) || !text(row.source)
      || row.description !== null && typeof row.description !== 'string') || new Set(roles.items.map(row => row.deviceId)).size !== roles.items.length)
    return { ...empty, state: 'invalid', message: '角色资料归属或字段无效，暂不可用' };
  return { state: 'ready', message: roles.items.length ? '' : '此网络的角色目录为空', source: roles.source, items: roles.items };
}
export function selectDeviceRole(context: DeviceNetworkContext | undefined, deviceId: string) {
  if (context?.state !== 'ready') return { role: null, message: context?.message || '未提供当前网络的角色资料', source: '' };
  const data = context.roleData;
  if (data?.state !== 'ready') return { role: null, message: data?.message || '未提供设备网络角色目录', source: '' };
  const role = data.items.find(row => row.deviceId === deviceId) ?? null;
  return { role, message: role ? '' : data.message || '当前网络未提供此设备的角色', source: data.source };
}

export function selectDeviceNetwork(context: DeviceNetworkContext | undefined, deviceId: string) {
  const links = context?.state === 'ready' ? context.links.filter(link => link.deviceA === deviceId || link.deviceB === deviceId) : [];
  const linkIds = new Set(links.map(link => link.id));
  const services: { service: DeviceNetworkCatalog['services'][number]; routes: { route: NetworkServiceRoute; participates: boolean }[] }[] = [];
  if (context?.state === 'ready') for (const service of context.services) {
    const routes = context.routes.filter(route => route.demandId === service.id)
      .sort((a, b) => Number(a.routeType === 'BACKUP') - Number(b.routeType === 'BACKUP'))
      .map(route => ({ route, participates: route.linkIds.some(id => linkIds.has(id)) }));
    if (routes.some(row => row.participates)) services.push({ service, routes });
  }
  return { links, services };
}

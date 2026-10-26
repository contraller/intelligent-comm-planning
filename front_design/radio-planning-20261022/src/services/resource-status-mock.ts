// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from './random-uuid';
import type { ResourcesData } from '../types/domain';
import type { ResourceMeta } from '../types/resource-edit';
import type { DeviceStatusItem, DeviceStatusSnapshot, DeviceStatusBatch, ResourceStatusServices } from '../types/resource-status';
import { mergeDeviceStatuses } from './resource-status-display';
import { statusDifferences, statusExamples, statusFixtures, statusObservedAt } from '../mocks/resource-status-presets';
import { validateStatusQuery, validateStatusRequest, validateStatusBatch } from './resource-status-validation';
import { assertReading,pageItems } from './data-access';
import { ApiError } from './types';
import { mockResourceRevision } from './mock-resource-revision';

// 仅查询已保存设备；不接触存储写入、规划、诊断或控制指令。
export function createResourceStatusMock(read: () => { resources: ResourcesData; meta: ResourceMeta }): ResourceStatusServices & { readSnapshot: (id: string, revision: string) => DeviceStatusSnapshot } {
  const snapshots = new Map<string, DeviceStatusSnapshot>();
  const batches=new Map<string,DeviceStatusBatch>();
  // 所有状态请求统一校验资源读取版本，不接受事务内部的原始修订。
  function readSnapshot(id: string, revision: string) {
    const value = snapshots.get(id);
    if (!value || value.resourceRevision !== revision || mockResourceRevision(read()) !== revision) throw new ApiError('观测快照已过期，请重新同步', 'RESOURCE_VERSION_CHANGED');
    return value;
  }
  const service:ResourceStatusServices & {readSnapshot:typeof readSnapshot} = {
    async loadDeviceStatusOptions(request){assertReading(request);const {targets:_targets,...options}=await service.loadDeviceStatusContext(request);return options;},
    async synchronizeDeviceStatuses(request){
      const batch=await service.queryDeviceStatuses(request),current=read();
      validateStatusBatch(batch,request,current.resources,batch.source);
      if(batches.size>=50)batches.delete(batches.keys().next().value!);batches.set(batch.batchId,batch);
      const {items,...meta}=batch;return {...meta,snapshotId:batch.snapshotId!,total:items.length,counts:{REPORTED:items.filter(row=>row.outcome==='REPORTED').length,NO_REPORT:items.filter(row=>row.outcome==='NO_REPORT').length,FAILED:items.filter(row=>row.outcome==='FAILED').length}};
    },
    async queryDeviceStatusBatch(request){
      assertReading(request);const batch=batches.get(request.batchId);if(!batch||batch.resourceRevision!==request.resourceRevision)throw new ApiError('状态批次已过期，请重新同步','RESOURCE_VERSION_CHANGED');
      const snapshot=readSnapshot(batch.snapshotId!,mockResourceRevision(read())),page=pageItems(batch.items,request);
      return {...page,records:Object.fromEntries(page.items.map(row=>[row.deviceId,snapshot.records[row.deviceId]]))};
    },
    readSnapshot,
    async loadDeviceStatusContext(request) {
      const current = read(); validateStatusRequest(request, mockResourceRevision(current));
      return structuredClone({ resourceRevision: request.resourceRevision, source: statusExamples[0]!.source, examples: statusExamples,
        targets: current.resources.devices.map(d => ({ deviceId: d.id, stationId: d.stationId, modelId: d.modelId })) });
    },
    async queryDeviceStatuses(request) {
      const current = read(); validateStatusQuery(request, current.resources, mockResourceRevision(current));
      const example = statusExamples.find(e => e.id === (request.exampleId ?? 'normal'));
      if (!example) throw new ApiError('暂无此预生成状态样例', 'DEVICE_STATUS_EXAMPLE_MISSING');
      if (example.id === 'failed') throw new ApiError('教学预设：整批状态读取失败，未改变设备状态', 'DEVICE_STATUS_READ_FAILED');
      const ids = request.scope === 'ALL' ? current.resources.devices.map(d => d.id) : request.deviceIds;
      const items: DeviceStatusItem[] = ids.map(id => {
        const device = current.resources.devices.find(d => d.id === id)!;
        const identity = { deviceId: id, stationId: device.stationId, modelId: device.modelId }, fixture = statusFixtures.get(id);
        if (!fixture || device.origin !== 'SOURCE' || fixture.stationId !== device.stationId || fixture.modelId !== device.modelId)
          return { ...identity, outcome: 'NO_REPORT', reason: '此设备关联没有预生成状态' };
        if (example.id === 'partial' && id === 'DV-0001') return { ...identity, outcome: 'NO_REPORT', reason: '教学预设：本批未收到设备上报' };
        if (example.id === 'partial' && id === 'DV-0002') return { ...identity, outcome: 'FAILED', reason: '教学预设：此设备状态读取失败' };
        const state = example.id !== 'normal' && statusDifferences[id] ? statusDifferences[id]! : fixture;
        return { ...identity, outcome: 'REPORTED', observation: { observationId: example.id + ':' + id,
          sequence: 1, observedAt: statusObservedAt, status: state.status, alert: state.alert } };
      });
      const batch = { batchId: randomUuid(), snapshotId: randomUuid(), resourceRevision: request.resourceRevision, source: example.source, items };
      const previous = request.previousSnapshotId ? readSnapshot(request.previousSnapshotId, mockResourceRevision(current)) : undefined;
      if (previous && previous.source.id !== example.source.id) throw new ApiError('观测来源已变化，请重新同步', 'INVALID_DEVICE_STATUS_QUERY');
      // 保存累计有效观测；勾选外设备、缺报和旧序号沿用原合并规则。
      const records = mergeDeviceStatuses(previous?.records ?? {}, batch, new Date().toISOString());
      if (snapshots.size >= 50) snapshots.delete(snapshots.keys().next().value!);
      snapshots.set(batch.snapshotId, { id: batch.snapshotId, resourceRevision: mockResourceRevision(current), source: example.source, records });
      return structuredClone(batch);
    },
  };
  return service;
}

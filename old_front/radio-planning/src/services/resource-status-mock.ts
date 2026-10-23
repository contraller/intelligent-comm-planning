import type { ResourcesData } from '../types/domain';
import type { ResourceMeta } from '../types/resource-edit';
import type { DeviceStatusItem, ResourceStatusServices } from '../types/resource-status';
import { statusDifferences, statusExamples, statusFixtures, statusObservedAt } from '../mocks/resource-status-presets';
import { validateStatusQuery, validateStatusRequest } from './resource-status-validation';
import { ApiError } from './types';

// 仅查询已保存设备；不接触存储写入、规划、诊断或控制指令。
export function createResourceStatusMock(read: () => { resources: ResourcesData; meta: ResourceMeta }): ResourceStatusServices {
  return {
    async loadDeviceStatusContext(request) {
      const current = read(); validateStatusRequest(request, current.meta.revision);
      return structuredClone({ resourceRevision: current.meta.revision, source: statusExamples[0]!.source, examples: statusExamples });
    },
    async queryDeviceStatuses(request) {
      const current = read(); validateStatusQuery(request, current.resources, current.meta.revision);
      const example = statusExamples.find(e => e.id === (request.exampleId ?? 'normal'));
      if (!example) throw new ApiError('暂无此预生成状态样例', 'DEVICE_STATUS_EXAMPLE_MISSING');
      if (example.id === 'failed') throw new ApiError('教学预设：整批状态读取失败，未改变设备状态', 'DEVICE_STATUS_READ_FAILED');
      const items: DeviceStatusItem[] = request.deviceIds.map(id => {
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
      return structuredClone({ batchId: crypto.randomUUID(), resourceRevision: current.meta.revision, source: example.source, items });
    },
  };
}

import { createMonitoringMock } from './monitoring-mock';
import { createDeviceConfigurationMock } from './device-configuration-mock';
import { createResourceStatusMock } from './resource-status-mock';
import { loadDeviceCoverageCatalog } from './device-coverage-mock';
import { createResourceReadMock } from './resource-read-mock';
import { createInterferenceMock } from './interference-mock';

import { createTaskMock } from './task-mock';
import { createTaskApiMock } from './task-api-mock';
import { createPlanningApiMock } from './planning-api-mock';
import type { ApiReceipt } from '../types/task-api';
import { taskSourceChanged } from './task-validation';
import situation from '../mocks/situation.json';
import planning from '../mocks/planning.json';
import diagnosis from '../mocks/diagnosis.json';
import knowledge from '../mocks/knowledge.json';
import system from '../mocks/system.json';
import deviceDetails from '../mocks/device-details.json';
import deviceNetwork from '../mocks/device-network.json';
import linkDetails from '../mocks/link-details.json';
import { withOrdinaryAssessments } from './link-assessment-mock';
import { deviceNetworkRoles } from '../mocks/device-network-roles';
import type { LinkDetailCatalog } from '../types/link-detail';
import type { PreviewData, ResourcesData } from '../types/domain';
import type { ResourceMeta, ResourceStorage } from '../types/resource-edit';
import type { PreviewService } from './types';
import { createResourceMock } from './resource-mock';
import { createSpectrumMock } from './spectrum-mock';
import { createPlanningMock } from './planning-mock';
import { createDiagnosisMock } from './diagnosis-mock';
import { createKnowledgeMock } from './knowledge-mock';
import { createSystemMock, resolveSystemIdentity } from './system-mock';
import { browserSessionStorage } from './session-storage';
import { dependenciesChanged } from './planning-validation';

import { browserResourceStorage, readResources } from './resource-storage';

// 只更新来源标记，历史输入、结果、诊断均不随资源改动重写。
export function markChangedPlans(data: PreviewData, meta: ResourceMeta) {
  for (const plan of data.planning.plans) {
    if (plan.workflow) {
      plan.sourceChanged = dependenciesChanged(plan.workflow.dependencies, meta)||taskSourceChanged(plan.taskId,plan.workflow.input,meta,plan.workflow.dependencies.task?.conditionVersion);
      continue;
    }
    plan.sourceChanged ||= (meta.interferenceVersion??'initial')!=='initial' ||
      plan.inputSnapshot.stations.some((row) => meta.changedStationIds.includes(row.id)) ||
      plan.inputSnapshot.devices.some((row) => meta.changedDeviceIds.includes(row.id));
  }
}

export function createMockService(getStorage: () => ResourceStorage, getSessions?: () => ResourceStorage): PreviewService {
  const resource=createResourceMock(getStorage),source=resource.source;
  const apiReceipts = new Map<string, ApiReceipt>();
  function buildPreview(saved: { resources: ResourcesData; meta: ResourceMeta }) {
    const data = structuredClone({
      resources: saved.resources,
      resourceMeta: saved.meta,
      // 资料随预览返回独立副本，组件不直接读取 CSV，也不改资源基线。
      deviceDetails,
      // 业务与链路资料随当前 GIS 网络复制，不回填规划、诊断或监控快照。
      situation: { ...situation, deviceNetwork: { ...deviceNetwork, roles: deviceNetworkRoles },
        linkDetails: withOrdinaryAssessments(linkDetails as LinkDetailCatalog), deviceCoverage: loadDeviceCoverageCatalog() },
      planning,
      diagnosis,
      knowledge,
      system,
    }) as PreviewData;
    markChangedPlans(data, saved.meta);
    return data;
  }
  return {
    // 只传入资源读取函数，配置回执没有资源提交能力。
    ...createDeviceConfigurationMock(getStorage, () => readResources(getStorage(), source), deviceDetails),
    // 状态观测只读资源，不复用会写版本的资源保存入口。
    ...createResourceStatusMock(() => readResources(getStorage(), source)),
    ...createResourceReadMock(() => readResources(getStorage(), source)),
    ...createTaskApiMock(getStorage, () => readResources(getStorage(), source), apiReceipts),
    ...createPlanningApiMock(getStorage, () => readResources(getStorage(), source), apiReceipts),
    ...resource.services,
    ...createMonitoringMock(getStorage, () => readResources(getStorage(), source)),
    ...createTaskMock(getStorage),
    ...createSpectrumMock(getStorage),
    // 知识自行读取专用键，资源工作区错误不阻断已发布知识。
    ...createSystemMock(getStorage,getSessions),
    ...createKnowledgeMock(getStorage,undefined,getSessions ? () => resolveSystemIdentity(getStorage(),getSessions()) : undefined),
    ...createInterferenceMock(getStorage, () => readResources(getStorage(), source)),
    ...createPlanningMock(getStorage, () => readResources(getStorage(), source)),
    // 诊断自有存储与快照，源规划移除后仍可读取历史。
    ...createDiagnosisMock(getStorage, () => readResources(getStorage(), source)),
    async loadPreview() {
      return buildPreview(readResources(getStorage(), source));
    },
    async commitResources(request) { return resource.commit(request); },
    async resetResources(baseRevision) {
      const result=resource.reset(baseRevision);
      return {...result,preview:buildPreview(result)};
    },
  };
}

export const mockService = createMockService(browserResourceStorage,browserSessionStorage);

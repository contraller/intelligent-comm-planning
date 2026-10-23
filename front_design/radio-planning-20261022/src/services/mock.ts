import { createMonitoringMock } from './monitoring-mock';
import { createDeviceConfigurationMock } from './device-configuration-mock';
import { createDeviceMaintenanceMock } from './device-maintenance-mock';
import { createDeviceNetworkDetailMock } from './device-network-detail-mock';
import { createResourceStatusMock } from './resource-status-mock';
import { loadDeviceCoverageCatalog } from './device-coverage-mock';
import { createResourceReadMock } from './resource-read-mock';
import { createDeviceNetworkContext, projectDeviceNetwork } from './device-network';
import { createLinkDetailContext } from './link-detail';
import { gisResourceIndex } from './gis-workspace';
import { gisDevicePoints } from '../maps/gis-device-display';
import { createInterferenceMock } from './interference-mock';

import { createTaskMock } from './task-mock';
import { createTaskApiMock } from './task-api-mock';
import { createPlanningApiMock } from './planning-api-mock';
import type { ApiReceipt } from '../types/task-api';
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
import type { DeviceStatusSnapshot } from '../types/resource-status';
import type { PreviewService } from './types';
import { createResourceMock } from './resource-mock';
import { createSpectrumMock } from './spectrum-mock';
import { createPlanningMock } from './planning-mock';
import { createDiagnosisMock } from './diagnosis-mock';
import { createKnowledgeMock } from './knowledge-mock';
import { createSystemMock, resolveSystemIdentity } from './system-mock';
import { browserSessionStorage } from './session-storage';
// 来源标记逻辑统一由独立模块维护。
import { markChangedPlans } from './planning-source-state';
import { mockResourceRevision } from './mock-resource-revision';
import { requireRevision, assertReadOptions } from './resource-read-validation';

import { browserResourceStorage, readResources } from './resource-storage';

export function createMockService(getStorage: () => ResourceStorage, getSessions?: () => ResourceStorage): PreviewService {
  let resolveObservation:((id:string,revision:string)=>DeviceStatusSnapshot)|undefined;
  const resource=createResourceMock(getStorage,(id,revision)=>{
    if(!resolveObservation)throw new Error('观测工作区尚未初始化');
    return resolveObservation(id,revision);
  },()=>situation.links as PreviewData['situation']['links'], getSessions ? () => resolveSystemIdentity(getStorage(),getSessions()) : undefined),source=resource.source;
  const status=createResourceStatusMock(()=>readResources(getStorage(),source));
  resolveObservation=status.readSnapshot;
  const resourceRead=createResourceReadMock(()=>readResources(getStorage(),source),status.readSnapshot, () => situation.links as import('../types/domain').NetworkLink[]);
  const apiReceipts = new Map<string, ApiReceipt>();
  function buildPreview(saved: { resources: ResourcesData; meta: ResourceMeta }) {
    const data = structuredClone({
      resources: saved.resources,
      resourceMeta: saved.meta,
      // 资料随预览返回独立副本，组件不直接读取 CSV，也不改资源基线。
      deviceDetails,
      // 业务与链路资料随当前 GIS 网络复制，不回填规划、诊断或监控快照。
      situation: { ...situation, deviceNetwork: { ...deviceNetwork, roles: deviceNetworkRoles },
        linkDetails: withOrdinaryAssessments(linkDetails as LinkDetailCatalog) },
      planning,
      diagnosis,
      knowledge,
      system,
    }) as PreviewData;
    markChangedPlans(data, saved.meta);
    return data;
  }
  return {
    ...createDeviceMaintenanceMock(resource.read),
    ...createDeviceNetworkDetailMock(()=>buildPreview(resource.read())),
    async getGisLinkDetails(input) {
      assertReadOptions(input,true);
      const saved=resource.read();requireRevision(mockResourceRevision(saved),input.revision);
      const data=buildPreview(saved);
      if(input.snapshotId!==data.situation.snapshotId)throw new Error('链路快照已变化');
      const context=createLinkDetailContext(data.situation,data.resources,data.resourceMeta);
      return {...context,records:context.records.filter(row=>row.linkId===input.id)};
    },
    async loadGisResourceDirectory(input) {
      assertReadOptions(input, true);
      const saved = readResources(getStorage(), source);
      requireRevision(mockResourceRevision(saved), input.revision);
      return structuredClone({ revision: input.revision, resources: gisResourceIndex(saved.resources) });
    },
    async getGisCoverageCatalog(input) {
      assertReadOptions(input,true);const saved=readResources(getStorage(),source);requireRevision(mockResourceRevision(saved),input.revision);
      // 教学覆盖资料仅在打开覆盖设置或明确查看设备覆盖时读取。
      return loadDeviceCoverageCatalog();
    },
    async loadGisResourceScene(input) {
      assertReadOptions(input, true);
      const saved = readResources(getStorage(), source);
      requireRevision(mockResourceRevision(saved), input.revision);
      const data = buildPreview(saved);
      const points = gisDevicePoints(data.resources);
      // 绘制响应不运输设备业务目录和所有链路历史，选中对象后独立读取。
      const {deviceNetwork: _network, linkDetails: _details, ...drawing}=data.situation;
      const {taskWorkspace: _tasks, receipts: _receipts, deviceHistory: _history, ...meta}=data.resourceMeta;
      return { revision: input.revision, resourceMeta: meta, situation: drawing,
        map: { stations: data.resources.stations, interferences: data.resources.interferences, devices: points.points, missingCount: points.missingCount },
        network: {state:'missing',message:'选中设备后读取关联资料',title:drawing.title,snapshotId:drawing.snapshotId,source:'',links:[],services:[],routes:[]},
        linkDetails: {state:'missing',message:'选中链路后读取详情',snapshotId:drawing.snapshotId,source:'',records:[]} };
    },
    async loadGisResourceEditContext(input) {
      // 编辑单独读取完整基线，不复用浏览目录或地图显示对象。
      assertReadOptions(input, true);
      const saved = readResources(getStorage(), source);
      requireRevision(mockResourceRevision(saved), input.revision);
      const data = buildPreview(saved);
      const {deviceHistory: _history, ...meta}=data.resourceMeta;
      return { revision: input.revision, resources: data.resources, resourceMeta: meta,
        situation: data.situation, deviceDetails: data.deviceDetails,
        baseRevision: data.resourceMeta.revision, validationSource: structuredClone(source) };
    },
    // 只传入资源读取函数，配置回执没有资源提交能力。
    ...createDeviceConfigurationMock(getStorage, () => readResources(getStorage(), source), deviceDetails,Date.now,getSessions ? () => resolveSystemIdentity(getStorage(),getSessions()) : undefined),
    // 状态观测只读资源，不复用会写版本的资源保存入口。
    loadDeviceStatusContext: status.loadDeviceStatusContext,
    queryDeviceStatuses: status.queryDeviceStatuses,
    loadDeviceStatusOptions:status.loadDeviceStatusOptions,
    synchronizeDeviceStatuses:status.synchronizeDeviceStatuses,
    queryDeviceStatusBatch:status.queryDeviceStatusBatch,
    ...resourceRead,
    async getResourceObject(request){
      const detail=await resourceRead.getResourceObject(request),preview=buildPreview(resource.read());
      if(detail.object.kind!=='device')return detail;
      const device=detail.object,catalog=preview.deviceDetails;
      return {...detail,catalog:catalog?{...catalog,models:catalog.models.filter(row=>row.modelId===device.modelId),antennas:catalog.antennas.filter(row=>row.antennaId===device.antennaId)}:null,
        network:projectDeviceNetwork(createDeviceNetworkContext(preview.situation,preview.resources,preview.resourceMeta),device.id)};
    },
    ...createTaskApiMock(getStorage, () => readResources(getStorage(), source), apiReceipts),
    ...createPlanningApiMock(getStorage, () => readResources(getStorage(), source), apiReceipts),
    ...resource.services,
    async loadResourceMaintenanceContext(request){
      const context=await resource.services.loadResourceMaintenanceContext(request),preview=buildPreview(resource.read());
      const ids=request.ids??(request.deviceId?[request.deviceId]:[]);
      // 与原台账一致，仅提示当前工作区明确到设备的引用，不禁止下架。
      return {...context,impact:{planIds:preview.planning.plans.filter(p=>p.inputSnapshot.devices.some(d=>ids.includes(d.id))).map(p=>p.id),
        linkIds:preview.situation.links.filter(l=>ids.includes(l.deviceA)||ids.includes(l.deviceB)).map(l=>l.id),description:'当前工作区已加载的设备引用'}};
    },
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

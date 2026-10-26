import { afterEach,describe,it,expect,vi } from 'vitest';
import { createPinia,setActivePinia,disposePinia } from 'pinia';
import { createSSRApp,h } from 'vue';
import { createRouter,createMemoryHistory,RouterView } from 'vue-router';
import SituationView from '../src/views/SituationView.vue';
import { renderToString } from '@vue/server-renderer';
import { authorizeStore } from './helpers/auth';
import { monitoringFixture,bindMonitoring,settleMonitoring } from './helpers/monitoring';
import { useMonitoringStore } from '../src/stores/monitoring';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { useResourceReadStore } from '../src/stores/resource-read';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { previewService } from '../src/services';
import { collaborationHttp } from '../src/services/http';
import { createMockService } from '../src/services/mock';
import { readSystem,writeSystem } from '../src/services/system-storage';
import { PLANNING_POLL_MS,DIAGNOSIS_POLL_MS } from '../src/config/demo';
import SituationMonitoringDrawer from '../src/components/SituationMonitoringDrawer.vue';
import MonitoringObjectPanel from '../src/components/MonitoringObjectPanel.vue';
import DeviceMonitoringPanel from '../src/components/DeviceMonitoringPanel.vue';
import LinkMonitoringPanel from '../src/components/LinkMonitoringPanel.vue';
import type { GisNetwork } from '../src/types/gis-plan';
import { createWorkbenchFixture, enterWorkbenchStore } from './helpers/interference-workbench';

let pinia:ReturnType<typeof createPinia>;
afterEach(()=>{if(pinia)disposePinia(pinia);vi.restoreAllMocks();vi.useRealTimers();});
async function start(){
  vi.useFakeTimers();pinia=createPinia();setActivePinia(pinia);authorizeStore();
  const fixture=await monitoringFixture();bindMonitoring(fixture.monitoring); vi.spyOn(previewService,'getMonitoringObservation').mockImplementation(fixture.monitoring.getMonitoringObservation);
  const store=useMonitoringStore(),gis=useGisWorkspaceStore();gis.mapMode='monitoring';store.visible=true;
  await store.loadNetwork(fixture.plan.taskId);await settleMonitoring();
  return {...fixture,store,gis};
}
// 本组旧回放使用显式 teaching 服务；不作为 HTTP 冻结状态或真实观测验收证据。
describe('教学回放状态与页面集成',()=>{
  it('首帧只加载一次，网络双页签共享帧，收起和隐藏暂停',async()=>{
    const s=await start();expect(s.store.networkState.index).toBe(0);
    expect(previewService.getMonitoringObservation).toHaveBeenCalledTimes(1);
    s.store.tab='links';await settleMonitoring();expect(s.store.networkState.index).toBe(0);
    await s.store.refreshNetwork();await settleMonitoring();expect(s.store.networkState.index).toBe(1);
    s.store.open=false;await vi.advanceTimersByTimeAsync(90000);expect(s.store.networkState.index).toBe(1);
    s.store.open=true;await vi.advanceTimersByTimeAsync(30000);expect(s.store.networkState.index).toBe(2);
    s.store.visible=false;await vi.advanceTimersByTimeAsync(90000);expect(s.store.networkState.index).toBe(2);
    s.store.visible=true;await vi.advanceTimersByTimeAsync(30000);expect(s.store.networkState.finished).toBe(true);
    await s.store.restartNetwork();expect(s.store.networkState.index).toBe(0);
  });
  it('相关资源变更保留最后快照并停止，来源读取失败明确未知',async()=>{
    const s=await start(),old=JSON.stringify(s.store.networkResult),raw=createMockService(()=>s.storage);
    await raw.commitResources({baseRevision:s.resource.read().meta.revision,requestId:'change',stations:[],devices:[{id:'DV-0001',antennaHeightM:17}]});
    await s.store.loadNetwork();expect(s.store.context?.source.state).toBe('HISTORICAL');
    expect(JSON.stringify(s.store.networkResult)).toBe(old);await vi.advanceTimersByTimeAsync(90000);expect(s.store.networkState.index).toBe(0);
    s.storage.failRead=true;await s.store.loadNetwork();expect(s.store.context?.source.state).toBe('UNKNOWN');expect(JSON.stringify(s.store.networkResult)).toBe(old);
  });
  it('PAR-01 更新下一轮周期，不改变规划和诊断轮询常量',async()=>{
    const s=await start(),w=readSystem(s.storage);w.parameters.find(row=>row.id==='PAR-01')!.value=2;writeSystem(s.storage,w);
    await s.store.loadNetwork();await vi.advanceTimersByTimeAsync(1999);expect(s.store.networkState.index).toBe(0);
    await vi.advanceTimersByTimeAsync(1);expect(s.store.networkState.index).toBe(1);
    expect(PLANNING_POLL_MS).toBe(1000);expect(DIAGNOSIS_POLL_MS).toBe(1000);
  });
  it('频谱与网络独立，检查失败保留旧帧，配置改变后重新检查才能播放',async()=>{
    const s=await start();await s.enableSpectrum();s.store.tab='spectrum';await s.store.loadSpectrum();await settleMonitoring();
    expect(s.store.spectrumState.index).toBe(0);const old=s.store.spectrumResult!.frame.id;
    await s.checkSpectrum('format-invalid');await s.store.loadSpectrum();await vi.advanceTimersByTimeAsync(90000);
    expect(s.store.spectrumStale).toBe(true);expect(s.store.spectrumResult!.frame.id).toBe(old);expect(s.store.networkState.index).toBe(0);
    const w=await s.spectrum.loadSpectrumWorkspace();
    await s.spectrum.saveSpectrumSource({baseRevision:w.revision,requestId:'new-period',source:{...w.sources[0],intervalSeconds:2}});
    await s.store.loadSpectrum();expect(s.store.spectrumStale).toBe(true);
    await s.checkSpectrum('success');await s.store.loadSpectrum();await settleMonitoring();
    expect(s.store.spectrumResult!.frame.id).not.toBe(old);expect(s.store.spectrumState.index).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);expect(s.store.spectrumState.index).toBe(1);
  });
  it('监控/资源切换与新版独立分析均不保存或丢弃 GIS 表单',async()=>{
    const s=await start(),raw=createMockService(()=>s.storage);
    for (const key of ['loadResourceReadContext','queryResourceDevices','queryResourceNodes','queryResourceInterferences','getResourceObject','queryResourceMap','loadGisResourceScene','loadGisResourceEditContext'] as const) vi.spyOn(previewService, key).mockImplementation(raw[key].bind(raw) as never);
    await useResourceReadStore().activate('gis'); await s.gis.loadScene();
    vi.spyOn(previewService,'loadPreview').mockImplementation(raw.loadPreview);
    await usePreviewStore().load();await s.gis.begin();const editor=useResourceEditStore();
    await editor.openForm('device','DV-0001');editor.form!.fields.antennaHeightM='19';
    const before=[...s.storage.entries];
    s.store.selectDevice('DV-0001');expect(s.gis.mapMode).toBe('monitoring');expect(editor.formDirty).toBe(true);
    const fixture=await createWorkbenchFixture(),analysis=await enterWorkbenchStore(fixture);
    // 新分析由冻结方案操作面板持有，不再用旧 select() 抢占普通资源/监控地图。
    expect(analysis.mapProjection?.planId).toBe(fixture.target.planId);
    expect(s.gis.mapMode).toBe('monitoring');expect(editor.formDirty).toBe(true);fixture.assertNoWrites();
    await s.gis.begin();expect(s.gis.mapMode).toBe('resource');expect(editor.form!.fields.antennaHeightM).toBe('19');
    expect([...s.storage.entries]).toEqual(before);
  });
  // 完整页面渲染覆盖组合逻辑；真实地图画布和拖拽仍需浏览器验收。
  it('完整 GIS 页面默认资源图，观测抽屉独立加载首帧',async()=>{
    const s=await start(),raw=createMockService(()=>s.storage);
    for (const key of ['loadResourceReadContext','queryResourceDevices','queryResourceNodes','queryResourceInterferences','getResourceObject','queryResourceMap','loadGisResourceScene','loadGisResourceEditContext'] as const) vi.spyOn(previewService, key).mockImplementation(raw[key].bind(raw) as never);
    await useResourceReadStore().activate('gis'); await s.gis.loadScene();
    vi.spyOn(previewService,'loadPreview').mockImplementation(raw.loadPreview);await usePreviewStore().load();
    const router=createRouter({history:createMemoryHistory(),routes:[{path:'/situation',component:SituationView}]});
    const app=createSSRApp({render:()=>h(RouterView)});app.use(pinia);app.use(router);
    await router.push('/situation');await router.isReady();
    const html=await renderToString(app);
    // 资源地图与观测抽屉同时可用，查看统计不改变地图来源。
    expect(html).not.toContain('监控冻结网络');expect(html).toContain('通信链路态势');expect(html).not.toContain('监控详情');
    expect(s.gis.mapMode).toBe('resource');expect(html).toContain('在地图查看监控网络');
    expect(s.store.open).toBe(true);expect(s.store.networkState.index).toBe(0);
  });
  // 指标重排读取同一帧，不附加规划资料中的逐指标判定。
  it('不把legacy链路构造帧当作冻结方案实测',async()=>{
    const s=await start(), link=s.store.networkResult!.frame.links[0]!;
    s.store.selectLink(link.linkId); link.snrDb=null; link.throughputKbps=0;
    const app=createSSRApp(MonitoringObjectPanel);app.use(pinia);
    const html=await renderToString(app);
    // 同时保留未知观测展示及原始零值，不以测试迁移降低来源保护。
    expect(html).toContain('方案等级');expect(html).toContain('未提供链路观测');
    expect(html).not.toContain('链路观测指标');expect(html).not.toContain('metric-state');
    expect(link.snrDb).toBeNull();expect(link.throughputKbps).toBe(0);
    expect(html).not.toContain('实时采集');
  });
  it('监控组件可渲染设备状态、采集时间及观测/配置详情',async()=>{
    const s=await start();s.store.selectDevice('DV-0001');
    const app=createSSRApp(SituationMonitoringDrawer);app.use(pinia);
    const html=await renderToString(app);
    for(const value of ['设备监控态势','通信链路态势','频谱态势','网络观测','DV-0001'])expect(html).toContain(value);
    const detail=createSSRApp(MonitoringObjectPanel);detail.use(pinia);
    const rendered=await renderToString(detail);expect(rendered).toContain('方案配置功率');expect(rendered).toContain('未知');
  });
});

describe('R2 冻结网络监控契约',()=>{
  it('旧监控包装未收到显式观测上下文时明确说明，不隐建HTTP客户端或读取默认数据集',async()=>{
    const s=await start();s.store.tab='spectrum';
    const read=vi.spyOn(collaborationHttp.observations,'loadObservationContext');
    const app=createSSRApp(SituationMonitoringDrawer);app.use(pinia);const html=await renderToString(app);
    expect(html).toContain('未提供观测读取上下文');expect(read).not.toHaveBeenCalled();
  });
  it('设备冻结配置的零值保留；没有同版状态快照则不从旧帧推断正常',async()=>{
    pinia=createPinia();setActivePinia(pinia);authorizeStore();const f=await createWorkbenchFixture();
    const app=createSSRApp(DeviceMonitoringPanel,{frozenNetwork:f.network,selectedId:'UNIT-D1'});app.use(pinia);
    const html=await renderToString(app);
    expect(html).toContain('UNIT-D1');expect(html).toContain('方案配置功率');expect(html).toContain('>0<');
    expect(html).toContain('未知');expect(html).toContain('未选择或未读取同版状态快照');expect(html).not.toContain('NOT_IMPLEMENTED');
  });
  it('链路冻结预测状态与未采集观测分开，null不补成0或实测良好',async()=>{
    pinia=createPinia();setActivePinia(pinia);authorizeStore();const f=await createWorkbenchFixture();
    const app=createSSRApp(LinkMonitoringPanel,{frozenNetwork:f.network,selectedId:'UNIT-L1'});app.use(pinia);
    const html=await renderToString(app);
    expect(html).toContain('UNIT-L1');expect(html).toContain('方案等级');expect(html).toContain('未知');
    expect(html).not.toContain('NOT_IMPLEMENTED');expect(html).not.toContain('实时采集成功');
  });
});

describe('R2 HTTP冻结网络专用展示', () => {
  const network = { identity: { resource_revision: 'resource-A' }, devices: [{ id: 'device-A', station_id: 'node-A', frequency_khz: 0, tx_power_dbm: 0 }],
    links: [{ id: 'link-A', a: 'node-A', b: 'node-B', device_a: 'device-A', device_b: 'device-B', frequency_khz: null, planned_state: 'WARNING' }] } as unknown as GisNetwork;
  it('没有legacy network/frame也可展示冻结配置，零值不丢失，状态未知', async () => {
    const html = await renderToString(createSSRApp(DeviceMonitoringPanel, { frozenNetwork: network }));
    expect(html).toContain('device-A'); expect(html).toContain('方案配置功率'); expect(html).toContain('未知'); expect(html).toContain('>0<');
  });
  it('链路直接显示冻结planned_state，未知实测不被预测覆盖', async () => {
    const html = await renderToString(createSSRApp(LinkMonitoringPanel, { frozenNetwork: network, selectedId: 'link-A' }));
    expect(html).toContain('link-A'); expect(html).toContain('方案等级'); expect(html).toContain('未提供链路观测'); expect(html).not.toContain('NOT_IMPLEMENTED');
  });
});

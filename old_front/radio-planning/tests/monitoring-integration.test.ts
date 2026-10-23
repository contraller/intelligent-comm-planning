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
import { usePreviewStore } from '../src/stores/preview';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { useInterferenceStore } from '../src/stores/interference';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { readSystem,writeSystem } from '../src/services/system-storage';
import { PLANNING_POLL_MS,DIAGNOSIS_POLL_MS } from '../src/config/demo';
import SituationMonitoringDrawer from '../src/components/SituationMonitoringDrawer.vue';
import MonitoringObjectPanel from '../src/components/MonitoringObjectPanel.vue';

let pinia:ReturnType<typeof createPinia>;
afterEach(()=>{if(pinia)disposePinia(pinia);vi.restoreAllMocks();vi.useRealTimers();});
async function start(){
  vi.useFakeTimers();pinia=createPinia();setActivePinia(pinia);authorizeStore();
  const fixture=await monitoringFixture();bindMonitoring(fixture.monitoring);
  const store=useMonitoringStore(),gis=useGisWorkspaceStore();gis.mapMode='monitoring';store.visible=true;
  await store.loadNetwork(fixture.plan.taskId);await settleMonitoring();
  return {...fixture,store,gis};
}
describe('态势状态与页面集成',()=>{
  it('首帧只加载一次，网络双页签共享帧，收起和隐藏暂停',async()=>{
    const s=await start();expect(s.store.networkState.index).toBe(0);
    expect(previewService.getMonitoringFrame).toHaveBeenCalledTimes(1);
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
  it('监控/分析/资源模式互斥，切换不保存或丢弃 GIS 表单',async()=>{
    const s=await start(),raw=createMockService(()=>s.storage);
    vi.spyOn(previewService,'loadPreview').mockImplementation(raw.loadPreview);
    await usePreviewStore().load();s.gis.begin();const editor=useResourceEditStore();
    await editor.openForm('device','DV-0001','gis');editor.form!.fields.antennaHeightM='19';
    const before=[...s.storage.entries];
    s.store.selectDevice('DV-0001');expect(s.gis.mapMode).toBe('monitoring');expect(editor.formDirty).toBe(true);
    const analysis=useInterferenceStore();analysis.select('analysis-selection');expect(s.gis.mapMode).toBe('analysis');
    s.gis.begin();expect(s.gis.mapMode).toBe('resource');expect(editor.form!.fields.antennaHeightM).toBe('19');
    expect([...s.storage.entries]).toEqual(before);
  });
  // 完整页面渲染覆盖组合逻辑；真实地图画布和拖拽仍需浏览器验收。
  it('完整 GIS 页面默认保留监控地图和抽屉，详情按需展开',async()=>{
    const s=await start(),raw=createMockService(()=>s.storage);
    vi.spyOn(previewService,'loadPreview').mockImplementation(raw.loadPreview);await usePreviewStore().load();
    const router=createRouter({history:createMemoryHistory(),routes:[{path:'/situation',component:SituationView}]});
    const app=createSSRApp({render:()=>h(RouterView)});app.use(pinia);app.use(router);
    await router.push('/situation');await router.isReady();
    const html=await renderToString(app);
    // 普通入口让出详情栏占位，监控仍默认展开并加载首帧。
    expect(html).toContain('监控冻结网络');expect(html).toContain('通信链路态势');expect(html).not.toContain('监控详情');
    expect(s.store.open).toBe(true);expect(s.store.networkState.index).toBe(0);
  });
  it('监控组件可渲染设备状态、采集时间及观测/配置详情',async()=>{
    const s=await start();s.store.selectDevice('DV-0001');
    const app=createSSRApp(SituationMonitoringDrawer);app.use(pinia);
    const html=await renderToString(app);
    for(const value of ['设备监控态势','通信链路态势','频谱态势','预设采集时间','Mock 有限观测','DV-0001'])expect(html).toContain(value);
    const detail=createSSRApp(MonitoringObjectPanel);detail.use(pinia);
    const rendered=await renderToString(detail);expect(rendered).toContain('观测功率');expect(rendered).toContain('方案配置功率');
  });
});

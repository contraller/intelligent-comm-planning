import { useResourceReadStore } from '../src/stores/resource-read';
import { afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import * as Vue from 'vue';
import { h,nextTick,ssrContextKey,type App } from 'vue';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import { createMemoryHistory,createRouter } from 'vue-router';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
// 编译与同型基础宿主复用公共工具，保留本文件的事件和生命周期。
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';
import { createMockService } from '../src/services/mock';
import { createDeviceConfigurationMock } from '../src/services/device-configuration-mock';
import { initialResources } from '../src/mocks/resource-presets';
import details from '../src/mocks/device-details.json';
import { readResources } from '../src/services/resource-storage';
import { previewService } from '../src/services';
import { useDeviceConfigurationStore } from '../src/stores/device-configuration';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { useResourceLedgerEditStore } from '../src/stores/resource-ledger-edit';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { useSessionAccess } from '../src/composables/useSessionAccess';
import { DEVICE_CONFIGURATION_PHASE_MS, DEVICE_CONFIGURATION_STORAGE_KEY, RESOURCE_STORAGE_KEY } from '../src/config/demo';
import AppShell from '../src/layouts/AppShell.vue';
import DeviceConfigurationDrawer from '../src/components/DeviceConfigurationDrawer.vue';
import DeviceInfoPanel from '../src/components/DeviceInfoPanel.vue';
import ObjectInfoPanel from '../src/components/ObjectInfoPanel.vue';
import ResourcesView from '../src/views/ResourcesView.vue';
import ResourceLedgerTree from '../src/components/ResourceLedgerTree.vue';
import SituationView from '../src/views/SituationView.vue';
import GisObjectInfoPanel from '../src/components/GisObjectInfoPanel.vue';
import DecisionDialog from '../src/components/DecisionDialog.vue';
// 保留实际页面、参数区、配置表单和决策，只替换地图与本批无关的展示。
vi.mock('../src/components/AppDrawer.vue',()=>({default:Vue.defineComponent({props:['visible'],emits:['update:visible'],setup:(p,{slots,emit})=>()=>p.visible?Vue.h('aside',[slots.default?.(),slots.footer?.(),...['X','Esc','遮罩'].map(label=>Vue.h('button',{onClick:()=>emit('update:visible',false)},label))]):null})}));
vi.mock('primevue/dialog',()=>({default:Vue.defineComponent({props:['visible'],setup:(p,{slots})=>()=>p.visible?Vue.h('dialog',[slots.default?.(),slots.footer?.()]):null})}));
vi.mock('../src/components/DeviceDetailTabs.vue',()=>({default:Vue.defineComponent({setup:(_p,{slots})=>()=>Vue.h('div',[slots.parameters?.(),slots.actions?.()])})}));
vi.mock('../src/composables/useDeviceKnowledgeSummary',()=>({useDeviceKnowledgeSummary:()=>({summary:Vue.ref(null),status:Vue.ref('ready'),error:Vue.ref(''),retry:()=>{}})}));
vi.mock('../src/components/AppTable.vue',()=>({default:Vue.defineComponent({props:['rows'],emits:['select'],setup:(p,{emit})=>()=>Vue.h('div',p.rows.map((row:any)=>Vue.h('button',{onClick:()=>emit('select',row)},row.id)))})}));
vi.mock('../src/components/MapCanvas.vue',()=>({default:Vue.defineComponent({inheritAttrs:false,setup:(_p,{expose})=>{expose({locate:()=>{},locateResource:()=>{},fit:()=>{}});return()=>Vue.h('map-probe');}})}));
vi.mock('../src/components/ResourceStatusPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceLedgerFilters.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DeviceNetworkPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/StatusBadge.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceStatusBadge.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceEditDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceImportDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceExportDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/SpectrumConfigPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisTaskPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisResourceTree.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisValidationPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisDiagnosisPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/InterferenceAnalysisPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/SituationMonitoringDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/MonitoringObjectPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/InterferenceHistoryDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/InterferenceMeasureDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/InterferenceSourceDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisDeviceClusterPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisResultLayerPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisDeviceLayerPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DeviceCoveragePanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceReadStatus.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/ResourceLedgerEditDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/ResourceLedgerImportDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/ResourceLedgerExportDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
// 共用详情入口使用客户端模板，原有业务断言保持实际组件接线。
await clientTemplate(GisObjectInfoPanel, 'src/components/GisObjectInfoPanel.vue', 'resource-ledger-render.ts');
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && (textOf(n).trim() === label || label === '配置演示' && textOf(n).trim() === '配置工作参数'));
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }


let app:App|undefined,pinia:ReturnType<typeof createPinia>;
beforeAll(async()=>{for(const [component,path] of [[AppShell,'src/layouts/AppShell.vue'],[ResourcesView,'src/views/ResourcesView.vue'],[ResourceLedgerTree,'src/components/ResourceLedgerTree.vue'],[SituationView,'src/views/SituationView.vue'],[ObjectInfoPanel,'src/components/ObjectInfoPanel.vue'],[DeviceInfoPanel,'src/components/DeviceInfoPanel.vue'],[DeviceConfigurationDrawer,'src/components/DeviceConfigurationDrawer.vue'],[DecisionDialog,'src/components/DecisionDialog.vue']] as const)await clientTemplate(component,path, 'resource-ledger-render.ts');});
beforeEach(()=>{class TestDocument extends EventTarget{activeElement=null;}vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());vi.stubGlobal('ShadowRoot',class{});});
afterEach(()=>{app?.unmount();if(pinia){useDeviceConfigurationStore(pinia).clearForSession();disposePinia(pinia);}vi.restoreAllMocks();vi.unstubAllGlobals();});
async function setup(page='ledger'){
 const storage=new TestStorage(),sessionStorage=new TestStorage();vi.stubGlobal('window',Object.assign(new EventTarget(),{localStorage:storage,sessionStorage,innerWidth:1920,innerHeight:1080}));
 pinia=createPinia();setActivePinia(pinia);const auth=authorizeStore(),raw=createMockService(()=>storage),preview=usePreviewStore();preview.data=await raw.loadPreview();let time=Date.parse('2026-10-16T00:00:00Z');
 Object.assign(raw,createDeviceConfigurationMock(()=>storage,()=>readResources(storage,initialResources()),details,()=>time));
 for(const [name,method] of Object.entries(raw))if(name!=='getSession')vi.spyOn(previewService as any,name).mockImplementation(method.bind(raw) as any);
 const router=createRouter({history:createMemoryHistory(),routes:[{path:'/resources',component:ResourcesView,meta:{title:'资源管理'}},{path:'/situation',component:SituationView,meta:{title:'GIS'}},...['/other','/planning','/diagnosis','/knowledge','/system'].map(path=>({path,component:{render:()=>h('div','其他页面')}}))]});
 await router.push(page==='ledger'?'/resources':'/situation?stationId=ND-0001&deviceId=DV-0001');await router.isReady();
 const root=node('root');app=renderer.createApp({setup(){useSessionAccess();return()=>h(AppShell);}});app.use(router);app.provide(ssrContextKey,{modules:new Set()});app.mount(root);await settle();
 return {root,router,auth,raw,storage,preview,config:useDeviceConfigurationStore(),editor:useResourceLedgerEditStore(),legacyEditor:useResourceEditStore(),gis:useGisWorkspaceStore(),advance:()=>{time+=DEVICE_CONFIGURATION_PHASE_MS*2;}};
}
async function enter(s:Awaited<ReturnType<typeof setup>>,page='ledger'){
 if(page==='ledger')await click(s.root,'DV-0001');else await click(s.root,'编辑资源');await settle();
 await click(s.root,'配置演示');await settle();expect(s.config.data?.deviceId).toBe('DV-0001');
}
async function defaults(s:Awaited<ReturnType<typeof setup>>){await click(s.root,'恢复默认');await click(s.root,'校验');expect(s.config.validation?.valid).toBe(true);}
describe('设备配置实际页面与现场保护',()=>{
 // 旧回执只能解释冻结请求，不能把下一次校验拒绝显示成成功。
 it('成功回执保留时，新输入校验拒绝显示未通过且后两步未执行',async()=>{
   const s=await setup();await enter(s);await defaults(s);await s.config.submit();s.advance();await s.config.queryHistory();await s.config.selectRecord(s.config.history!.items[0]!);
   s.config.scenario='validation-rejected';await click(s.root,'校验');
   const stages=find(s.root,n=>n.props['aria-label']==='配置三步进度')!;
   expect(textOf(stages)).toBe('校验：未通过下发：未执行回执：未执行');
   expect(textOf(s.root)).toContain('成功回执已记录');expect(s.config.result!.status).toBe('SUCCEEDED');
   expect(previewService.submitDeviceConfigurationReceipt).toHaveBeenCalledTimes(1);
 });
 it('准备失败重试先确认覆盖；取消保留新输入，确认才恢复失败参数',async()=>{
   const s=await setup();await enter(s);await defaults(s);s.config.scenario='receipt-failed';await s.config.validate();await s.config.submit();s.advance();await s.config.queryHistory();await s.config.selectRecord(s.config.history!.items[0]!);
   const parent=s.config.result!.operation!.id;s.config.frequency='15000';
   let action=click(s.root,'准备失败重试');await settle();expect(s.config.decision?.saveLabel).toBe('替换并准备重试');s.config.answer('cancel');await action;
   expect(s.config.frequency).toBe('15000');expect(s.config.retryOf).toBeUndefined();
   action=click(s.root,'准备失败重试');await settle();s.config.answer('save');await action;
   expect(s.config.frequency).toBe('10000');expect(s.config.retryOf).toBe(parent);expect(s.config.validated).toBe('');
 });
 it('上下架第二次确认取消仍保留配置，资源实际变更后才清理',async()=>{
   const s=await setup();await click(s.root,'DV-0001');await settle();
   // 捕获真实页面入口，模拟抽屉打开后仍到达的旧页面事件。
   const off=find(s.root,n=>n.tag==='button'&&textOf(n)==='下架设备')!.props.onClick as ()=>Promise<unknown>;
   await click(s.root,'配置演示');await click(s.root,'恢复默认');
   let action=off();await settle();s.config.answer('discard');await settle();expect(s.editor.decision?.title).toBe('下架设备');s.editor.answer('cancel');await action;
   expect(s.config.visible).toBe(true);expect(s.config.power).toBe('51.76');expect(s.preview.data!.resources.devices[0]!.availability).toBe('ACTIVE');
   action=off();await settle();s.config.answer('discard');await settle();s.editor.answer('save');await action;
   expect(s.config.visible).toBe(false);expect((await s.raw.loadPreview()).resources.devices[0]!.availability).toBe('OFF_SHELF');
 });
 it('服务未受理的网络失败先核实，明确未找到后用原请求编号重发',async()=>{
   const s=await setup();await enter(s);await defaults(s);vi.mocked(previewService.submitDeviceConfigurationReceipt).mockRejectedValueOnce(new Error('网络中断'));
   await s.config.submit();const requestId=s.config.pending!.requestId;expect(s.config.notFound).toBe(false);await click(s.root,'核实原请求');
   expect(s.config.notFound).toBe(true);await click(s.root,'用原请求编号重发');expect(s.config.pending).toBeNull();
   expect(s.config.result!.operation!.request.requestId).toBe(requestId);expect(s.config.result!.status).toBe('RUNNING');
   expect(vi.mocked(previewService.submitDeviceConfigurationReceipt).mock.calls.map(([r])=>r.requestId)).toEqual([requestId,requestId]);
 });
 it('台账详情懒加载；默认只填本次输入，成功回执不保存台账',async()=>{const s=await setup(),before=JSON.stringify(s.preview.data);expect(previewService.loadDeviceConfigurationContext).not.toHaveBeenCalled();await enter(s);await defaults(s);expect(s.config.power).toBe('51.76');expect(s.preview.data!.resources.devices[0]!.txPowerDbm).toBe(51.8);await click(s.root,'下发配置');expect(s.config.result!.status).toBe('RUNNING');expect(textOf(s.root)).toContain('下发：发送中');s.advance();await s.config.queryHistory();await s.config.selectRecord(s.config.history!.items[0]!);await settle();expect(textOf(s.root)).toContain('成功回执已记录');expect(previewService.commitResources).not.toHaveBeenCalled();expect(JSON.stringify(s.preview.data)).toBe(before);});
 it('失败记录可准备同参数新请求重试，原失败仍保留',async()=>{const s=await setup();await enter(s);await defaults(s);s.config.scenario='receipt-failed';await s.config.validate();await s.config.submit();const parent=s.config.result!.operation!.id;s.advance();await s.config.queryHistory();await s.config.selectRecord(s.config.history!.items[0]!);await s.config.prepareRetry();expect(s.config.retryOf).toBe(parent);await s.config.validate();await s.config.submit();expect(s.config.result!.operation!.request.retryOf).toBe(parent);expect(s.config.result!.operation!.id).not.toBe(parent);});
 it('提交响应丢失后不可盲发或关闭，退出清内存后按账号恢复原编号并核实',async()=>{const s=await setup();await enter(s);await defaults(s);s.config.scenario='reply-lost';await s.config.validate();await s.config.submit();const id=s.config.pending!.requestId;expect(await s.config.leave()).toBe(false);expect(s.config.visible).toBe(true);s.config.clearForSession();await s.config.open('ledger','DV-0001',true);expect(s.config.pending!.requestId).toBe(id);await s.config.verify();expect(s.config.pending).toBeNull();expect(s.config.result!.operation!.request.requestId).toBe(id);expect(previewService.submitDeviceConfigurationReceipt).toHaveBeenCalledTimes(1);});
 it.each(['X','Esc','遮罩','关闭'])('%s 关闭取消保留输入，放弃后才关闭',async label=>{const s=await setup();await enter(s);await click(s.root,'恢复默认');let action=click(s.root,label);await settle();s.config.answer('cancel');await action;expect(s.config.visible).toBe(true);expect(s.config.power).toBe('51.76');action=click(s.root,label);await settle();s.config.answer('discard');await action;expect(s.config.visible).toBe(false);});
 it('恢复默认替换已改内容前确认；空频率和非预设不提交',async()=>{const s=await setup();await enter(s);s.config.frequency='12345';let action=click(s.root,'恢复默认');await settle();s.config.answer('cancel');await action;expect(s.config.frequency).toBe('12345');await s.config.validate();expect(s.config.validated).toBe('');s.config.frequency='';await s.config.validate();expect(s.config.error).toContain('明确填写');expect(previewService.submitDeviceConfigurationReceipt).not.toHaveBeenCalled();});
 it('离页取消与后续资源确认取消均不丢配置输入',async()=>{const s=await setup();await enter(s);await click(s.root,'恢复默认');let navigation=s.router.push('/other');await settle();s.config.answer('cancel');await navigation;expect(s.router.currentRoute.value.path).toBe('/resources');expect(s.config.dirty).toBe(true);await s.editor.openForm('DV-0001');s.editor.form!.fields.txPowerDbm='50';navigation=s.router.push('/other');await settle();s.config.answer('discard');await settle();s.editor.answer('cancel');await navigation;expect(s.config.power).toBe('51.76');expect(s.router.currentRoute.value.path).toBe('/resources');});
  it('资源重置第二次确认取消保留配置输入',async()=>{const s=await setup();await enter(s);await defaults(s);await s.config.submit();s.advance();await s.config.queryHistory();await s.config.selectRecord(s.config.history!.items[0]!);s.config.frequency='15000';
    // 恢复入口迁入更多操作，仍经过原先的配置与资源两次确认。
    const menu=find(s.root,n=>n.tag==='details'&&n.props.class==='resource-more')!;
    expect(menu).toBeDefined();expect(textOf(menu)).toContain('更多操作');
    expect(find(menu,n=>n.tag==='button'&&textOf(n).trim()==='恢复初始资源')).toBeDefined();
    const reset=click(menu,'恢复初始资源');await settle();s.config.answer('discard');await settle();expect(s.legacyEditor.decision?.message).toContain('设备配置回执独立保留');s.legacyEditor.answer('cancel');await reset;expect(s.config.frequency).toBe('15000');expect(previewService.resetResourceData).not.toHaveBeenCalled();});
  it('台账资源重置写入失败保留配置与表单，显示失败原因',async()=>{
    const s=await setup();await enter(s);await defaults(s);s.config.frequency='15000';
    await s.editor.openForm('DV-0001');s.editor.form!.fields.antennaHeightM='19';
    const form=JSON.stringify(s.editor.form),preview=JSON.stringify(s.preview.data),resources=s.storage.getItem(RESOURCE_STORAGE_KEY);
    const menu=find(s.root,n=>n.tag==='details'&&n.props.class==='resource-more')!;
    s.storage.failWrite=true;
    // 两次确认均通过后才执行真实写入；失败不得提前清理任一编辑现场。
    const action=click(menu,'恢复初始资源');await settle();expect(s.config.decision).not.toBeNull();s.config.answer('discard');await settle();expect(s.legacyEditor.decision?.title).toBe('恢复初始资源');s.legacyEditor.answer('save');await action;await settle();
    expect(previewService.resetResourceData).toHaveBeenCalledOnce();expect(s.config.visible).toBe(true);expect(s.config.frequency).toBe('15000');
    expect(JSON.stringify(s.editor.form)).toBe(form);expect(JSON.stringify(s.preview.data)).toBe(preview);expect(s.storage.getItem(RESOURCE_STORAGE_KEY)).toBe(resources);expect(textOf(s.root)).toContain('存储');
  });
  it('GIS资源重置成功后清理编辑状态，设备配置持久回执保持原样',async()=>{
    const s=await setup('gis');await enter(s,'gis');await defaults(s);await s.config.submit();s.advance();await s.config.queryHistory();await s.config.selectRecord(s.config.history!.items[0]!);
    const records=s.storage.getItem(DEVICE_CONFIGURATION_STORAGE_KEY),resources=s.storage.getItem(RESOURCE_STORAGE_KEY);expect(records).not.toBeNull();expect(s.config.result!.status).toBe('SUCCEEDED');
    s.config.frequency='15000';await s.legacyEditor.openForm('device','DV-0001');s.legacyEditor.form!.fields.antennaHeightM='19';expect(s.legacyEditor.applyForm()).toBe(true);s.legacyEditor.form!.fields.antennaHeightM='20';expect(s.gis.undoStack.length).toBeGreaterThan(0);
    const menu=find(s.root,n=>n.tag==='details'&&n.props.class==='resource-more')!;
    // 成功回执后清理两类编辑与GIS历史，独立配置记录不随资源重置删除。
    const action=click(menu,'恢复初始资源');await settle();expect(s.config.decision).not.toBeNull();s.config.answer('discard');await settle();s.legacyEditor.answer('save');await action;await settle();
    expect(previewService.resetResourceData).toHaveBeenCalledOnce();expect(s.config.visible).toBe(false);expect(s.config.data).toBeNull();expect(s.config.frequency).toBe('');expect(s.legacyEditor.form).toBeNull();expect(s.editor.form).toBeNull();expect(s.gis.undoStack).toHaveLength(0);expect(s.gis.dirty).toBe(false);expect(s.preview.data).toBeNull();
    expect(s.storage.getItem(RESOURCE_STORAGE_KEY)).not.toBe(resources);expect(s.storage.getItem(DEVICE_CONFIGURATION_STORAGE_KEY)).toBe(records);
  });
  it('资源恢复不出现在独立业务模块，失权后的旧入口也不能调用',async()=>{
    const s=await setup(),restore=find(s.root,n=>n.tag==='button'&&textOf(n).trim()==='恢复初始资源')!;
    expect(restore).toBeDefined();
    for(const path of ['/diagnosis','/knowledge','/system','/planning']){
      await s.router.push(path);await settle();
      expect(find(s.root,n=>n.tag==='button'&&textOf(n).trim()==='恢复初始资源')).toBeUndefined();
    }
    // 保存旧事件后再改变页面与身份，壳层仍按当前权限和入口范围拒绝。
    await (restore.props.onClick as ()=>Promise<void>)();expect(s.legacyEditor.decision).toBeNull();
    await s.router.push('/resources');await settle();
    s.auth.accept({...s.auth.identity!,permissions:['resources.view']});await settle();
    await (restore.props.onClick as ()=>Promise<void>)();expect(s.legacyEditor.decision).toBeNull();
    expect(previewService.resetResourceData).not.toHaveBeenCalled();
  });
 it('GIS 浏览只读记录，编辑可配置；同路由切设备取消不改 query 或对象',async()=>{const s=await setup('gis');expect(find(s.root,n=>n.tag==='button'&&textOf(n)==='配置演示')).toBeUndefined();await enter(s,'gis');await click(s.root,'恢复默认');const navigation=s.router.push('/situation?stationId=ND-0001&deviceId=DV-0002');await settle();s.config.answer('cancel');await navigation;expect(s.router.currentRoute.value.query.deviceId).toBe('DV-0001');expect(s.config.deviceId).toBe('DV-0001');expect(s.config.power).toBe('51.76');});
 it('被动地图来源变化冻结保留，失权旧事件不能再提交',async()=>{const s=await setup('gis');await enter(s,'gis');await defaults(s);s.gis.mapMode='analysis';await settle();expect(s.config.locked).toBe(true);expect(s.config.power).toBe('51.76');expect(s.config.validated).toBe('');s.gis.mapMode='resource';s.auth.accept({...s.auth.identity!,permissions:['situation.view']});await settle();await s.config.submit();expect(previewService.submitDeviceConfigurationReceipt).not.toHaveBeenCalled();expect(s.config.visible).toBe(true);});
  it('GIS资源树返回先确认配置，取消保留来源及两份输入，放弃配置后只恢复资源现场',async()=>{
    const s=await setup('gis');await enter(s,'gis');await click(s.root,'恢复默认');
    await s.legacyEditor.openForm('device','DV-0001');s.legacyEditor.form!.fields.antennaHeightM='19';
    const form=JSON.stringify(s.legacyEditor.form),query={...s.router.currentRoute.value.query};
    s.gis.mapMode='monitoring';await settle();
    // 实际点击页签，不能以直接切 mapMode 绕过独立配置的关闭决策。
    let returning=click(s.root,'资源树');await settle();expect(s.config.decision).not.toBeNull();
    s.config.answer('cancel');await returning;expect(s.gis.mapMode).toBe('monitoring');
    expect(s.config.power).toBe('51.76');expect(s.config.visible).toBe(true);expect(JSON.stringify(s.legacyEditor.form)).toBe(form);
    returning=click(s.root,'资源树');await settle();s.config.answer('discard');await returning;
    expect(s.gis.mapMode).toBe('resource');expect(s.config.visible).toBe(false);
    expect(JSON.stringify(s.legacyEditor.form)).toBe(form);expect(s.legacyEditor.formDirty).toBe(true);
    expect(s.router.currentRoute.value.query).toEqual(query);expect(previewService.commitResources).not.toHaveBeenCalled();
  });
  it('GIS配置请求待核实时资源树不能切换来源、清理输入或重复下发',async()=>{
    const s=await setup('gis');await enter(s,'gis');await defaults(s);s.config.scenario='reply-lost';await s.config.validate();await s.config.submit();
    const request=JSON.stringify(s.config.pending),power=s.config.power,frequency=s.config.frequency;
    s.gis.mapMode='monitoring';await settle();await click(s.root,'资源树');
    expect(s.gis.mapMode).toBe('monitoring');expect(s.config.visible).toBe(true);
    expect(JSON.stringify(s.config.pending)).toBe(request);expect(s.config.error).toContain('尚待核实');
    expect(s.config.power).toBe(power);expect(s.config.frequency).toBe(frequency);
    expect(previewService.submitDeviceConfigurationReceipt).toHaveBeenCalledTimes(1);expect(previewService.commitResources).not.toHaveBeenCalled();
  });
 it('旧读取晚到不能覆盖新设备或会话',async()=>{const s=await setup();const current=await s.raw.loadDeviceConfigurationContext({context:'ledger',deviceId:'DV-0001'});let resolve!:(value:typeof current)=>void;vi.mocked(previewService.loadDeviceConfigurationContext).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const opening=s.config.open('ledger','DV-0001',true);await settle();s.config.clearForSession();await s.config.open('ledger','DV-0002',true);resolve(current);await opening;expect(s.config.data!.deviceId).toBe('DV-0002');});
});


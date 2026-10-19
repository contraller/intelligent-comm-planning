import { afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer,h,nextTick,ssrContextKey,type App,type Component,type ComponentOptions } from 'vue';
import { parse,compileScript,compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import { createMemoryHistory,createRouter } from 'vue-router';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
import { createMockService } from '../src/services/mock';
import { createDeviceConfigurationMock } from '../src/services/device-configuration-mock';
import { initialResources } from '../src/mocks/resource-presets';
import details from '../src/mocks/device-details.json';
import { readResources } from '../src/services/resource-storage';
import { previewService } from '../src/services';
import { useDeviceConfigurationStore } from '../src/stores/device-configuration';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { useSessionAccess } from '../src/composables/useSessionAccess';
import { DEVICE_CONFIGURATION_PHASE_MS } from '../src/config/demo';
import AppShell from '../src/layouts/AppShell.vue';
import DeviceConfigurationDrawer from '../src/components/DeviceConfigurationDrawer.vue';
import DeviceInfoPanel from '../src/components/DeviceInfoPanel.vue';
import ObjectInfoPanel from '../src/components/ObjectInfoPanel.vue';
import ResourcesView from '../src/views/ResourcesView.vue';
import SituationView from '../src/views/SituationView.vue';
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
vi.mock('../src/components/TaskWorkspacePanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
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
async function clientTemplate(component: Component, filename: string) {
  const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor;
  const bindings = compileScript(descriptor, { id: filename }).bindings;
  const result = compileTemplate({ source: descriptor.template!.content, filename, id: filename, compilerOptions: { mode: 'function', bindingMetadata: bindings } });
  if (result.errors.length) throw new Error(result.errors.map(String).join('\n'));
  const { code } = await transformWithEsbuild(`function createRender(Vue) { ${result.code} }`, 'resource-ledger-render.ts', { loader: 'ts' });
  (component as ComponentOptions).render = new Function('Vue', code + ';return createRender(Vue);')(Vue);
}
interface HostNode {
  tag: string; tagName: string; text: string; parent: HostNode | null; children: HostNode[];
  props: Record<string, unknown>; style: Record<string, string>; value?: unknown; readonly options: HostNode[];
  addEventListener: () => void; removeEventListener: () => void; getRootNode: () => Document;
}
const node = (tag: string, text = ''): HostNode => ({ tag, tagName: tag.toUpperCase(), text, parent: null, children: [], props: {}, style: {},
  get options() { return this.children.filter(child => child.tag === 'option'); },
  addEventListener() {}, removeEventListener() {}, getRootNode: () => document });
function remove(child: HostNode) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; }
function insert(child: HostNode, parent: HostNode, anchor?: HostNode | null) {
  remove(child); child.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1;
  parent.children.splice(i < 0 ? parent.children.length : i, 0, child);
}
const renderer = createRenderer<HostNode, HostNode>({
  insert, remove, createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (el, text) => { el.text = text; }, setElementText: (el, text) => { el.text = text; el.children = []; },
  parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp: (el, key, _old, value) => { el.props[key] = value; },
  insertStaticContent: (text, parent, anchor) => { const el = node('#static', text); insert(el, parent, anchor); return [el, el]; },
});
function find(root: HostNode, predicate: (n: HostNode) => boolean): HostNode | undefined {
  if (predicate(root)) return root;
  for (const child of root.children) { const hit = find(child, predicate); if (hit) return hit; }
}
function all(root: HostNode, predicate: (n: HostNode) => boolean): HostNode[] {
  return [...(predicate(root) ? [root] : []),...root.children.flatMap(child => all(child,predicate))];
}
const textOf = (root: HostNode): string => root.text.replace(/<[^>]+>/g, '') + root.children.map(textOf).join('');
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }


let app:App|undefined,pinia:ReturnType<typeof createPinia>;
beforeAll(async()=>{for(const [component,path] of [[AppShell,'src/layouts/AppShell.vue'],[ResourcesView,'src/views/ResourcesView.vue'],[SituationView,'src/views/SituationView.vue'],[ObjectInfoPanel,'src/components/ObjectInfoPanel.vue'],[DeviceInfoPanel,'src/components/DeviceInfoPanel.vue'],[DeviceConfigurationDrawer,'src/components/DeviceConfigurationDrawer.vue'],[DecisionDialog,'src/components/DecisionDialog.vue']] as const)await clientTemplate(component,path);});
beforeEach(()=>{class TestDocument extends EventTarget{activeElement=null;}vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());vi.stubGlobal('ShadowRoot',class{});});
afterEach(()=>{app?.unmount();if(pinia){useDeviceConfigurationStore(pinia).clearForSession();disposePinia(pinia);}vi.restoreAllMocks();vi.unstubAllGlobals();});
async function setup(page='ledger'){
 const storage=new TestStorage(),sessionStorage=new TestStorage();vi.stubGlobal('window',Object.assign(new EventTarget(),{localStorage:storage,sessionStorage,innerWidth:1920,innerHeight:1080}));
 pinia=createPinia();setActivePinia(pinia);const auth=authorizeStore(),raw=createMockService(()=>storage),preview=usePreviewStore();preview.data=await raw.loadPreview();let time=Date.parse('2026-10-16T00:00:00Z');
 Object.assign(raw,createDeviceConfigurationMock(()=>storage,()=>readResources(storage,initialResources()),details,()=>time));
 for(const [name,method] of Object.entries(raw))if(name!=='getSession')vi.spyOn(previewService as any,name).mockImplementation(method as any);
 const router=createRouter({history:createMemoryHistory(),routes:[{path:'/resources',component:ResourcesView,meta:{title:'资源管理'}},{path:'/situation',component:SituationView,meta:{title:'GIS'}},...['/other','/planning','/diagnosis','/knowledge','/system'].map(path=>({path,component:{render:()=>h('div','其他页面')}}))]});
 await router.push(page==='ledger'?'/resources':'/situation?stationId=ND-0001&deviceId=DV-0001');await router.isReady();
 const root=node('root');app=renderer.createApp({setup(){useSessionAccess();return()=>h(AppShell);}});app.use(router);app.provide(ssrContextKey,{modules:new Set()});app.mount(root);await settle();
 return {root,router,auth,raw,storage,preview,config:useDeviceConfigurationStore(),editor:useResourceEditStore(),gis:useGisWorkspaceStore(),advance:()=>{time+=DEVICE_CONFIGURATION_PHASE_MS*2;}};
}
async function enter(s:Awaited<ReturnType<typeof setup>>,page='ledger'){
 if(page==='ledger')await click(s.root,'DV-0001');else await click(s.root,'编辑');await settle();
 await click(s.root,'配置演示');await settle();expect(s.config.data?.deviceId).toBe('DV-0001');
}
async function defaults(s:Awaited<ReturnType<typeof setup>>){await click(s.root,'恢复默认（演示）');await click(s.root,'校验');expect(s.config.validation?.valid).toBe(true);}
describe('设备配置实际页面与现场保护',()=>{
 // 旧回执只能解释冻结请求，不能把下一次校验拒绝显示成成功。
 it('成功回执保留时，新输入校验拒绝显示未通过且后两步未执行',async()=>{
   const s=await setup();await enter(s);await defaults(s);await s.config.submit();s.advance();await s.config.queryHistory();await s.config.selectRecord(s.config.history!.items[0]!);
   s.config.scenario='validation-rejected';await click(s.root,'校验');
   const stages=find(s.root,n=>n.props['aria-label']==='配置三步进度')!;
   expect(textOf(stages)).toBe('校验：未通过模拟下发：未执行回执：未执行');
   expect(textOf(s.root)).toContain('成功回执已记录');expect(s.config.result!.status).toBe('SUCCEEDED');
   expect(previewService.submitDeviceConfiguration).toHaveBeenCalledTimes(1);
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
   await click(s.root,'配置演示');await click(s.root,'恢复默认（演示）');
   let action=off();await settle();s.config.answer('discard');await settle();expect(s.editor.decision?.title).toBe('下架设备');s.editor.answer('cancel');await action;
   expect(s.config.visible).toBe(true);expect(s.config.power).toBe('51.76');expect(s.preview.data!.resources.devices[0]!.availability).toBe('ACTIVE');
   action=off();await settle();s.config.answer('discard');await settle();s.editor.answer('save');await action;
   expect(s.config.visible).toBe(false);expect(s.preview.data!.resources.devices[0]!.availability).toBe('OFF_SHELF');
 });
 it('服务未受理的网络失败先核实，明确未找到后用原请求编号重发',async()=>{
   const s=await setup();await enter(s);await defaults(s);vi.mocked(previewService.submitDeviceConfiguration).mockRejectedValueOnce(new Error('网络中断'));
   await s.config.submit();const requestId=s.config.pending!.requestId;expect(s.config.notFound).toBe(false);await click(s.root,'核实原请求');
   expect(s.config.notFound).toBe(true);await click(s.root,'用原请求编号重发');expect(s.config.pending).toBeNull();
   expect(s.config.result!.operation!.request.requestId).toBe(requestId);expect(s.config.result!.status).toBe('RUNNING');
   expect(vi.mocked(previewService.submitDeviceConfiguration).mock.calls.map(([r])=>r.requestId)).toEqual([requestId,requestId]);
 });
 it('台账详情懒加载；默认只填本次输入，成功回执不保存台账',async()=>{const s=await setup(),before=JSON.stringify(s.preview.data);expect(previewService.loadDeviceConfigurationContext).not.toHaveBeenCalled();await enter(s);await defaults(s);expect(s.config.power).toBe('51.76');expect(s.preview.data!.resources.devices[0]!.txPowerDbm).toBe(51.8);await click(s.root,'模拟下发');expect(s.config.result!.status).toBe('RUNNING');expect(textOf(s.root)).toContain('模拟下发：发送中');s.advance();await s.config.queryHistory();await s.config.selectRecord(s.config.history!.items[0]!);await settle();expect(textOf(s.root)).toContain('成功回执已记录');expect(previewService.commitResources).not.toHaveBeenCalled();expect(JSON.stringify(s.preview.data)).toBe(before);});
 it('失败记录可准备同参数新请求重试，原失败仍保留',async()=>{const s=await setup();await enter(s);await defaults(s);s.config.scenario='receipt-failed';await s.config.validate();await s.config.submit();const parent=s.config.result!.operation!.id;s.advance();await s.config.queryHistory();await s.config.selectRecord(s.config.history!.items[0]!);await s.config.prepareRetry();expect(s.config.retryOf).toBe(parent);await s.config.validate();await s.config.submit();expect(s.config.result!.operation!.request.retryOf).toBe(parent);expect(s.config.result!.operation!.id).not.toBe(parent);});
 it('提交响应丢失后不可盲发或关闭，退出清内存后按账号恢复原编号并核实',async()=>{const s=await setup();await enter(s);await defaults(s);s.config.scenario='reply-lost';await s.config.validate();await s.config.submit();const id=s.config.pending!.requestId;expect(await s.config.leave()).toBe(false);expect(s.config.visible).toBe(true);s.config.clearForSession();await s.config.open('ledger','DV-0001',true);expect(s.config.pending!.requestId).toBe(id);await s.config.verify();expect(s.config.pending).toBeNull();expect(s.config.result!.operation!.request.requestId).toBe(id);expect(previewService.submitDeviceConfiguration).toHaveBeenCalledTimes(1);});
 it.each(['X','Esc','遮罩','关闭'])('%s 关闭取消保留输入，放弃后才关闭',async label=>{const s=await setup();await enter(s);await click(s.root,'恢复默认（演示）');let action=click(s.root,label);await settle();s.config.answer('cancel');await action;expect(s.config.visible).toBe(true);expect(s.config.power).toBe('51.76');action=click(s.root,label);await settle();s.config.answer('discard');await action;expect(s.config.visible).toBe(false);});
 it('恢复默认替换已改内容前确认；空频率和非预设不提交',async()=>{const s=await setup();await enter(s);s.config.frequency='12345';let action=click(s.root,'恢复默认（演示）');await settle();s.config.answer('cancel');await action;expect(s.config.frequency).toBe('12345');await s.config.validate();expect(s.config.validated).toBe('');s.config.frequency='';await s.config.validate();expect(s.config.error).toContain('明确填写');expect(previewService.submitDeviceConfiguration).not.toHaveBeenCalled();});
 it('离页取消与后续资源确认取消均不丢配置输入',async()=>{const s=await setup();await enter(s);await click(s.root,'恢复默认（演示）');let navigation=s.router.push('/other');await settle();s.config.answer('cancel');await navigation;expect(s.router.currentRoute.value.path).toBe('/resources');expect(s.config.dirty).toBe(true);await s.editor.openForm('device','DV-0001','ledger');s.editor.form!.fields.txPowerDbm='50';navigation=s.router.push('/other');await settle();s.config.answer('discard');await settle();s.editor.answer('cancel');await navigation;expect(s.config.power).toBe('51.76');expect(s.router.currentRoute.value.path).toBe('/resources');});
 it('资源重置第二次确认取消保留配置；确认后回执独立保留',async()=>{const s=await setup();await enter(s);await defaults(s);await s.config.submit();s.advance();await s.config.queryHistory();await s.config.selectRecord(s.config.history!.items[0]!);s.config.frequency='15000';const reset=click(s.root,'重置资源演示数据');await settle();s.config.answer('discard');await settle();expect(s.editor.decision?.message).toContain('设备配置回执独立保留');s.editor.answer('cancel');await reset;expect(s.config.frequency).toBe('15000');expect(previewService.resetResources).not.toHaveBeenCalled();});
 it('GIS 浏览只读记录，编辑可配置；同路由切设备取消不改 query 或对象',async()=>{const s=await setup('gis');expect(find(s.root,n=>n.tag==='button'&&textOf(n)==='配置演示')).toBeUndefined();await enter(s,'gis');await click(s.root,'恢复默认（演示）');const navigation=s.router.push('/situation?stationId=ND-0001&deviceId=DV-0002');await settle();s.config.answer('cancel');await navigation;expect(s.router.currentRoute.value.query.deviceId).toBe('DV-0001');expect(s.config.deviceId).toBe('DV-0001');expect(s.config.power).toBe('51.76');});
 it('被动地图来源变化冻结保留，失权旧事件不能再提交',async()=>{const s=await setup('gis');await enter(s,'gis');await defaults(s);s.gis.mapMode='analysis';await settle();expect(s.config.locked).toBe(true);expect(s.config.power).toBe('51.76');expect(s.config.validated).toBe('');s.gis.mapMode='resource';s.auth.accept({...s.auth.identity!,permissions:['situation.view']});await settle();await s.config.submit();expect(previewService.submitDeviceConfiguration).not.toHaveBeenCalled();expect(s.config.visible).toBe(true);});
 it('旧读取晚到不能覆盖新设备或会话',async()=>{const s=await setup();const current=await s.raw.loadDeviceConfigurationContext({context:'ledger',deviceId:'DV-0001'});let resolve!:(value:typeof current)=>void;vi.mocked(previewService.loadDeviceConfigurationContext).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const opening=s.config.open('ledger','DV-0001',true);await settle();s.config.clearForSession();await s.config.open('ledger','DV-0002',true);resolve(current);await opening;expect(s.config.data!.deviceId).toBe('DV-0002');});
});


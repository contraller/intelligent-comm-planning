import { useResourceReadStore } from '../src/stores/resource-read';
import { afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import * as Vue from 'vue';
import { h,nextTick,ssrContextKey,type App } from 'vue';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import { createMemoryHistory,createRouter,RouterView } from 'vue-router';
import { authorizeStore } from './helpers/auth';
import { interferenceFixture } from './helpers/interference';
import { createMockService } from '../src/services/mock';
import { previewService } from '../src/services';
import { usePreviewStore } from '../src/stores/preview';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { useTaskInputStore } from '../src/stores/task-input';
import { useInterferenceStore } from '../src/stores/interference';
import { useDeviceConfigurationStore } from '../src/stores/device-configuration';
import SituationView from '../src/views/SituationView.vue';
import InterferenceAnalysisPanel from '../src/components/InterferenceAnalysisPanel.vue';
import InterferenceMeasureDrawer from '../src/components/InterferenceMeasureDrawer.vue';
// 同型编译与基础宿主复用公共工具，业务夹具和生命周期保持本地。
import { clientTemplate, node, renderer, find, all, textOf, type HostNode } from './helpers/vue-client';
const probe=vi.hoisted(()=>({locates:[] as any[]}));
vi.mock('../src/components/MapCanvas.vue',()=>({default:Vue.defineComponent({inheritAttrs:false,props:['stations','links','selectedId','selectedLinkId','showLinks','topologyOpacity'],setup:(p,{expose})=>{
  expose({locate:()=>probe.locates.push(JSON.parse(JSON.stringify(p))),locateResource:()=>{},fitDeviceCoverage:()=>{}});
  return()=>Vue.h('map-probe',{...p});}})}));
vi.mock('../src/components/AppDrawer.vue',()=>({default:Vue.defineComponent({props:['visible'],setup:(p,{slots})=>()=>p.visible?Vue.h('aside',[slots.default?.(),slots.footer?.()]):null})}));
vi.mock('../src/components/ObjectInfoPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisResourceTree.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisDeviceLayerPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisResultLayerPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DeviceCoveragePanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisDeviceClusterPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceStatusPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/SituationMonitoringDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/MonitoringObjectPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/InterferenceHistoryDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/InterferenceSourceDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceExportDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/StatusBadge.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }



let app:App|undefined,pinia:ReturnType<typeof createPinia>|undefined;
beforeAll(async()=>{for(const [component,path]of [[SituationView,'src/views/SituationView.vue'],[InterferenceAnalysisPanel,'src/components/InterferenceAnalysisPanel.vue'],[InterferenceMeasureDrawer,'src/components/InterferenceMeasureDrawer.vue']] as const)await clientTemplate(component,path, 'resource-ledger-render.ts');});
beforeEach(()=>{vi.useFakeTimers();vi.stubGlobal('window',new EventTarget());class TestDocument extends EventTarget{activeElement=null;hidden=false;}vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());vi.stubGlobal('ShadowRoot',class{});probe.locates=[];});
afterEach(()=>{app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
async function setup(){
  const f=await interferenceFixture(),submitted=await f.submit();f.advance();
  const view=await f.service.getInterferenceAnalysis(submitted.view.run.analysisId);
  pinia=createPinia();setActivePinia(pinia);const auth=authorizeStore();
  const raw=createMockService(()=>f.storage);
  // 入口全部读取同一份教学存储，身份由本测试明确注入。
  for(const [key,method]of Object.entries(raw))if(key!=='getSession')vi.spyOn(previewService as any,key).mockImplementation(method.bind(raw) as any);
  await usePreviewStore().load();await useResourceReadStore().activate('gis');await useGisWorkspaceStore().loadScene();
  const router=createRouter({history:createMemoryHistory(),routes:[{path:'/situation',component:SituationView},{path:'/planning',component:{render:()=>null}},{path:'/elsewhere',component:{render:()=>null}}]});
  app=renderer.createApp({render:()=>h(RouterView)});app.use(pinia);app.use(router);app.provide(ssrContextKey,{modules:new Set()});
  await router.push('/situation?stationId=ND-0001');await router.isReady();const root=node('root');app.mount(root);await settle();await settle();
  const store=useInterferenceStore();store.views=[view];store.analysisId=view.run.analysisId;
  // 措施定位只核对当前任务草稿是否保持，不触发任务初始化或保存。
  const planning=useTaskInputStore();planning.draft=structuredClone(f.plan.workflow!.input);
  await click(root,'干扰分析');probe.locates=[];
  const card=(id='NODE_REDEPLOY')=>find(root,n=>n.props['data-measure-id']===id)!;
  const button=(id='NODE_REDEPLOY',kind='节点')=>find(card(id),n=>n.tag==='button'&&textOf(n).startsWith('定位'+kind))!;
  return{...f,root,router,auth,store,planning,gis:useGisWorkspaceStore(),editor:useResourceEditStore(),configuration:useDeviceConfigurationStore(),card,button};
}
async function trigger(button:HostNode){expect(button).toBeDefined();expect(button.props.disabled).toBe(false);await(button.props.onClick as Function)();await settle();}
const map=(root:HostNode)=>find(root,n=>n.tag==='map-probe')!.props;
describe('措施定位的真实 GIS 入口',()=>{
 it('清单定位措施前节点和链路，同一目标可反复定位且不发业务请求',async()=>{
  const s=await setup(),before=JSON.stringify(s.store.selected),storage=[...s.storage.entries];
  await trigger(s.button());expect(s.gis.mapMode).toBe('analysis');expect(map(s.root).selectedId).toBe('ND-0004');
  expect(probe.locates.at(-1).stations.find((n:any)=>n.id==='ND-0004').coordinate).toEqual(s.plan.inputSnapshot.stations.find(n=>n.id==='ND-0004')!.coordinate);
  await trigger(s.button());expect(probe.locates).toHaveLength(2);
  await trigger(s.button('FREQ_ADJUST','链路'));expect(map(s.root).selectedLinkId).toBe('LINK-B');expect(map(s.root).selectedId).toBe('');
  expect(JSON.stringify(s.store.selected)).toBe(before);expect([...s.storage.entries]).toEqual(storage);
  for(const method of ['submitInterferenceAnalysis','adoptInterferenceMeasure','saveResources','getInterferenceAnalysis'])if(vi.isMockFunction((previewService as any)[method]))expect((previewService as any)[method]).not.toHaveBeenCalled();
 });
 it('抽屉目标跟随实际措施后坐标，成功收起，清单再定位恢复措施前',async()=>{
  const s=await setup();await(find(s.card(),n=>n.tag==='button')!.props.onClick as Function)();await settle();
  await click(s.root,'地图查看措施后');expect(textOf(find(s.root,n=>n.tag==='aside'&&textOf(n).includes('关联对象'))!)).toContain('ND-0004');
  await click(s.root,'定位节点（措施后）');expect(s.store.measureOpen).toBe(false);expect(s.store.effectiveAfter).toBe(true);
  expect(probe.locates.at(-1).stations.find((n:any)=>n.id==='ND-0004').coordinate).toEqual([114.31,37.26]);
  await trigger(s.button());expect(s.store.effectiveAfter).toBe(false);expect(probe.locates.at(-1).stations.find((n:any)=>n.id==='ND-0004').coordinate).not.toEqual([114.31,37.26]);
 });
 it('历史网络和隐藏拓扑仍可定位，保留透明度、显隐和影响筛选',async()=>{
  const s=await setup();s.store.selected!.source={state:'HISTORICAL',reasons:['源版本已变更']};s.store.levels=['MINOR'];await settle();
  await trigger(s.button());await click(s.root,'图层管理');
  const visibility=find(s.root,n=>n.props['aria-label']==='显示规划后链路')!,opacity=find(s.root,n=>n.props['aria-label']==='拓扑透明度')!;
  (visibility.props.onChange as Function)({target:{checked:false}});(opacity.props.onInput as Function)({target:{value:'0'}});await settle();
  await trigger(s.button('FREQ_ADJUST','链路'));expect(map(s.root).showLinks).toBe(false);expect(map(s.root).topologyOpacity).toBe(0);expect(s.store.levels).toEqual(['MINOR']);expect(textOf(s.root)).toContain('拓扑当前隐藏');
 });
 it('同时返回两目标时各有入口；缺目标、端点或坐标只禁用相关定位',async()=>{
  const s=await setup(),m=s.store.selected!.result!.measures.find(r=>r.id==='NODE_REDEPLOY')!;m.targetLinkId='LINK-B';await settle();
  expect(all(s.card(),n=>n.tag==='button'&&textOf(n).startsWith('定位'))).toHaveLength(2);
  m.targetNodeId=null;m.targetLinkId=null;await settle();expect(textOf(s.card())).toContain('未提供定位对象');
  m.targetNodeId='UNKNOWN';m.targetLinkId='LINK-B';s.store.selected!.run.network.links.find(r=>r.id==='LINK-B')!.a='UNKNOWN';await settle();
  expect(s.button().props.disabled).toBe(true);expect(textOf(s.card())).toContain('链路缺少唯一的两端节点');
  m.targetNodeId='ND-0004';s.store.selected!.run.network.inputSnapshot.stations.find(n=>n.id==='ND-0004')!.coordinate=[NaN,20];await settle();
  expect(textOf(s.card())).toContain('节点坐标无效');expect(probe.locates).toHaveLength(0);
 });
 it('缺完整后态时沿原回退显示措施前定位',async()=>{
  const s=await setup();s.store.inspectMeasure(s.store.selected!.result!.measures.find(r=>r.id==='NODE_REDEPLOY')!);
  (s.store.selected!.measurePreviews!.find(r=>r.measureId==='NODE_REDEPLOY') as any).result=null;s.store.after=true;await settle();
  expect(s.store.effectiveAfter).toBe(false);expect(textOf(s.root)).toContain('未提供完整措施预览');
  await click(s.root,'定位节点（措施前）');expect(probe.locates.at(-1).stations.find((n:any)=>n.id==='ND-0004').coordinate).not.toEqual([114.31,37.26]);
 });
  it.each(['配置','表单','资源草稿','导入','取点','忙态'])('%s存在时不改变输入或切图',async(kind)=>{
  const s=await setup();const old=s.button().props.onClick as Function;
  if(kind==='配置')s.configuration.visible=true;
  if(kind==='表单'){await s.gis.begin();await s.editor.openForm('device','DV-0001');}
  if(kind==='资源草稿'){await s.gis.begin();s.editor.draft!.stations[0].name='保留资源输入';}
  if(kind==='导入')s.editor.importOpen=true;
  if(kind==='取点')s.editor.picking=true;
  if(kind==='忙态')s.gis.busy=true;
  await settle();const before=JSON.stringify([s.editor.form,s.editor.draft,s.planning.draft]),mode=s.gis.mapMode;
  expect(s.button().props.disabled).toBe(true);await old();await(s.button().props.onClick as Function)();
  expect(s.gis.mapMode).toBe(mode);expect(probe.locates).toHaveLength(0);expect(JSON.stringify([s.editor.form,s.editor.draft,s.planning.draft])).toBe(before);
 });
  it('规划草稿不阻塞只读措施定位，定位不保存或改写该草稿',async()=>{
    const s=await setup();s.planning.draft={...JSON.parse(JSON.stringify(s.plan.workflow!.input)),name:'保留规划草稿'};
    await settle();const before=JSON.stringify(s.planning.draft);
    expect(s.button().props.disabled).toBe(false);
    await (s.button().props.onClick as Function)();await settle();
    expect(probe.locates).toHaveLength(1);expect(JSON.stringify(s.planning.draft)).toBe(before);
  });
 it.each(['权限往返','同ID替换','内容往返','模式往返','措施往返','会话'])('%s后旧按钮不能定位',async(kind)=>{
  const s=await setup(),old=s.button().props.onClick as Function;
  if(kind==='权限往返'){const permissions=[...s.auth.identity!.permissions];s.auth.identity!.permissions=permissions.filter(p=>p!=='planning.view');s.auth.identity!.permissions=permissions;}
  if(kind==='同ID替换')s.store.views=[JSON.parse(JSON.stringify(s.store.selected))];
  if(kind==='内容往返'){const m=s.store.selected!.result!.measures[0];m.title+='改';m.title=m.title.slice(0,-1);}
  if(kind==='模式往返'){s.gis.mapMode='analysis';s.gis.mapMode='resource';}
  if(kind==='措施往返'){s.store.measureId='NODE_REDEPLOY';s.store.measureId='';}
  if(kind==='会话'){s.auth.identity!.sessionId='new-session';}
  await old();await settle();expect(probe.locates).toHaveLength(0);
 });
 it('nextTick期间换网络或离页后不执行迟到地图定位',async()=>{
  const s=await setup(),pending=(s.button().props.onClick as Function)();
  s.store.views=[JSON.parse(JSON.stringify(s.store.selected))];await pending;expect(probe.locates).toHaveLength(0);
  await settle();const old=s.button().props.onClick as Function;await s.router.push('/elsewhere');await old();expect(probe.locates).toHaveLength(0);
 });
});


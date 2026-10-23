import {afterEach,describe,it,expect,vi} from 'vitest';
import {createRenderer,h,reactive,nextTick,type App} from 'vue';
import {createPinia,setActivePinia,disposePinia} from 'pinia';
import {authorizeStore} from './helpers/auth';
import {previewService} from '../src/services';
import {useDeviceMaintenance} from '../src/composables/useDeviceMaintenance';
import {useDeviceNetworkDetail} from '../src/composables/useDeviceNetworkDetail';
import * as Vue from 'vue';
import {clientTemplate} from './helpers/vue-client';
import DeviceTraceDrawer from '../src/components/DeviceTraceDrawer.vue';
import DeviceRestorePreview from '../src/components/DeviceRestorePreview.vue';
import {initialResources} from '../src/mocks/resource-presets';
import {deviceChanges} from '../src/services/device-maintenance';
import type {DeviceHistory,DeviceHistorySummary,DeviceRestorePreview as RestorePreview} from '../src/types/device-maintenance';
import type {ConfigurationOperationResult} from '../src/types/device-configuration';
import type {PageResult} from '../src/types/data-access';
// 展示测试挂载实际模板；只替换抽屉外壳，保留追溯与恢复预览的全部内容及事件。
vi.mock('../src/components/AppDrawer.vue',()=>({default:Vue.defineComponent({props:['visible','width'],setup:(p,{slots})=>()=>p.visible?Vue.h('aside',{'data-width':p.width},slots.default?.()):null})}));
for(const [filename,component] of [['src/components/DeviceTraceDrawer.vue',DeviceTraceDrawer],['src/components/DeviceRestorePreview.vue',DeviceRestorePreview]] as const){
  // 模板编译错误统一由公共编译器立即抛出。
  await clientTemplate(component,filename,'trace-render.ts');
}
// 挂载组合函数以检查真实 watcher、取消和异步续读，不执行页面 DOM。
const renderer=createRenderer<any,any>({insert(){},remove(){},createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null,patchProp(){}});
let app:App|undefined,pinia:ReturnType<typeof createPinia>;
afterEach(()=>{app?.unmount();if(pinia)disposePinia(pinia);vi.restoreAllMocks();});
function setup(){
  pinia=createPinia();setActivePinia(pinia);const auth=authorizeStore(),binding=reactive({current:{deviceId:'DV-0001',revision:'same',context:'ledger' as const}});
  let trace!:ReturnType<typeof useDeviceMaintenance>,network!:ReturnType<typeof useDeviceNetworkDetail>;
  app=renderer.createApp({setup(){trace=useDeviceMaintenance(()=>binding.current);network=useDeviceNetworkDetail(()=>binding.current);return()=>h('div');}});app.use(pinia);app.mount({});return{auth,binding,trace,network};
}
describe('追溯和下钻的对象归属',()=>{
  it.each(['close','device','session'])('历史首段迟到后停止配置续读：%s',async kind=>{
    const s=setup();let finish!:(value:any)=>void;
    vi.spyOn(previewService,'queryDeviceHistory').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const configurations=vi.spyOn(previewService,'queryDeviceConfigurationHistory');
    const pending=s.trace.openHistory();
    if(kind==='close')s.trace.cancel();else if(kind==='device')s.binding.current={...s.binding.current,deviceId:'DV-0002'};else s.auth.accept({...s.auth.identity!,sessionId:'other-trace'});
    await nextTick();finish({items:[],total:0,pageNum:1,pageSize:20});await pending;
    expect(configurations).not.toHaveBeenCalled();expect(s.trace.history.value).toBeNull();
  });
  it('同值绑定对象重建不取消下钻或清除追溯，真正换设备才清除',async()=>{
    const s=setup();vi.spyOn(previewService,'queryDeviceHistory').mockResolvedValue({items:[],total:0,pageNum:1,pageSize:20} as never);
    vi.spyOn(previewService,'getDeviceNetworkDetail').mockResolvedValue({snapshotId:'snapshot'} as never);
    await s.trace.loadHistory();await s.network.open('link','L','snapshot');s.binding.current={...s.binding.current};await nextTick();
    expect(s.trace.history.value).not.toBeNull();expect(s.network.active.value).toBe(true);expect(s.network.data.value?.snapshotId).toBe('snapshot');
    s.binding.current={...s.binding.current,deviceId:'DV-0002'};await nextTick();expect(s.trace.history.value).toBeNull();expect(s.network.active.value).toBe(false);
  });
});

function historyRecords(){
  const before=initialResources().devices.find(device=>device.id==='DV-0001')!,after={...structuredClone(before),currentWorkMode:'MOCK_FIXED'};
  const common={deviceId:before.id,epoch:'epoch',time:'2026-10-21T13:52:55.659Z',requestId:null,restoredFrom:null};
  const baseline:DeviceHistory={...common,id:'baseline',revision:'initial',previousRevision:'initial',actor:null,source:'首次留存的变更前快照',before:null,after:before,changes:deviceChanges(null,before)};
  const changed:DeviceHistory={...common,id:'changed',revision:'revision-1',previousRevision:'initial',actor:{id:'admin',name:'演示管理员',roleId:'role',roleName:'管理员'},source:'资源维护',before,after,changes:deviceChanges(before,after)};
  const summary=({before:_before,after:_after,changes,...rest}:DeviceHistory):DeviceHistorySummary=>({...rest,fields:changes.map(change=>change.field)});
  const page:PageResult<DeviceHistorySummary>={items:[summary(baseline),summary(changed)],total:2,pageNum:1,pageSize:20};
  return {baseline,changed,page};
}

describe('追溯首开默认选择',()=>{
  it('跳过基线并只读取最近真实变更正文，刷新仍默认选择，翻页不自动读取',async()=>{
    const s=setup(),{page,changed}=historyRecords();
    vi.spyOn(previewService,'queryDeviceHistory').mockResolvedValue(page);
    vi.spyOn(previewService,'queryDeviceConfigurationHistory').mockResolvedValue({...page,items:[],total:0});
    const details=vi.spyOn(previewService,'getDeviceHistory').mockResolvedValue(changed);
    await s.trace.openHistory();expect(details).toHaveBeenCalledTimes(1);expect(details.mock.calls[0]![0].historyId).toBe('changed');expect(s.trace.record.value?.id).toBe('changed');
    await s.trace.openHistory();expect(details).toHaveBeenCalledTimes(2);
    await s.trace.loadHistory(2);expect(details).toHaveBeenCalledTimes(2);expect(s.trace.record.value).toBeNull();
  });
  it('只有基线时显示留存状态，没有记录时不读正文',async()=>{
    const s=setup(),{page,baseline}=historyRecords();
    const query=vi.spyOn(previewService,'queryDeviceHistory').mockResolvedValue({...page,items:[page.items[0]!],total:1});
    vi.spyOn(previewService,'queryDeviceConfigurationHistory').mockResolvedValue({...page,items:[],total:0});
    const details=vi.spyOn(previewService,'getDeviceHistory').mockResolvedValue(baseline);
    await s.trace.openHistory();expect(s.trace.record.value?.id).toBe('baseline');
    query.mockResolvedValue({...page,items:[],total:0});await s.trace.openHistory();expect(details).toHaveBeenCalledTimes(1);expect(s.trace.record.value).toBeNull();
  });
  it.each(['close','device','session'])('配置摘要迟到后不继续读取正文：%s',async kind=>{
    const s=setup(),{page}=historyRecords();let finish!:(value:any)=>void;
    vi.spyOn(previewService,'queryDeviceHistory').mockResolvedValue(page);
    vi.spyOn(previewService,'queryDeviceConfigurationHistory').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const details=vi.spyOn(previewService,'getDeviceHistory'),pending=s.trace.openHistory();
    await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
    if(kind==='close')s.trace.cancel();else if(kind==='device')s.binding.current={...s.binding.current,deviceId:'DV-0002'};else s.auth.accept({...s.auth.identity!,sessionId:'other-configuration'});
    await nextTick();finish({...page,items:[],total:0});await pending;expect(details).not.toHaveBeenCalled();
  });
  it.each(['close','device','session'])('默认正文迟到不能污染已关闭或已切换上下文：%s',async kind=>{
    const s=setup(),{page,changed}=historyRecords();let finish!:(value:DeviceHistory)=>void;
    vi.spyOn(previewService,'queryDeviceHistory').mockResolvedValue(page);
    vi.spyOn(previewService,'queryDeviceConfigurationHistory').mockResolvedValue({...page,items:[],total:0});
    vi.spyOn(previewService,'getDeviceHistory').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const pending=s.trace.openHistory();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
    if(kind==='close')s.trace.cancel();else if(kind==='device')s.binding.current={...s.binding.current,deviceId:'DV-0002'};else s.auth.accept({...s.auth.identity!,sessionId:'other-detail'});
    await nextTick();finish(changed);await pending;expect(s.trace.record.value).toBeNull();
  });
  it('配置摘要失败仍能默认查看台账，并保留失败提示',async()=>{
    const s=setup(),{page,changed}=historyRecords();
    vi.spyOn(previewService,'queryDeviceHistory').mockResolvedValue(page);
    vi.spyOn(previewService,'queryDeviceConfigurationHistory').mockRejectedValue(new Error('配置记录读取失败'));
    vi.spyOn(previewService,'getDeviceHistory').mockResolvedValue(changed);
    await s.trace.openHistory();expect(s.trace.record.value?.id).toBe('changed');expect(s.trace.error.value).toBe('配置记录读取失败');
  });
});

type HostNode={tag:string;text:string;children:HostNode[];parent:HostNode|null;props:Record<string,any>};
const hostNode=(tag:string,text=''):HostNode=>({tag,text,children:[],parent:null,props:{}});
const removeHost=(node:HostNode)=>{if(node.parent)node.parent.children.splice(node.parent.children.indexOf(node),1);node.parent=null;};
const insertHost=(node:HostNode,parent:HostNode,anchor?:HostNode|null)=>{removeHost(node);node.parent=parent;const index=anchor?parent.children.indexOf(anchor):-1;parent.children.splice(index<0?parent.children.length:index,0,node);};
const templateRenderer=Vue.createRenderer<HostNode,HostNode>({insert:insertHost,remove:removeHost,createElement:hostNode,createText:text=>hostNode('#text',text),createComment:text=>hostNode('#comment',text),setText:(node,text)=>{node.text=text;},setElementText:(node,text)=>{node.text=text;node.children=[];},parentNode:node=>node.parent,nextSibling:node=>node.parent?.children[node.parent.children.indexOf(node)+1]??null,patchProp:(node,key,_previous,value)=>{node.props[key]=value;},insertStaticContent:(text,parent,anchor)=>{const node=hostNode('#static',text);insertHost(node,parent,anchor);return[node,node];}});
const hostNodes=(root:HostNode):HostNode[]=>[root,...root.children.flatMap(hostNodes)];
const hostText=(root:HostNode):string=>[root.text,...root.children.map(hostText)].join(' ');
function setupDrawer(){
  const records=historyRecords(),state=Vue.reactive({visible:true,busy:false,error:'',editable:true,history:records.page,record:records.changed as DeviceHistory|null,restore:null as RestorePreview|null,configurations:{...records.page,items:[],total:0},configuration:null as ConfigurationOperationResult|null});
  const select=vi.fn((id:string)=>{state.record=id==='baseline'?records.baseline:records.changed;}),preview=vi.fn(),restore=vi.fn(),configuration=vi.fn(),page=vi.fn(),close=vi.fn();
  app=templateRenderer.createApp({render:()=>Vue.h(DeviceTraceDrawer,{...state,onSelect:select,onPreview:preview,onRestore:restore,onConfiguration:configuration,onPage:page,onClose:close})});
  app.provide(Vue.ssrContextKey,{});const root=hostNode('root');app.mount(root);
  const button=(name:string)=>hostNodes(root).find(node=>node.tag==='button'&&hostText(node).includes(name))!;
  return{records,state,root,button,select,preview,restore,configuration,page,close};
}

describe('追溯及恢复实际模板',()=>{
  it('中文差异置于列表前方，显示操作人和北京时间，切换基线不伪造修改前值',async()=>{
    const s=setupDrawer(),text=hostText(s.root);
    expect(text).toContain('当前工作模式');expect(text).toContain('教学定频');expect(text).toContain('演示管理员');expect(text).toContain('2026-10-21 21:52:55');expect(text).not.toContain('currentWorkMode');
    expect(text.indexOf('字段前后对比')).toBeLessThan(text.indexOf('变更记录'));expect(s.button('查看差异').props['aria-pressed']).toBe(true);
    s.button('查看基线').props.onClick();await nextTick();
    const detail=hostNodes(s.root).find(node=>node.props['aria-label']==='选中记录详情')!;
    expect(s.select).toHaveBeenCalledWith('baseline');expect(hostText(detail)).toContain('原操作人及原修改时间未知');expect(hostText(detail)).toContain('留存时间');expect(hostText(detail)).not.toContain('修改前：');expect(hostText(detail)).not.toContain('修改后：');expect(hostText(detail)).not.toContain('演示管理员');
    expect(hostNodes(detail).some(node=>node.tag==='table')).toBe(false);expect(s.button('查看基线').props['aria-pressed']).toBe(true);
    s.button('查看差异').props.onClick();await nextTick();expect(hostText(s.root)).toContain('字段前后对比');
  });
  it('端口恢复预览逐参数展示，保留兼容性和权限限制，只发送原恢复候选',async()=>{
    const s=setupDrawer(),before=s.records.changed.before!.ports!,after=structuredClone(before);after[0]!.rateKbps=19.2;
    const candidate:RestorePreview={historyId:'changed',revision:'current',compatible:true,reasons:[],changes:[{field:'ports',before,after}],values:{ports:after}};
    s.state.restore=candidate;await nextTick();
    expect(hostText(s.root)).toContain('端口 RF-1 · 速率');expect(hostText(s.root)).toContain('9.6 kbps');expect(hostText(s.root)).toContain('19.2 kbps');expect(hostText(s.root)).not.toContain('"rateKbps"');
    s.button('预览恢复此版本').props.onClick();expect(s.preview).toHaveBeenCalledOnce();
    s.button('确认恢复候选').props.onClick();expect(s.restore).toHaveBeenCalledWith(candidate);
    s.state.restore!.compatible=false;s.state.restore!.reasons=['端口身份不兼容'];await nextTick();expect(s.button('确认恢复候选').props.disabled).toBe(true);expect(hostText(s.root)).toContain('端口身份不兼容');
    s.state.restore!.compatible=true;s.state.editable=false;await nextTick();expect(s.button('确认恢复候选').props.disabled).toBe(true);expect(hostNodes(s.root).some(node=>node.tag==='button'&&hostText(node).includes('预览恢复此版本'))).toBe(false);
  });
  it('配置参数单独列表展示中文状态、执行值和来源变化，未执行不填造结果',async()=>{
    const s=setupDrawer(),values={txPowerDbm:44,workFreqKhz:6000,currentWorkMode:'MOCK_FIXED'};
    s.state.configuration={status:'SUCCEEDED',sourceChanged:true,operation:{id:'configuration',request:{context:'ledger',deviceId:'DV-0001',modelId:'DM-0004',resourceEpoch:'epoch',deviceVersion:'initial',values,scenario:'success',presetVersion:'v2',requestId:'request'},signature:'signature',device:s.records.changed.after,modelName:'教学设备',acceptedAt:'2026-10-21T13:52:55Z',updatedAt:'2026-10-21T13:53:00Z',phase:'RECEIPT',status:'SUCCEEDED',message:'已记录执行回执',appliedValues:values,source:'教学配置'}};
    // 请求与执行故意不同，防止将两列混写为同一份数据。
    s.state.configuration.operation!.appliedValues={txPowerDbm:43,workFreqKhz:8000,currentWorkMode:'MOCK_HOPPING'};
    await nextTick();let detail=hostNodes(s.root).find(node=>node.props['aria-label']==='选中配置回执')!;
    expect(hostText(detail)).toContain('成功');expect(hostText(detail)).toContain('资源来源已变化');expect(hostText(detail)).toContain('44 dBm');expect(hostText(detail)).toContain('6000 kHz');expect(hostText(detail)).toContain('教学定频');expect(hostText(detail)).not.toContain('SUCCEEDED');
    const cells=hostNodes(detail).filter(node=>node.tag==='td').map(hostText);
    expect(cells).toEqual(['44 dBm','43 dBm','6000 kHz','8000 kHz','教学定频','教学跳频']);
    s.state.configuration.operation!.appliedValues=null;await nextTick();detail=hostNodes(s.root).find(node=>node.props['aria-label']==='选中配置回执')!;
    expect(hostText(detail)).toContain('尚无执行值');expect(hostText(s.root)).toContain('执行成功也不会修改台账');
  });
  it('分页与空态沿用记录总数，忙碌时禁用操作，窄屏外壳仅设置局部宽度',async()=>{
    const s=setupDrawer();s.state.history.total=25;await nextTick();
    expect(hostText(s.root)).toContain('记录总数 25 条');expect(hostNodes(s.root).find(node=>node.tag==='aside')!.props['data-width']).toBe('720px');
    s.button('下一页').props.onClick();expect(s.page).toHaveBeenCalledWith(2);
    s.state.busy=true;await nextTick();expect(s.button('查看差异').props.disabled).toBe(true);expect(s.button('刷新追溯').props.disabled).toBe(true);
    s.state.busy=false;s.state.history={items:[],total:0,pageNum:1,pageSize:20};s.state.record=null;await nextTick();expect(hostText(s.root)).toContain('尚无设备变更记录');
  });
});

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
import { renderer as uiRenderer, node, find, textOf, type HostNode } from './helpers/vue-client';
import { deviceTraceSchema, type RestoreProposal, type TraceSummary } from '../src/types/device-trace';
const baseline: TraceSummary = { request_id: null, device_id: 'D1', kind: 'RETAINED_BASELINE', base_revision: null,
  revision: 'resource-1111111111111111', created_at: '2026-10-23T10:00:00Z', actor_id: null,
  changed: false, changed_fields: [], data_origin: 'SYNTHETIC_INTEGRATION' };
const candidate: RestoreProposal = { schema_version: deviceTraceSchema, device_id: 'D1', base_revision: 'resource-2222222222222222',
  source_revision: baseline.revision, source_request_id: null, model_id: 'M1', compatible: true,
  changes: [{ field: 'tx_power_dbm', before: 20, after: 21, known: true }], patch: { tx_power_dbm: 21 },
  blocked_fields: ['status', 'ports'], warnings: ['仅为候选，尚未保存'] };
describe('只读资源追溯与恢复候选模板', () => {
  it('labels retained baseline as non-operation and emits exact selected source', async () => {
    const selected = vi.fn(), root = node('root');
    const local = uiRenderer.createApp({ render: () => h(DeviceTraceDrawer, { visible: true, busy: false, error: '', editable: false,
      history: { schema_version: deviceTraceSchema, items: [baseline], total: 1, page: 1, page_size: 20 }, record: null, restore: null, onSelect: selected }) });
    local.provide(Vue.ssrContextKey, {}); local.mount(root);
    try {
      expect(textOf(root)).toContain('留存基线（不是修改）'); expect(textOf(root)).not.toContain('SUCCEEDED');
      const button = find(root, n => n.tag === 'button' && textOf(n) === '留存基线（不是修改）')!;
      (button.props.onClick as Function)(); await nextTick(); expect(selected).toHaveBeenCalledWith(baseline);
    } finally { local.unmount(); }
  });
  it('apply emits a candidate, never a local save or online transition', async () => {
    const apply = vi.fn(), root = node('root');
    const local = uiRenderer.createApp({ render: () => h(DeviceRestorePreview, { preview: candidate, editable: true, busy: false, onApply: apply }) });
    local.mount(root);
    try {
      expect(textOf(root)).toContain('尚未保存'); expect(textOf(root)).toContain('20 → 21');
      const button = find(root, n => n.tag === 'button')!; (button.props.onClick as Function)(); await nextTick();
      expect(apply).toHaveBeenCalledWith(candidate); expect(Object.keys(candidate.patch)).toEqual(['tx_power_dbm']);
    } finally { local.unmount(); }
  });
});

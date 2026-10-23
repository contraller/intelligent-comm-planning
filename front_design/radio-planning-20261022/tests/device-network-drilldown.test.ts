import {afterEach,describe,it,expect,vi} from 'vitest';
import {createRenderer,h,reactive,type App} from 'vue';
import {createPinia,disposePinia,setActivePinia} from 'pinia';
import {createMockService} from '../src/services/mock';
import {previewService} from '../src/services';
import {useDeviceNetworkDetail} from '../src/composables/useDeviceNetworkDetail';
import {authorizeStore} from './helpers/auth';
import type {MaintenanceQuery} from '../src/types/device-maintenance';
import type {DeviceNetworkContext,DeviceNetworkDetail} from '../src/types/device-network';
import {TestStorage} from './helpers/storage';

describe('设备网络同快照下钻',()=>{
  async function setup(){const api=createMockService(()=>new TestStorage()),workspace=await api.loadResourceReadContext({context:'ledger'}),device=await api.getResourceObject({context:'ledger',revision:workspace.revision,kind:'device',id:'DV-0001'});return {api,query:{context:'ledger' as const,deviceId:'DV-0001',revision:workspace.revision,snapshotId:device.network!.snapshotId}};}
  it('链路与业务返回冻结端点、路径和对应指标',async()=>{
    const {api,query}=await setup(),link=await api.getDeviceNetworkDetail({...query,kind:'link',id:'PL-001'});expect(link.link?.id).toBe('PL-001');expect(link.stations).toHaveLength(2);expect(link.linkDetails.records.every(r=>r.linkId==='PL-001')).toBe(true);
    const business=await api.getDeviceNetworkDetail({...query,kind:'service',id:'GIS-SVC-VOICE-01'});expect(business.routes.some(r=>r.routeType==='BACKUP')).toBe(true);expect(business.links.length).toBeGreaterThan(1);expect(business.resources.devices.every(d=>business.stations.some(s=>s.id===d.stationId))).toBe(true);
  });
  it('不同快照与不属于设备的目标明确拒绝，不靠同名 ID 拼接',async()=>{
    const {api,query}=await setup();await expect(api.getDeviceNetworkDetail({...query,snapshotId:'another-network',kind:'link',id:'PL-001'})).rejects.toMatchObject({code:'NETWORK_SOURCE_CHANGED'});await expect(api.getDeviceNetworkDetail({...query,kind:'service',id:'missing'})).rejects.toMatchObject({code:'NETWORK_OBJECT_MISSING'});
  });
});

// 挂载真实局部状态，服务沿用原 Mock；不修改业务数据来制造层级和失败场景。
const renderer=createRenderer<any,any>({insert(){},remove(){},createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null,patchProp(){}});
let app:App|undefined,pinia:ReturnType<typeof createPinia>|undefined;
afterEach(()=>{app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();});
async function chainFixture(){
  pinia=createPinia();setActivePinia(pinia);const auth=authorizeStore(),storage=new TestStorage(),api=createMockService(()=>storage);
  const workspace=await api.loadResourceReadContext({context:'ledger'}),device=await api.getResourceObject({context:'ledger',revision:workspace.revision,kind:'device',id:'DV-0001'});
  const binding=reactive({query:{context:'ledger',deviceId:'DV-0001',revision:workspace.revision} as MaintenanceQuery,network:device.network! as DeviceNetworkContext});
  const detail=vi.spyOn(previewService,'getDeviceNetworkDetail').mockImplementation(api.getDeviceNetworkDetail);
  let chain!:ReturnType<typeof useDeviceNetworkDetail>;
  app=renderer.createApp({setup(){chain=useDeviceNetworkDetail(()=>binding.query,()=>binding.network);return()=>h('div');}});app.use(pinia);app.mount({});
  const snapshotId=binding.network.snapshotId;
  await chain.open('link','PL-001',snapshotId);
  return{auth,storage,api,binding,detail,chain,snapshotId};
}
type ChainFixture=Awaited<ReturnType<typeof chainFixture>>;
function invalidate(s:ChainFixture,kind:string){
  if(kind==='close')s.chain.close();
  if(kind==='device')s.binding.query.deviceId='DV-0002';
  if(kind==='revision')s.binding.query.revision='other-revision';
  if(kind==='context')s.binding.query.context='gis';
  if(kind==='snapshot')s.binding.network.snapshotId='other-snapshot';
  if(kind==='source')s.binding.network.state='stale';
  if(kind==='account')s.auth.accept({...s.auth.identity!,sessionId:'other-account'});
  if(kind==='permission')s.auth.accept({...s.auth.identity!,permissions:s.auth.identity!.permissions.filter(p=>p!=='resources.view')});
  if(kind==='blocked')s.auth.error='会话失效';
  if(kind==='unmount')app?.unmount();
}
const invalidations=['close','device','revision','context','snapshot','source','account','permission','blocked','unmount'];
describe('设备链路业务局部层级',()=>{
  it('业务沿用原设备和快照，返回父链路不再请求，关闭清空两层且不写业务',async()=>{
    const s=await chainFixture(),origin=s.chain.data.value;
    expect(await s.chain.openRelatedService('GIS-SVC-VOICE-01','PL-001',s.snapshotId)).toBe(true);
    expect(s.detail.mock.calls[1]![0]).toMatchObject({...s.binding.query,kind:'service',id:'GIS-SVC-VOICE-01',snapshotId:s.snapshotId});
    expect(s.chain.parentLink.value).toBe(origin);expect(s.chain.data.value?.service?.id).toBe('GIS-SVC-VOICE-01');
    expect(s.chain.backToLink()).toBe(true);expect(s.chain.data.value).toBe(origin);expect(s.detail).toHaveBeenCalledTimes(2);expect(s.chain.parentLink.value).toBeNull();
    s.chain.close();expect(s.chain.active.value).toBe(false);expect(s.chain.data.value).toBeNull();expect(s.chain.parentLink.value).toBeNull();expect(s.storage.writes).toBe(0);
  });
  it('业务失败保留链路和错误，原入口可以重试，直接进入业务不产生父链路',async()=>{
    const s=await chainFixture(),origin=s.chain.data.value;s.detail.mockRejectedValueOnce(new Error('业务暂不可读'));
    expect(await s.chain.openRelatedService('GIS-SVC-VOICE-01','PL-001',s.snapshotId)).toBe(false);expect(s.chain.data.value).toBe(origin);expect(s.chain.error.value).toBe('业务暂不可读');expect(s.chain.parentLink.value).toBeNull();
    expect(await s.chain.openRelatedService('GIS-SVC-VOICE-01','PL-001',s.snapshotId)).toBe(true);expect(s.chain.error.value).toBe('');
    await s.chain.open('service','GIS-SVC-DATA-01',s.snapshotId);expect(s.chain.parentLink.value).toBeNull();expect(s.chain.backToLink()).toBe(false);
  });
  it('拒绝不属于当前链路、错误快照和不存在的业务，不发额外请求',async()=>{
    const s=await chainFixture();
    for(const [id,linkId,snapshotId] of [['GIS-SVC-VOICE-01','PL-002',s.snapshotId],['GIS-SVC-VOICE-01','PL-001','other'],['missing','PL-001',s.snapshotId]])expect(await s.chain.openRelatedService(id!,linkId!,snapshotId!)).toBe(false);
    s.binding.network.routes=s.binding.network.routes.filter(route=>route.demandId!=='GIS-SVC-VOICE-01'||!route.linkIds.includes('PL-001'));
    expect(await s.chain.openRelatedService('GIS-SVC-VOICE-01','PL-001',s.snapshotId)).toBe(false);expect(s.detail).toHaveBeenCalledTimes(1);
  });
  it.each(['snapshot','id','route'])('错误业务响应 %s 不替换链路',async kind=>{
    const s=await chainFixture(),origin=s.chain.data.value,value=await s.api.getDeviceNetworkDetail({...s.binding.query,kind:'service',id:'GIS-SVC-VOICE-01',snapshotId:s.snapshotId});
    if(kind==='snapshot')value.snapshotId='other';if(kind==='id')value.service!.id='other';if(kind==='route')value.routes=[];
    s.detail.mockResolvedValueOnce(value);expect(await s.chain.openRelatedService('GIS-SVC-VOICE-01','PL-001',s.snapshotId)).toBe(false);expect(s.chain.data.value).toBe(origin);expect(s.chain.error.value).toContain('不匹配');
  });
  it.each(invalidations)('业务迟到后不污染失效现场：%s',async kind=>{
    const s=await chainFixture(),value=await s.api.getDeviceNetworkDetail({...s.binding.query,kind:'service',id:'GIS-SVC-VOICE-01',snapshotId:s.snapshotId});let finish!:(value:DeviceNetworkDetail)=>void;
    s.detail.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const pending=s.chain.openRelatedService('GIS-SVC-VOICE-01','PL-001',s.snapshotId),signal=s.detail.mock.calls[1]![0].signal;
    expect(await s.chain.openRelatedService('GIS-SVC-VOICE-01','PL-001',s.snapshotId)).toBe(false);expect(s.detail).toHaveBeenCalledTimes(2);
    invalidate(s,kind);expect(signal?.aborted).toBe(true);finish(value);expect(await pending).toBe(false);
    expect(s.chain.active.value).toBe(false);expect(s.chain.data.value).toBeNull();expect(s.chain.parentLink.value).toBeNull();expect(s.chain.error.value).toBe('');expect(s.chain.busy.value).toBe(false);expect(s.chain.backToLink()).toBe(false);
  });
  it.each(invalidations)('已读父链路不能在失效后复活：%s',async kind=>{
    const s=await chainFixture();await s.chain.openRelatedService('GIS-SVC-VOICE-01','PL-001',s.snapshotId);expect(s.chain.parentLink.value?.link?.id).toBe('PL-001');
    invalidate(s,kind);expect(s.chain.data.value).toBeNull();expect(s.chain.parentLink.value).toBeNull();expect(s.chain.backToLink()).toBe(false);expect(await s.chain.openRelatedService('GIS-SVC-VOICE-01','PL-001',s.snapshotId)).toBe(false);
  });
  it('关闭后的迟到拒绝不回填错误，同值绑定重建不会丢失父链路',async()=>{
    const s=await chainFixture();let reject!:(error:Error)=>void;s.detail.mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
    const pending=s.chain.openRelatedService('GIS-SVC-VOICE-01','PL-001',s.snapshotId);s.chain.close();reject(new Error('旧错误'));await pending;expect(s.chain.error.value).toBe('');
    await s.chain.open('link','PL-001',s.snapshotId);await s.chain.openRelatedService('GIS-SVC-VOICE-01','PL-001',s.snapshotId);
    s.binding.query={...s.binding.query};s.binding.network={...s.binding.network};expect(s.chain.data.value?.service?.id).toBe('GIS-SVC-VOICE-01');expect(s.chain.backToLink()).toBe(true);
  });
});

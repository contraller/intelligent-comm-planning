import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import ResourceLedgerEditDrawer from '../src/components/ResourceLedgerEditDrawer.vue';
import { useResourceLedgerEditStore } from '../src/stores/resource-ledger-edit';
import { useResourceReadStore } from '../src/stores/resource-read';
import { useAuthStore } from '../src/stores/auth';
import { previewService } from '../src/services';
import { createAccessService } from '../src/services/access';
import { ApiError, type PreviewService } from '../src/services/types';
import type { AuthIdentity } from '../src/types/system';
import { all, clientTemplate, node, renderer, textOf, type HostNode } from './helpers/vue-client';

vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {default:defineComponent({props:['visible'],setup:(p,{slots})=>()=>p.visible?h('aside',[slots.default?.(),slots.footer?.()]):null})};
});
beforeAll(() => clientTemplate(ResourceLedgerEditDrawer,'src/components/ResourceLedgerEditDrawer.vue','resource-maintenance-render.ts'));
const rev = 'resource-1111111111111111', next = 'resource-2222222222222222';
const identity = (): AuthIdentity => ({sessionId:'session',id:'editor',username:'editor',name:'联调编辑者',roleId:'editor',roleName:'编辑者',revision:'r1',epoch:'e1',permissions:['resources.view','situation.view','resources.device.edit']});
function context() {
  return {revision:rev,baseRevision:rev,device:{id:'D1',stationId:'N1',modelId:'M1',antennaId:'A1',status:'NORMAL' as const,alert:false,antennaHeightM:8,txPowerDbm:30,workFreqKhz:null,installedAt:'',currentWorkMode:'AM'},
    stations:[],models:[{id:'M1',name:'型号一',deviceClass:'HF' as const,manufacturer:'',freqMinKhz:2000,freqMaxKhz:30000,txPowerMaxDbm:50,modulation:['AM'],workMode:['AM']}],antennas:[],impact:{planIds:[],linkIds:[],description:'保留历史'}};
}
let pinia: ReturnType<typeof createPinia> | undefined, app: App<HostNode> | undefined;
afterEach(() => {app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();});
async function fixture() {
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());
  pinia=createPinia();setActivePinia(pinia);
  useAuthStore().accept(identity());
  const read=useResourceReadStore();
  read.workspace={revision:rev,bounds:[113,36,115,38],updatedAt:'2026-10-23T00:00:00Z',source:'构造联调',terrain:null,stats:{} as never};
  const load=vi.spyOn(previewService,'loadResourceMaintenanceContext').mockResolvedValue(context());
  const save=vi.spyOn(previewService,'saveResourceChanges').mockImplementation(async input=>({objectId:'D1',changed:true,revision:next,readRevision:next,affectedIds:['D1'],warnings:[],device:{...context().device,antennaHeightM:input.devices[0].antennaHeightM!}}));
  const refresh=vi.spyOn(read,'refresh').mockImplementation(async()=>{read.workspace!.revision=next;return true;});
  const editor=useResourceLedgerEditStore();
  expect(await editor.openForm('D1')).toBe(true);
  const root=node('root');app=renderer.createApp({render:()=>h(ResourceLedgerEditDrawer)});app.use(pinia);app.provide(ssrContextKey,{});app.mount(root);await nextTick();
  return {editor,read,load,save,refresh,root};
}
describe('新版台账设备参数入口', () => {
  it('只呈现三个可编辑字段，保存后显示反馈并刷新；不开放新增、端口或导入', async () => {
    const f=await fixture();
    expect(all(f.root,n=>n.tag==='input').map(n=>n.props.id).sort()).toEqual(['ledger-device-antennaHeightM','ledger-device-txPowerDbm','ledger-device-workFreqKhz']);
    expect(textOf(f.root)).not.toContain('当前工作模式');
    f.editor.form!.fields.antennaHeightM='9';
    const form=all(f.root,n=>n.tag==='form')[0];
    await (form.props.onSubmit as (e:unknown)=>unknown)({preventDefault(){}});await nextTick();
    expect(f.save).toHaveBeenCalledWith(expect.objectContaining({context:'ledger',baseRevision:rev,devices:[{id:'D1',antennaHeightM:9,txPowerDbm:30,workFreqKhz:null}]}));
    expect(f.save.mock.calls[0][0].devices[0]).not.toHaveProperty('currentWorkMode');
    expect(f.editor.message).toBe('设备已保存');expect(f.editor.formDirty).toBe(false);
    expect(f.refresh).toHaveBeenCalledOnce();expect(f.editor.context?.baseRevision).toBe(next);
    expect(await f.editor.openForm()).toBe(false);expect(await f.editor.openPorts('D1')).toBe(false);expect(await f.editor.openImport()).toBe(false);
    expect(await f.editor.setAvailability(['D1'],'OFF_SHELF')).toBe(false);
  });
  it('保存失败保留输入及请求标识；重试不生成新事务，刷新失败不谎报保存失败', async () => {
    const f=await fixture();
    f.editor.form!.fields.antennaHeightM='10';
    f.save.mockRejectedValueOnce(new ApiError('连接中断','NETWORK_ERROR'));
    expect(await f.editor.save()).toBe(false);const requestId=f.save.mock.calls[0][0].requestId;
    expect(f.editor.form!.fields.antennaHeightM).toBe('10');expect(f.editor.formDirty).toBe(true);
    f.refresh.mockResolvedValueOnce(false);
    expect(await f.editor.save()).toBe(true);expect(f.save.mock.calls[1][0].requestId).toBe(requestId);
    expect(f.editor.message).toContain('保存已成功，列表刷新失败');expect(f.editor.error).toBe('');
  });
  it('版本冲突与权限撤销都不抹掉输入；无权限不发送保存', async () => {
    const f=await fixture();f.editor.form!.fields.antennaHeightM='11';
    f.save.mockRejectedValueOnce(new ApiError('资源版本已变化，请刷新','RESOURCE_VERSION_CHANGED'));
    expect(await f.editor.save()).toBe(false);expect(f.editor.form!.fields.antennaHeightM).toBe('11');
    useAuthStore().accept({...identity(),permissions:['resources.view']});
    expect(await f.editor.save()).toBe(false);expect(f.save).toHaveBeenCalledOnce();
  });
  it('公开服务包装拒绝用有限权限跨页面保存或修改其他字段', async () => {
    const raw={getSession:async()=>identity(),saveResourceChanges:vi.fn(async()=>({changed:false})),loadResourceMaintenanceContext:vi.fn(async()=>context())};
    const service=createAccessService(()=>raw as unknown as PreviewService,null,()=>{});
    const input={context:'ledger' as const,baseRevision:rev,requestId:'R1',stations:[],devices:[{id:'D1',antennaHeightM:9}]};
    await service.saveResourceChanges(input);expect(raw.saveResourceChanges).toHaveBeenCalledOnce();
    for (const patch of [{context:'gis'},{newDevices:[]},{devices:[{id:'D1',currentWorkMode:'FM'}]}])
      await expect(service.saveResourceChanges({...input,...patch} as never)).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(service.loadResourceMaintenanceContext({context:'ledger',revision:rev})).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(raw.saveResourceChanges).toHaveBeenCalledOnce();expect(raw.loadResourceMaintenanceContext).not.toHaveBeenCalled();
  });
});

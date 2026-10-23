import { readFileSync } from 'node:fs';
import { afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { h,nextTick,ssrContextKey,type App } from 'vue';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import FrozenCoveragePanel from '../src/components/FrozenCoveragePanel.vue';
import { useAuthStore } from '../src/stores/auth';
import { all,clientTemplate,node,renderer,textOf,type HostNode } from './helpers/vue-client';
import { coverageCase } from './helpers/frozen-coverage';
import type { FrozenCoverageClient } from '../src/types/frozen-coverage';
vi.mock('../src/services',()=>({previewService:{}}));
let app:App|undefined,pinia:ReturnType<typeof createPinia>;
beforeAll(()=>clientTemplate(FrozenCoveragePanel,'src/components/FrozenCoveragePanel.vue','frozen-coverage-render.ts'));
beforeEach(()=>{
  class TestDocument { activeElement=null; }
  vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());vi.stubGlobal('ShadowRoot',class {});
  pinia=createPinia();setActivePinia(pinia);useAuthStore().accept({id:'editor',sessionId:crypto.randomUUID(),username:'editor',name:'编辑者',roleId:'r',roleName:'r',epoch:'e',revision:'r',permissions:['planning.view','planning.execute','situation.view']});
});
afterEach(()=>{app?.unmount();app=undefined;disposePinia(pinia);vi.restoreAllMocks();vi.unstubAllGlobals();});
async function fixture(context:'planning'|'gis'='planning'){
  const data=coverageCase();data.query.context=context;
  // 实际组件默认采样参数与响应保持一致，不借测试桩抹掉参数差异。
  Object.assign(data.parameters,{hour:12,cell_m:5000,az_step_deg:10});
  const client={getCache:vi.fn<FrozenCoverageClient['getCache']>().mockResolvedValue(data.cache),compute:vi.fn<FrozenCoverageClient['compute']>().mockResolvedValue(data.job),getJob:vi.fn<FrozenCoverageClient['getJob']>().mockResolvedValue(data.job),cancel:vi.fn<FrozenCoverageClient['cancel']>().mockResolvedValue(data.job)};
  const root=node('root'),overlay=vi.fn();app=renderer.createApp({render:()=>h(FrozenCoveragePanel,{query:data.query,services:client,onOverlay:overlay})});app.use(pinia);app.provide(ssrContextKey,{});app.mount(root);await nextTick();return {data,client,root,overlay};
}
async function click(root:HostNode,label:string){const button=all(root,row=>row.tag==='button'&&textOf(row)===label)[0];expect(button).toBeDefined();await (button.props.onClick as ()=>Promise<void>)();await nextTick();}
describe('冻结覆盖正式入口',()=>{
  it('GIS只读缓存且输出真实设备图层，不出现计算命令',async()=>{
    const f=await fixture('gis');expect(f.client.getCache).not.toHaveBeenCalled();expect(textOf(f.root)).not.toContain('计算冻结覆盖');
    await click(f.root,'读取覆盖缓存');expect(f.client.getCache.mock.calls[0][0].context).toBe('gis');expect(f.overlay.mock.lastCall![0].deviceId).toBe('D1');
    expect(textOf(f.root)).toContain('余量单位 dB');expect(f.client.compute).not.toHaveBeenCalled();
  });
  it('规划明确提交、成功后读取缓存；撤销专项写权限不再展示计算按钮',async()=>{
    const f=await fixture();await click(f.root,'计算冻结覆盖');expect(f.client.compute).toHaveBeenCalledOnce();expect(f.client.getCache).toHaveBeenCalledOnce();expect(textOf(f.root)).toContain('完整预测');
    const auth=useAuthStore();auth.accept({...auth.identity!,permissions:['planning.view']});await nextTick();expect(textOf(f.root)).not.toContain('计算冻结覆盖');
  });
  it('坏成功与未知提交显示错误和原号，不给出假覆盖',async()=>{
    const f=await fixture();f.client.compute.mockRejectedValueOnce(new Error('网络中断'));await click(f.root,'计算冻结覆盖');
    expect(textOf(f.root)).toContain('原号');expect(textOf(f.root)).toContain('网络中断');expect(textOf(f.root)).toContain('核实原请求');expect(f.overlay.mock.lastCall![0]).toBeNull();
  });
  it('两个正式宿主接同一共享客户端，地图仅绘制显式冻结覆盖',()=>{
    const read=(path:string)=>readFileSync(new URL('../src/'+path,import.meta.url),'utf8');
    const planning=read('views/PlanningApiView.vue'),gis=read('views/SituationView.vue'),frozen=read('components/GisFrozenPlanPanel.vue'),map=read('components/MapCanvas.vue');
    expect(planning).toContain(':services="collaborationHttp.frozenCoverage"');expect(gis).toContain(':coverage-services="collaborationHttp.frozenCoverage"');
    expect(frozen).toContain('FrozenCoveragePanel');expect(frozen).toMatch(/context:\s*'gis'/);expect(map).toContain('frozenCoverageLayer(');
    expect(map).toContain('props.frozenNetwork?.identity.plan_id');expect(map).toContain('watch(()=>props.frozenCoverage,paint)');
    expect(map).toContain('if(frozenLayer) layers.push(frozenLayer)');
    expect(planning).not.toContain('createFrozenCoverageHttp(');expect(gis).not.toContain('createFrozenCoverageHttp(');
  });
});

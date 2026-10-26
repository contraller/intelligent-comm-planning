import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ref, type App } from 'vue';
import { useTerrainBasemap } from '../src/composables/useTerrainBasemap';
import * as terrainService from '../src/services/terrain-basemap';
import { readDiagnosisNetwork } from '../src/services/diagnosis-http-validation';
import type { ResourceTerrain } from '../src/types/resource-read';
import { renderer, node } from './helpers/vue-client';

const metadata = (id='a'):ResourceTerrain => ({sourceSha256:id.repeat(64),bounds:[113,36,115,38],source:'构造地形'});
const image = (id='one'):terrainService.TerrainBasemap => ({url:'blob:'+id,extent:[113,36,115,38],source:'构造地形',dispose:vi.fn()});
let app:App|undefined;
afterEach(()=>{app?.unmount();app=undefined;vi.restoreAllMocks();});
async function mount(initial:ResourceTerrain|null=metadata()){
  const expected=ref(initial),enabled=ref(true),notice=ref('历史地形未核验');
  let result!:ReturnType<typeof useTerrainBasemap>;
  app=renderer.createApp({setup(){result=useTerrainBasemap(()=>expected.value,{enabled:()=>enabled.value,unavailableReason:()=>notice.value});return()=>h('probe');}});
  app.mount(node('root'));await nextTick();await nextTick();
  return {expected,enabled,notice,result};
}
describe('跨页面 DEM 加载生命周期',()=>{
  it('同内容对象替换和资源更新不重复加载或释放',async()=>{
    const current=image(),load=vi.spyOn(terrainService,'loadTerrainBasemap').mockResolvedValue(current);
    const s=await mount();expect(s.result.basemap.value).toBe(current);
    s.expected.value={...metadata(),bounds:[113,36,115,38]};await nextTick();
    expect(load).toHaveBeenCalledTimes(1);expect(current.dispose).not.toHaveBeenCalled();
  });
  it('换版取消旧加载，迟到图片释放，离页取消并释放当前图',async()=>{
    let finish!:(value:terrainService.TerrainBasemap)=>void;
    const old=image('old'),current=image('current'),load=vi.spyOn(terrainService,'loadTerrainBasemap')
      .mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce(current);
    const s=await mount();s.expected.value=metadata('b');await nextTick();await nextTick();
    expect(load.mock.calls[0][3]?.aborted).toBe(true);expect(s.result.basemap.value).toBe(current);
    finish(old);await nextTick();await nextTick();expect(old.dispose).toHaveBeenCalledOnce();
    app!.unmount();app=undefined;expect(current.dispose).toHaveBeenCalledOnce();expect(load.mock.calls[1][3]?.aborted).toBe(true);
  });
  it('缺失版本不回退当前资源，校验失败保留明确错误',async()=>{
    const load=vi.spyOn(terrainService,'loadTerrainBasemap').mockRejectedValue(new Error('地形图片校验失败'));
    const s=await mount(null);expect(load).not.toHaveBeenCalled();expect(s.result.message.value).toBe('历史地形未核验');
    s.expected.value=metadata();await nextTick();await nextTick();expect(s.result.basemap.value).toBeNull();expect(s.result.message.value).toContain('校验失败');
    s.enabled.value=false;await nextTick();expect(s.result.message.value).toBe('');
  });
  it('离页后的迟到响应不再修改页面',async()=>{
    let finish!:(value:terrainService.TerrainBasemap)=>void;
    const late=image('late');vi.spyOn(terrainService,'loadTerrainBasemap').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const s=await mount();app!.unmount();app=undefined;finish(late);await nextTick();await nextTick();
    expect(late.dispose).toHaveBeenCalledOnce();expect(s.result.basemap.value).toBeNull();
  });
  it('诊断网络拒绝错误地形版本格式和非法地理范围',()=>{
    const n={id:'p',taskId:'t',jobId:null,name:'构造网络',version:'V1',snapshotId:'s',preset:'SR4',state:'CONFIRMED',sourceChanged:false,inputSnapshot:{stations:[],devices:[]},stationIds:[],links:[],regions:[],metrics:{coveragePercent:null,connectivityPercent:null,survivabilityPercent:null,totalRadiatedPowerW:null,delayMs:null},notes:[],terrain:metadata()};
    expect(readDiagnosisNetwork(n).terrain).toEqual(metadata());
    expect(()=>readDiagnosisNetwork({...n,terrain:{...metadata(),sourceSha256:'bad'}})).toThrow();
    expect(()=>readDiagnosisNetwork({...n,terrain:{...metadata(),bounds:[115,36,113,38]}})).toThrow();
    expect(readDiagnosisNetwork({...n,terrain:null}).terrain).toBeNull();
  });
});

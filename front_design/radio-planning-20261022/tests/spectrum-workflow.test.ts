import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockService } from '../src/services/mock';
import { TestStorage } from './helpers/storage';
import type { SpectrumSource } from '../src/types/spectrum';
import { spectrumIssues } from '../src/services/spectrum-validation';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { useSpectrumStore } from '../src/stores/spectrum';
import { authorizeStore } from './helpers/auth';

afterEach(()=>vi.unstubAllGlobals());
const configured=(source:SpectrumSource)=>({...source,minKhz:2000,maxKhz:30000});
describe('频谱配置和显式 Mock 检查',()=>{
  it('新增未改直接关闭；输入后还原以及数字清空恢复空值均不误判未保存',async()=>{
    const pinia=createPinia();setActivePinia(pinia);authorizeStore();const store=useSpectrumStore();
    try{
      await store.open();expect(store.dirty).toBe(false);expect(await store.leave()).toBe(true);expect(store.decision).toBeNull();
      await store.open();store.form!.name='新配置';expect(store.dirty).toBe(true);store.form!.name='';
      store.form!.minKhz=10;expect(store.dirty).toBe(true);store.form!.minKhz='' as unknown as number;
      expect(store.dirty).toBe(false);expect(await store.leave()).toBe(true);
    }finally{disposePinia(pinia);}
  });
  it('初始两条未验证且待补全；补全保存后按版本检查，不发送网络请求',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage),fetcher=vi.fn();
    vi.stubGlobal('fetch',fetcher);vi.stubGlobal('WebSocket',vi.fn());
    const initial=await service.loadSpectrumWorkspace();
    expect(initial.checks).toEqual([]);expect(initial.sources).toHaveLength(2);expect(storage.writes).toBe(0);
    await expect(service.checkSpectrumSource({baseRevision:initial.revision,requestId:'incomplete',sourceId:'SP-01',configRevision:'initial',demo:'success'})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    let saved=await service.saveSpectrumSource({baseRevision:initial.revision,requestId:'save',source:configured(initial.sources[0])});
    for(const demo of ['success','connection-failed','format-invalid'] as const){
      const result=await service.checkSpectrumSource({baseRevision:saved.workspace.revision,requestId:demo,sourceId:'SP-01',configRevision:saved.workspace.sources[0].revision,demo});
      expect(result.check).toMatchObject({demo,connection:demo==='connection-failed'?'FAILED':'SUCCESS',validation:demo==='connection-failed'?'NOT_RUN':demo==='success'?'SUCCESS':'FAILED'});
      saved=result;
    }
    expect(fetcher).not.toHaveBeenCalled();expect(WebSocket).not.toHaveBeenCalled();
  });
  it('配置变化后旧检查过期，改回原字段仍须重检；无变化保存不升版',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage);
    const first=await service.loadSpectrumWorkspace();
    const saved=await service.saveSpectrumSource({baseRevision:first.revision,requestId:'save',source:configured(first.sources[0])});
    const request={baseRevision:saved.workspace.revision,requestId:'check',sourceId:'SP-01',configRevision:saved.workspace.sources[0].revision,demo:'success' as const};
    const checked=await service.checkSpectrumSource(request),writes=storage.writes;
    expect((await service.checkSpectrumSource(request)).check).toEqual(checked.check);expect(storage.writes).toBe(writes);
    const unchanged=await service.saveSpectrumSource({baseRevision:checked.workspace.revision,requestId:'same',source:checked.workspace.sources[0]});
    expect(unchanged.changed).toBe(false);expect(unchanged.workspace.revision).toBe(checked.workspace.revision);expect(storage.writes).toBe(writes+1);
    const changed=await service.saveSpectrumSource({baseRevision:checked.workspace.revision,requestId:'change',source:{...checked.workspace.sources[0],intervalSeconds:45}});
    expect(changed.workspace.checks[0].configRevision).not.toBe(changed.workspace.sources[0].revision);
    const restored=await service.saveSpectrumSource({baseRevision:changed.workspace.revision,requestId:'restore',source:{...changed.workspace.sources[0],intervalSeconds:checked.workspace.sources[0].intervalSeconds}});
    expect(restored.workspace.sources[0].revision).not.toBe(checked.check!.configRevision);
  });
  it('新增、停用、恢复保留同一 ID，停用拒绝检查，重复请求内容固定',async()=>{
    const service=createMockService(()=>newStorage),newStorage=new TestStorage();
    const initial=await service.loadSpectrumWorkspace(),source={...configured(initial.sources[0]),id:'new-source',revision:'new',endpoint:'wss://example.test/spectrum',protocol:'WEBSOCKET_JSON' as const};
    const request={baseRevision:initial.revision,requestId:'new',source};
    const added=await service.saveSpectrumSource(request);
    expect((await service.saveSpectrumSource(request)).workspace.sources).toHaveLength(3);
    await expect(service.saveSpectrumSource({...request,source:{...source,name:'changed'}})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
    const disabled=await service.saveSpectrumSource({baseRevision:added.workspace.revision,requestId:'disable',source:{...added.workspace.sources[2],enabled:false}});
    await expect(service.checkSpectrumSource({baseRevision:disabled.workspace.revision,requestId:'disabled-check',sourceId:source.id,configRevision:disabled.workspace.sources[2].revision,demo:'success'})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    const enabled=await service.saveSpectrumSource({baseRevision:disabled.workspace.revision,requestId:'enable',source:{...disabled.workspace.sources[2],enabled:true}});
    expect(enabled.workspace.sources[2].id).toBe(source.id);
  });
  it.each(['http://user:pass@example.test','javascript:alert(1)','wss://example.test','//other/path','/bad path'])('拒绝无效 HTTP 配置 %s',endpoint=>{
    const source={id:'test',name:'采集配置',endpoint,protocol:'HTTP_JSON' as const,intervalSeconds:30,minKhz:1,maxKhz:2,enabled:true,revision:'new'};
    expect(spectrumIssues(source).length).toBeGreaterThan(0);
  });
});

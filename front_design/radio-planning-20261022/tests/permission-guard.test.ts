import { createAccessService } from '../src/services/access';
import { vi } from 'vitest';
import { describe,it,expect } from 'vitest';
import { authFixture } from './helpers/auth';
import { servicePermissions,allPermissions,togglePermission } from '../src/config/permissions';
import { assertPermissions } from '../src/services/system-validation';
import { readSystem,writeSystem } from '../src/services/system-storage';
describe('统一公开服务权限',()=>{
  it('仅规划查看可读取任务节点，但不能伪造 GIS 上下文或读取干扰源',async()=>{
    const s=authFixture(),actor=await s.login('viewer'),business=vi.fn(async()=>({items:[],pageNum:1,pageSize:10,total:0,revision:'r1'}));
    const raw={...s.raw,queryResourceNodes:business,queryResourceInterferences:business,queryTaskInputs:business,getSession:async()=>({...actor,permissions:['planning.view'] as typeof actor.permissions})};
    const service=createAccessService(()=>raw as typeof s.raw,null);
    await service.queryResourceNodes({context:'planning'} as never);expect(business).toHaveBeenCalledTimes(1);
    await expect(service.queryResourceInterferences({context:'planning'} as never)).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(service.queryTaskInputs({context:'gis'} as never)).rejects.toMatchObject({code:'FORBIDDEN'});expect(business).toHaveBeenCalledTimes(1);
  });
  it('每个公开方法都映射到权限或明确的登录接口',()=>{
    const s=authFixture(),publicNames=['getLoginCatalog','login','logout','getSession','recoverSystemWorkspace'];
    expect(Object.keys(s.raw).sort()).toEqual([...Object.keys(servicePermissions),...publicNames].sort());
    expect(Object.keys(s.service).sort()).toEqual(Object.keys(s.raw).sort());
  });
  it.each(Object.keys(servicePermissions))('未登录直调 %s 在业务参数解析前拒绝',async(name)=>{
    const s=authFixture();await expect((s.service as unknown as Record<string,(...a:unknown[])=>Promise<unknown>>)[name]()).rejects.toMatchObject({code:'AUTH_REQUIRED'});
  });
  it('只读账号可浏览，无法保存资源、提交规划或导出诊断',async()=>{
    const s=authFixture();await s.login('viewer');expect((await s.service.loadPreview()).resources.devices.length).toBeGreaterThan(0);
    for(const name of ['commitResources','submitPlanning','exportDiagnosisReport','saveKnowledgeChange','saveSystemAccount'])await expect((s.service as unknown as Record<string,()=>Promise<unknown>>)[name]()).rejects.toMatchObject({code:'FORBIDDEN'});
  });
  it('动态权限收回和停用在下一次公开调用生效',async()=>{
    const s=authFixture();await s.login('resource');let w=readSystem(s.storage);w.roles.find(r=>r.id==='ROLE-RESOURCE')!.permissions=['resources.view'];writeSystem(s.storage,w);
    await expect(s.service.commitResources({baseRevision:'initial',stations:[],devices:[]})).rejects.toMatchObject({code:'FORBIDDEN'});
    w=readSystem(s.storage);w.accounts.find(a=>a.id==='SYS-RESOURCE')!.enabled=false;writeSystem(s.storage,w);
    await expect(s.service.loadPreview()).rejects.toMatchObject({code:'AUTH_DISABLED'});
  });
  it('权限依赖联动，未知编码、重复和知识编辑审核混授拒绝',()=>{
    expect(togglePermission([],'knowledge.publish',true)).toEqual(['knowledge.view','knowledge.review','knowledge.publish']);
    expect(togglePermission(['planning.view','planning.execute'],'planning.view',false)).toEqual([]);
    expect(()=>assertPermissions(['unknown'] as never)).toThrow();expect(()=>assertPermissions(['resources.view','resources.view'])).toThrow();
    expect(()=>assertPermissions(['planning.execute'])).toThrow();expect(()=>assertPermissions(allPermissions)).toThrow('不能同时');
  });
  // 管理员例外不放松未知权限、重复权限和依赖校验，也不扩散到其他角色。
  it('仅内置管理员角色可兼有全部知识权限',()=>{
    expect(()=>assertPermissions(allPermissions,'ROLE-ADMIN')).not.toThrow();
    expect(()=>assertPermissions(allPermissions,'ROLE-RESOURCE')).toThrow('不能同时');
    for(const codes of [['unknown'],['resources.view','resources.view'],['planning.execute']])
      expect(()=>assertPermissions(codes as never,'ROLE-ADMIN')).toThrow();
  });
  it('admin 默认拥有全部模块权限并可实际保存资源修改',async()=>{
    const s=authFixture(),actor=await s.login();expect(actor.permissions).toEqual(allPermissions);
    const before=await s.service.loadPreview();
    const result=await s.service.commitResources({baseRevision:before.resourceMeta.revision,stations:[{id:'ND-0001',name:'管理员演示编辑'}],devices:[]});
    expect(result.changed).toBe(true);
    expect((await s.service.loadPreview()).resources.stations.find(station=>station.id==='ND-0001')?.name).toBe('管理员演示编辑');
  });
});

// 同一个读取方法也校验页面上下文，不能借资源台账权限读取 GIS 节点树。
describe('只读资源上下文权限',()=>{
  it('台账专有角色可读设备但不能伪造 GIS 或节点详情',async()=>{
    const s=authFixture(),actor=await s.login('viewer');
    const raw={...s.raw,getSession:async()=>({...actor,permissions:['resources.view'] as typeof actor.permissions})};
    const api=createAccessService(()=>raw,null),context=await api.loadResourceReadContext({context:'ledger'});
    const query={context:'ledger' as const,revision:context.revision,pageNum:1,pageSize:10};
    expect((await api.queryResourceDevices(query)).items.length).toBeGreaterThan(0);
    for(const action of [()=>api.queryResourceNodes({...query,context:'gis'}),()=>api.queryResourceDevices({...query,context:'gis'}),()=>api.getResourceObject({...query,kind:'node',id:'ND-0001'}),()=>api.loadResourceReadContext({context:'gis'})]){
      await expect(action()).rejects.toMatchObject({code:'FORBIDDEN'});
    }
  });
  it('GIS 专有角色可读节点及关联设备，无台账权限不能伪造台账上下文',async()=>{
    const s=authFixture(),actor=await s.login('viewer');
    const raw={...s.raw,getSession:async()=>({...actor,permissions:['situation.view'] as typeof actor.permissions})};
    const api=createAccessService(()=>raw,null),context=await api.loadResourceReadContext({context:'gis'});
    expect((await api.queryResourceDevices({context:'gis',revision:context.revision,pageNum:1,pageSize:10})).total).toBeGreaterThan(0);
    await expect(api.loadResourceReadContext({context:'ledger'})).rejects.toMatchObject({code:'FORBIDDEN'});
  });
  it('业务返回前收回当前页权限，成功响应也不能交给页面',async()=>{
    const s=authFixture(),actor=await s.login('viewer');let reads=0;
    const raw={...s.raw,getSession:async()=>({...actor,permissions:(++reads===1?['resources.view']:[]) as typeof actor.permissions})};
    const api=createAccessService(()=>raw,null);
    await expect(api.loadResourceReadContext({context:'ledger'})).rejects.toMatchObject({code:'FORBIDDEN'});
  });
});

describe('本批资源与频谱权限',()=>{
  it('只读可导出与读配置，维护者可保存检查，重置仍单独授权',async()=>{
    const s=authFixture();await s.login('viewer');
    expect((await s.service.exportResources({format:'csv',kinds:['devices'],ids:{devices:['DV-0001']}})).bytes.length).toBeGreaterThan(0);
    expect((await s.service.loadSpectrumWorkspace()).sources).toHaveLength(2);
    for(const name of ['getResourceTemplate','previewResourceImport','commitResourceImport','setDeviceAvailability','saveSpectrumSource','checkSpectrumSource','resetSpectrumWorkspace'])
      await expect((s.service as unknown as Record<string,()=>Promise<unknown>>)[name]()).rejects.toMatchObject({code:'FORBIDDEN'});
    await s.service.logout();await s.login('resource');
    const w=readSystem(s.storage);w.roles.find(r=>r.id==='ROLE-RESOURCE')!.permissions=['resources.view','resources.edit'];writeSystem(s.storage,w);
    expect((await s.service.getResourceTemplate('csv','nodes')).bytes.length).toBeGreaterThan(0);
    await expect(s.service.resetSpectrumWorkspace(null)).rejects.toMatchObject({code:'FORBIDDEN'});
  });
  it('GIS 请求额外检查 situation.view，不能用资源维护权限单独进入',async()=>{
    const s=authFixture();await s.login('resource');
    const w=readSystem(s.storage);w.roles.find(r=>r.id==='ROLE-RESOURCE')!.permissions=['resources.view','resources.edit'];writeSystem(s.storage,w);
    await expect(s.service.commitResources({context:'gis',baseRevision:'initial',stations:[],devices:[]})).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(s.service.previewResourceImport({context:'gis'} as never)).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(s.service.exportResources({context:'gis',format:'csv',kinds:['nodes']})).rejects.toMatchObject({code:'FORBIDDEN'});
    expect((await s.service.commitResources({context:'ledger',baseRevision:'initial',stations:[],devices:[]})).changed).toBe(false);
  });
});

// 整体提交逐部分校验权限，不能用 GIS 查看权限代替资源或任务维护权限。
describe('任务与整体保存权限',()=>{
  it('人工调整沿用规划执行权限，不能借父方案身份绕过只读角色',async()=>{
    const s=authFixture(),actor=await s.login('viewer'),submit=vi.fn(async()=>({}));
    const raw={...s.raw,submitPlanning:submit,submitPlanningTask:submit,getSession:async()=>({...actor,permissions:['planning.view'] as typeof actor.permissions})};
    const api=createAccessService(()=>raw as unknown as typeof s.raw,null);
    const adjustment={schemaVersion:1 as const,sourcePlanId:'PARENT',sourceSnapshotId:'SNAPSHOT',manualOverrides:[{deviceId:'DEVICE',txPowerDbm:0}],manualPaths:[]};
    await expect(api.submitPlanning({adjustment} as never)).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(api.submitPlanningTask({context:'planning',adjustment} as never)).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(submit).not.toHaveBeenCalled();
  });
  it('只读可导出方案但不能保存任务；资源维护员不能更新任务',async()=>{
    const s=authFixture();await s.login('viewer');expect((await s.service.exportPlanVersion({planId:'PLAN-V1',format:'json'})).bytes.length).toBeGreaterThan(0);
    await expect(s.service.saveTask({} as never)).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(s.service.commitGisWorkspace({context:'gis',changes:{stations:[],devices:[]},task:{taskId:'T'}} as never)).rejects.toMatchObject({code:'FORBIDDEN'});
    await s.service.logout();await s.login('resource');await expect(s.service.commitGisWorkspace({context:'gis',changes:{stations:[],devices:[]},task:{taskId:'T'}} as never)).rejects.toMatchObject({code:'FORBIDDEN'});
    await s.service.logout();await s.login('planner');await expect(s.service.commitGisWorkspace({context:'gis',changes:{stations:[{id:'ND-0001',name:'拒绝'}],devices:[]},task:null} as never)).rejects.toMatchObject({code:'FORBIDDEN'});
  });
});

describe('干扰分析复用权限',()=>{
  it('每项必要权限缺失时在业务执行前拒绝；完整授权才调用业务',async()=>{
    const s=authFixture();await s.login('planner');const actor=(await s.raw.getSession())!;
    for(const [method,required] of [
      ['loadInterferenceWorkspace',['situation.view','planning.view']],
      ['loadInterferenceSources',['situation.view','planning.view']],
      ['getInterferenceAnalysis',['situation.view','planning.view']],
      ['submitInterferenceAnalysis',['situation.view','planning.view','planning.execute']],
      ['cancelInterferenceAnalysis',['situation.view','planning.view','planning.execute']],
      ['adoptInterferenceMeasure',['situation.view','planning.view','planning.execute','planning.save']],
    ] as const){
      const business=vi.fn(async()=>({})),raw={...s.raw,[method]:business,getSession:async()=>({...actor,permissions:[...required]})};
      const guarded=createAccessService(()=>raw as typeof s.raw,null,()=>{}) as unknown as Record<string,()=>Promise<unknown>>;
      for(const missing of required){raw.getSession=async()=>({...actor,permissions:required.filter(p=>p!==missing)});
        await expect(guarded[method]()).rejects.toMatchObject({code:'FORBIDDEN'});expect(business).not.toHaveBeenCalled();}
      raw.getSession=async()=>({...actor,permissions:[...required]});await guarded[method]();expect(business).toHaveBeenCalledTimes(1);
    }
  });
});

// 监控服务复用模块查看权限，读取采集周期不要求系统管理能力。
describe('态势监控公开权限',()=>{
  it.each([
    ['loadMonitoringContext',['situation.view','planning.view']],
    ['getMonitoringFrame',['situation.view','planning.view']],
    ['loadSpectrumMonitoringContext',['situation.view','resources.view']],
    ['getSpectrumObservationFrame',['situation.view','resources.view']],
  ] as const)('%s 校验两个关联模块权限',async(name,required)=>{
    const s=authFixture(),actor=await s.login('viewer'),business=vi.fn(async()=>({ok:true}));
    for(const permissions of [[],[required[0]],[required[1]]]){
      const raw={...s.raw,[name]:business,getSession:async()=>({...actor,permissions})};
      const service=createAccessService(()=>raw,null);
      await expect((service as unknown as Record<string,()=>Promise<unknown>>)[name]()).rejects.toMatchObject({code:'FORBIDDEN'});
    }
    expect(business).not.toHaveBeenCalled();
    const raw={...s.raw,[name]:business,getSession:async()=>({...actor,permissions:[...required]})};
    const service=createAccessService(()=>raw,null);
    expect(await (service as unknown as Record<string,()=>Promise<unknown>>)[name]()).toEqual({ok:true});
  });
});

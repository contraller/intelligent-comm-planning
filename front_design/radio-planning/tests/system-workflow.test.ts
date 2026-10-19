import { describe,it,expect } from 'vitest';
import { authFixture } from './helpers/auth';
import { readSystem } from '../src/services/system-storage';
import { SYSTEM_STORAGE_KEY } from '../src/config/demo';
describe('系统管理事务',()=>{
  it('新建角色与单角色账号可持久化、编辑和启停，登录名不可修改',async()=>{
    const s=authFixture();await s.login();
    const role=await s.service.saveSystemRole({...s.mutation(),role:{id:null,name:'查看规划',description:'测试',permissions:['planning.view']}});
    const created=await s.service.saveSystemAccount({...s.mutation(),account:{id:null,username:'teaching.user',name:'新教员',department:'教研组',roleId:role.objectId}});
    let a=readSystem(s.storage).accounts.find(a=>a.id===created.objectId)!;expect(a.enabled).toBe(true);
    await expect(s.service.saveSystemAccount({...s.mutation(),account:{...a,username:'changed'}})).rejects.toThrow('不可修改');
    await s.service.saveSystemAccount({...s.mutation(),account:{...a,name:'改名教员'}});a=readSystem(s.storage).accounts.find(a=>a.id===created.objectId)!;expect(a.name).toBe('改名教员');
    await s.service.setSystemAccountState({...s.mutation(),accountId:a.id,enabled:false});expect(readSystem(s.storage).accounts.find(x=>x.id===a.id)?.enabled).toBe(false);
  });
  it('最后管理员不能停用、降权或换角色；另有完整管理员才可退出管理职责',async()=>{
    const s=authFixture();await s.login();const w=readSystem(s.storage),admin=w.accounts[0],role=w.roles[0];
    await expect(s.service.setSystemAccountState({...s.mutation(),accountId:admin.id,enabled:false})).rejects.toMatchObject({code:'LAST_ADMIN'});
    await expect(s.service.saveSystemAccount({...s.mutation(),account:{...admin,roleId:'ROLE-VIEWER'}})).rejects.toMatchObject({code:'LAST_ADMIN'});
    await expect(s.service.saveSystemRole({...s.mutation(),role:{...role,permissions:['system.view']}})).rejects.toMatchObject({code:'LAST_ADMIN'});
    await s.service.saveSystemAccount({...s.mutation(),account:{id:null,username:'admin2',name:'第二管理员',department:'教学',roleId:role.id}});
    await s.service.setSystemAccountState({...s.mutation(),accountId:admin.id,enabled:false});await expect(s.service.getSession()).rejects.toMatchObject({code:'AUTH_DISABLED'});
  });
  it('幂等保存不重复创建，内容冲突及过期 revision 被拒绝',async()=>{
    const s=authFixture();await s.login();const r={...s.mutation(),account:{id:null,username:'same_request',name:'重复请求',department:'测试',roleId:'ROLE-VIEWER'}};
    const first=await s.service.saveSystemAccount(r);expect((await s.service.saveSystemAccount(r)).objectId).toBe(first.objectId);expect(readSystem(s.storage).accounts.filter(a=>a.username==='same_request')).toHaveLength(1);
    await expect(s.service.saveSystemAccount({...r,account:{...r.account,name:'不同内容'}})).rejects.toMatchObject({code:'SYSTEM_REQUEST_CONFLICT'});
    await expect(s.service.saveSystemParameter({baseRevision:r.baseRevision,requestId:'stale',parameterId:'PAR-01',value:31})).rejects.toMatchObject({code:'SYSTEM_CONFLICT'});
  });
  it('参数严格校验，固定坐标系拒绝修改，无变化不写配置',async()=>{
    const s=authFixture();await s.login();const before=s.storage.writeHistory.filter(k=>k===SYSTEM_STORAGE_KEY).length;
    expect((await s.service.saveSystemParameter({...s.mutation(),parameterId:'PAR-01',value:30})).changed).toBe(false);
    expect(s.storage.writeHistory.filter(k=>k===SYSTEM_STORAGE_KEY)).toHaveLength(before);
    for(const value of [0,3601,1.5,'30',NaN])await expect(s.service.saveSystemParameter({...s.mutation(),parameterId:'PAR-01',value})).rejects.toBeDefined();
    await expect(s.service.saveSystemParameter({...s.mutation(),parameterId:'PAR-03',value:'EPSG:3857'})).rejects.toBeDefined();
    await s.service.saveSystemParameter({...s.mutation(),parameterId:'PAR-02',value:45});expect(readSystem(s.storage).parameters[1].value).toBe(45);
  });
  it('用户名/角色引用与重复名称校验，失败保留原配置',async()=>{
    const s=authFixture();await s.login();const before=s.storage.entries.get(SYSTEM_STORAGE_KEY);
    for(const username of ['a','UPPER','bad name','admin'])await expect(s.service.saveSystemAccount({...s.mutation(),account:{id:null,username,name:'测试',department:'教学',roleId:'ROLE-VIEWER'}})).rejects.toBeDefined();
    await expect(s.service.saveSystemAccount({...s.mutation(),account:{id:null,username:'valid',name:'测试',department:'教学',roleId:'missing'}})).rejects.toBeDefined();
    expect(s.storage.entries.get(SYSTEM_STORAGE_KEY)).toBe(before);
  });
  it('分页与筛选返回全量计数，范围越界页码回到末页',async()=>{
    const s=authFixture();await s.login();for(let i=0;i<23;i++)await s.service.saveSystemAccount({...s.mutation(),account:{id:null,username:'test'+i,name:'查询账号'+i,department:'教学',roleId:'ROLE-VIEWER'}});
    const p=await s.service.querySystemAccounts({query:'查询账号',page:99,sort:'username'});expect(p.total).toBe(23);expect(p.page).toBe(2);expect(p.items).toHaveLength(3);
    expect((await s.service.querySystemAccounts({enabled:false})).items.map(a=>a.username)).toEqual(['disabled_viewer']);
  });
});

// 更新的是展示契约；已有参数定义、修订和历史日志在查询时保持原字节。
it('PAR-01 展示生效范围，旧工作区可读且读后不写回',async()=>{
  const s=authFixture();await s.login();
  await s.service.saveSystemParameter({...s.mutation(),parameterId:'PAR-01',value:7});
  const before=[...s.storage.entries],catalog=await s.service.loadSystemCatalog(),parameters=await s.service.querySystemParameters();
  const row=parameters.items.find(item=>item.id==='PAR-01')!;
  expect(row.value).toBe(7);expect(row.description).toContain('设备与链路态势');
  expect(catalog.parameters.find(item=>item.id==='PAR-01')!.description).toBe(row.description);
  expect(parameters.items.find(item=>item.id==='PAR-02')!.description).toContain('尚未接入 HTTP');
  expect([...s.storage.entries]).toEqual(before);
  expect(readSystem(s.storage).parameters.find(item=>item.id==='PAR-01')!.description).toContain('尚未接入');
});

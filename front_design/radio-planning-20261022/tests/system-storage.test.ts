import { describe,it,expect } from 'vitest';
import { authFixture } from './helpers/auth';
import { readSystem,readJournal,writeSystem } from '../src/services/system-storage';
import { initialSystemWorkspace,DEMO_PASSWORD } from '../src/mocks/system-presets';
import { SYSTEM_STORAGE_KEY,OPERATION_LOG_KEY,SESSION_STORAGE_KEY,RESOURCE_STORAGE_KEY,KNOWLEDGE_STORAGE_KEY } from '../src/config/demo';
import { allPermissions } from '../src/config/permissions';

describe('系统、会话、日志分键与恢复',()=>{
  it('空读不写默认值；损坏日志不阻止账号登录',async()=>{
    const s=authFixture();readSystem(s.storage);readJournal(s.storage);expect(s.storage.writes).toBe(0);
    s.storage.entries.set(OPERATION_LOG_KEY,'broken');await s.login();expect((await s.service.getSession())?.id).toBe('SYS-ADMIN');expect(s.logger.status().pending).toBe(1);
  });
  it('配置损坏和版本不兼容仅允许受限恢复，健康配置禁止绕过停用',async()=>{
    const s=authFixture();await expect(s.service.recoverSystemWorkspace({username:'admin',password:DEMO_PASSWORD})).rejects.toBeDefined();
    for(const raw of ['broken',JSON.stringify({...initialSystemWorkspace(),schemaVersion:999})]){
      s.storage.entries.set(SYSTEM_STORAGE_KEY,raw);await expect(s.login()).rejects.toBeDefined();
      await expect(s.service.recoverSystemWorkspace({username:'viewer',password:DEMO_PASSWORD})).rejects.toBeDefined();
      await s.service.recoverSystemWorkspace({username:'admin',password:DEMO_PASSWORD});expect(readSystem(s.storage).accounts).toHaveLength(7);
    }
  });
  it('拒绝读取不能伪装为损坏恢复；写失败保留原始字节',async()=>{
    const s=authFixture();s.storage.failReadKeys.add(SYSTEM_STORAGE_KEY);await expect(s.service.recoverSystemWorkspace({username:'admin',password:DEMO_PASSWORD})).rejects.toMatchObject({code:'SYSTEM_READ_FAILED'});
    s.storage.failReadKeys.clear();await s.login();s.storage.failWriteKeys.add(SYSTEM_STORAGE_KEY);await expect(s.service.saveSystemParameter({...s.mutation(),parameterId:'PAR-01',value:40})).rejects.toMatchObject({code:'SYSTEM_WRITE_FAILED'});expect(s.storage.entries.has(SYSTEM_STORAGE_KEY)).toBe(false);
  });
  it('系统重置仅配置和日志变动，保留各业务键；日志重置不影响会话配置',async()=>{
    const s=authFixture();await s.login();s.storage.entries.set(RESOURCE_STORAGE_KEY,'resource-sentinel');s.storage.entries.set(KNOWLEDGE_STORAGE_KEY,'knowledge-sentinel');
    await s.service.resetSystemWorkspace(s.mutation());expect(s.storage.entries.get(RESOURCE_STORAGE_KEY)).toBe('resource-sentinel');expect(s.storage.entries.get(KNOWLEDGE_STORAGE_KEY)).toBe('knowledge-sentinel');
    await s.login();const config=s.storage.entries.get(SYSTEM_STORAGE_KEY),session=s.sessions.entries.get(SESSION_STORAGE_KEY);
    await s.service.resetOperationLogs({baseRevision:readJournal(s.storage).revision});expect(s.storage.entries.get(SYSTEM_STORAGE_KEY)).toBe(config);expect(s.sessions.entries.get(SESSION_STORAGE_KEY)).toBe(session);expect(readJournal(s.storage).events.map(e=>e.action)).toEqual(['resetOperationLogs']);
  });
  it('损坏引用、重复 ID 和参数定义篡改拒绝持久化',()=>{
    const s=authFixture();for(const kind of ['role','id','parameter']){
      const w=initialSystemWorkspace();if(kind==='role')w.accounts[0].roleId='missing';if(kind==='id')w.accounts[1].id=w.accounts[0].id;if(kind==='parameter')w.parameters[0].max=9999;
      expect(()=>writeSystem(s.storage,w)).toThrow();
    }expect(s.storage.writes).toBe(0);
  });
  // 默认全选权限；正常编辑后不通过读取偷偷补回。
  it('admin 默认全部权限，当前配置读取不改写手动权限',async()=>{
    const s=authFixture();await s.login();expect((await s.service.getSession())?.permissions).toEqual(allPermissions);
    const w=readSystem(s.storage);w.roles[0].permissions=allPermissions.filter(p=>p!=='resources.edit');writeSystem(s.storage,w);
    const bytes=s.storage.entries.get(SYSTEM_STORAGE_KEY),writes=s.storage.writes;
    s.storage.failWriteKeys.add(SYSTEM_STORAGE_KEY);
    expect(readSystem(s.storage).roles[0].permissions).not.toContain('resources.edit');
    expect(s.storage.entries.get(SYSTEM_STORAGE_KEY)).toBe(bytes);expect(s.storage.writes).toBe(writes);
  });
  it('旧预设只报不兼容，明确初始化后恢复全权限且保留业务与日志',async()=>{
    const s=authFixture();await s.login();const previousSession=await s.service.getSession();
    const bytes=JSON.stringify({...initialSystemWorkspace(),presetVersion:'system-demo-1'});
    s.storage.entries.set(SYSTEM_STORAGE_KEY,bytes);s.storage.entries.set(RESOURCE_STORAGE_KEY,'resource-sentinel');
    s.storage.entries.set(KNOWLEDGE_STORAGE_KEY,'knowledge-sentinel');
    const journal=s.storage.entries.get(OPERATION_LOG_KEY),writes=s.storage.writes;
    expect(()=>readSystem(s.storage)).toThrow(expect.objectContaining({code:'SYSTEM_INCOMPATIBLE'}));
    expect(s.storage.entries.get(SYSTEM_STORAGE_KEY)).toBe(bytes);expect(s.storage.writes).toBe(writes);
    await s.raw.recoverSystemWorkspace({username:'admin',password:DEMO_PASSWORD});
    const current=readSystem(s.storage);expect(current.epoch).not.toBe(previousSession?.epoch);expect(current.roles[0].permissions).toEqual(allPermissions);
    await expect(s.raw.getSession()).rejects.toMatchObject({code:'AUTH_EXPIRED'});
    expect(s.storage.entries.get(RESOURCE_STORAGE_KEY)).toBe('resource-sentinel');expect(s.storage.entries.get(KNOWLEDGE_STORAGE_KEY)).toBe('knowledge-sentinel');expect(s.storage.entries.get(OPERATION_LOG_KEY)).toBe(journal);
  });
});

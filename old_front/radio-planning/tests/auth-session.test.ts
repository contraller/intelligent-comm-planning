import { describe,it,expect } from 'vitest';
import { authFixture } from './helpers/auth';
import { DEMO_PASSWORD } from '../src/mocks/system-presets';
import { readSession } from '../src/services/session-storage';
import { SESSION_STORAGE_KEY,SYSTEM_STORAGE_KEY } from '../src/config/demo';
import { safeReturnPath } from '../src/config/permissions';
describe('标签页登录契约',()=>{
  it('空会话只读、正确登录恢复同一身份，退出显式标记不写密码',async()=>{
    const s=authFixture();expect(await s.service.getSession()).toBeNull();expect(s.storage.writes+s.sessions.writes).toBe(0);
    const a=await s.login('planner');expect((await s.service.getSession())?.sessionId).toBe(a.sessionId);
    expect(readSession(s.sessions)?.accountId).toBe('SYS-PLANNER');expect(s.storage.entries.has(SYSTEM_STORAGE_KEY)).toBe(false);
    await s.service.logout();expect(await s.service.getSession()).toBeNull();expect(JSON.parse(s.sessions.entries.get(SESSION_STORAGE_KEY)!).state).toBe('SIGNED_OUT');
    expect(JSON.stringify([...s.storage.entries,...s.sessions.entries])).not.toContain(DEMO_PASSWORD);
  });
  it.each([['viewer','wrong','AUTH_CREDENTIALS'],['missing',DEMO_PASSWORD,'AUTH_CREDENTIALS'],['disabled_viewer',DEMO_PASSWORD,'AUTH_DISABLED']])('拒绝 %s 无效登录',async(username,password,code)=>{
    const s=authFixture();await expect(s.service.login({username,password})).rejects.toMatchObject({code});expect(s.sessions.writes).toBe(0);
  });
  it('会话写失败不登录，退出失败保留活动标记',async()=>{
    const s=authFixture();s.sessions.failWrite=true;await expect(s.login()).rejects.toMatchObject({code:'SESSION_WRITE_FAILED'});expect(await s.service.getSession()).toBeNull();
    s.sessions.failWrite=false;const actor=await s.login();s.sessions.failWrite=true;await expect(s.service.logout()).rejects.toMatchObject({code:'SESSION_WRITE_FAILED'});expect((await s.service.getSession())?.sessionId).toBe(actor.sessionId);
  });
  it('禁止活动会话直接换人；系统 epoch 变化使旧会话失效',async()=>{
    const s=authFixture();await s.login();await expect(s.login('viewer')).rejects.toMatchObject({code:'AUTH_ACTIVE_SESSION'});
    await s.service.resetSystemWorkspace(s.mutation());await expect(s.service.getSession()).rejects.toMatchObject({code:'AUTH_EXPIRED'});await s.login('viewer');expect((await s.service.getSession())?.id).toBe('SYS-VIEWER');
  });
  it.each(['https://example.com','//example.com','/login','/system?next=https://example.com','/situation#bad','/situation?deviceId=../bad','/planning?anything=1'])('拒绝非白名单返回地址 %s',value=>expect(safeReturnPath(value)).toBeNull());
  it('仅保留业务页面使用的站内查询参数',()=>{expect(safeReturnPath('/situation?deviceId=DV-0001')).toBe('/situation?deviceId=DV-0001');expect(safeReturnPath('/knowledge?entityId=KGE-OPERATION')).toBeTruthy();});
  // 完整报告使用不透明 ID；登录返回也不能混合多种地图上下文。
  it('保留唯一诊断目标的不透明身份',()=>{
    const value='/situation?diagnosisId='+encodeURIComponent('历史 / 诊断:甲');
    expect(safeReturnPath(value)).toBe('/situation?'+new URLSearchParams({diagnosisId:'历史 / 诊断:甲'}).toString());
  });
  it.each(['','a&diagnosisId=b','a&stationId=N','a&deviceId=D','a&interferenceId=I','a&taskId=T','%00bad','x'.repeat(121)])('拒绝诊断返回参数 %s',value=>{
    expect(safeReturnPath('/situation?diagnosisId='+value)).toBeNull();
  });
});

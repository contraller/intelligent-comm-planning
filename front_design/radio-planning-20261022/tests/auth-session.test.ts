import { afterEach,describe,it,expect,vi } from 'vitest';
import { authFixture } from './helpers/auth';
import { DEMO_PASSWORD } from '../src/mocks/system-presets';
import { readSession } from '../src/services/session-storage';
import { SESSION_STORAGE_KEY,SYSTEM_STORAGE_KEY } from '../src/config/demo';
import { safeReturnPath } from '../src/config/permissions';
import { readJournal } from '../src/services/system-storage';
import { createSystemMock } from '../src/services/system-mock';

afterEach(()=>vi.unstubAllGlobals());

describe('标签页登录契约',()=>{
  // 固定用途支持登录返回和内部身份同步，禁止变成任意跳转参数。
  it.each(['/planning?history=references','/planning?from=diagnosis','/planning?taskId=T1&from=diagnosis','/planning?taskId=T1&planId=P1&from=diagnosis','/planning?taskId=T1&jobId=J1&from=diagnosis'])('接受规划引导用途 %s',value=>expect(safeReturnPath(value)).toBe(value));
  it.each(['/planning?history=jobs','/planning?from=other','/planning?from=diagnosis&from=diagnosis','/planning?history=references&history=references','/planning?history=references&from=diagnosis','/planning?history=references&taskId=T1','/planning?from=diagnosis&returnTo=https://example.com','/planning?from=diagnosis&jobId=J1','/planning?taskId=T1&jobId=J1&planId=P1&from=diagnosis'])('拒绝规划引导的混用和未知目标 %s',value=>expect(safeReturnPath(value)).toBeNull());
  // 局域网 HTTP 仅提供 getRandomValues，登录、日志和会话恢复均不能依赖 randomUUID。
  it('缺少原生 UUID 方法时仍能记录登录结果并恢复会话',async()=>{
    const random=globalThis.crypto;
    vi.stubGlobal('crypto',{getRandomValues:random.getRandomValues.bind(random)});
    const s=authFixture();
    await expect(s.service.login({username:'planner',password:'wrong'})).rejects.toMatchObject({code:'AUTH_CREDENTIALS'});
    expect(s.sessions.writes).toBe(0);
    expect(readJournal(s.storage).events.at(-1)).toMatchObject({action:'login',outcome:'DENIED',errorCode:'AUTH_CREDENTIALS'});

    const actor=await s.login('planner');
    expect(actor.sessionId).toMatch(/^SESSION-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(readJournal(s.storage).events.filter(event=>event.action==='login').map(event=>event.outcome)).toEqual(['DENIED','SUCCESS']);
    const restored=createSystemMock(()=>s.storage,()=>s.sessions);
    expect(await restored.getSession()).toEqual(actor);
    await s.service.logout();
    expect(await restored.getSession()).toBeNull();
    expect(readJournal(s.storage).events.at(-1)).toMatchObject({action:'logout',outcome:'SUCCESS'});
    expect(JSON.stringify([...s.storage.entries,...s.sessions.entries])).not.toContain(DEMO_PASSWORD);
  });
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
  // 标绘、报告与任务编辑保持独立目标，登录返回不能混合工作上下文。
  it.each(['/situation?faultEdit=1','/situation?faultEdit=1&scenarioId=S1&versionId=V1','/diagnosis?scenarioId=S1&versionId=V1','/planning?taskId=T1&editTask=1'])('保留合法工作入口 %s',value=>{
    expect(safeReturnPath(value)).toBe(value);
  });
  it.each(['/situation?faultEdit=2','/situation?faultEdit=1&scenarioId=S1','/situation?faultEdit=1&taskId=T1','/situation?faultEdit=1&diagnosisId=D1','/situation?scenarioId=S1&versionId=V1','/diagnosis?versionId=V1','/planning?editTask=1','/planning?taskId=T1&editTask=2','/planning?taskId=T1&editTask=1&planId=P1'])('拒绝混合或缺失目标 %s',value=>{
    expect(safeReturnPath(value)).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createAuthHttp } from '../src/services/auth-http';

const identity=(id='integration-planner',sid='planner-session')=>({session_id:sid,account_id:id,username:id,display_name:id,role_id:id+'-role',role_name:id,permissions:['planning.view'],identity_revision:'v1',session_generation:sid,integration_mode:true});
describe('独立联调身份传输',()=>{
  it('明确切换后接受新身份，旧会话响应不能继承新绑定',async()=>{
    let active=identity();
    const fetcher=vi.fn(async(url:unknown,init?:RequestInit)=>{
      const path=String(url);let data:unknown;
      if(path.endsWith('/auth/session'))data=active;
      else if(path.endsWith('/auth/csrf'))data={session_id:active.session_id,csrf_token:'csrf'};
      else if(path.endsWith('/auth/integration/switch')){expect(new Headers(init?.headers).get('X-Session-Id')).toBe('planner-session');expect(JSON.parse(String(init?.body))).toEqual({accountId:'integration-editor'});active=identity('integration-editor','editor-session');data=active;}
      else throw new Error(path);
      return new Response(JSON.stringify({code:0,message:'success',data}),{headers:{'Content-Type':'application/json'}});
    });
    const auth=createAuthHttp({baseUrl:()=>'/api/v1',fetcher:fetcher as typeof fetch});
    expect((await auth.getSession())?.integrationMode).toBe(true);
    expect((await auth.switchIntegrationIdentity('integration-editor')).id).toBe('integration-editor');
    expect((await auth.getSession())?.sessionId).toBe('editor-session');
    active=identity('integration-reviewer','other-tab-session');
    await expect(auth.getSession()).rejects.toMatchObject({code:'SESSION_REPLACED'});
  });
  it('切换失败保留原会话；身份目录不接受普通业务数据冒充',async()=>{
    const fetcher=vi.fn(async(url:unknown)=>{
      const path=String(url);
      if(path.endsWith('/auth/session'))return new Response(JSON.stringify({code:0,message:'success',data:identity()}));
      if(path.endsWith('/auth/csrf'))return new Response(JSON.stringify({code:0,message:'success',data:{session_id:'planner-session',csrf_token:'csrf'}}));
      return new Response(JSON.stringify({code:1104,message:'拒绝',data:null}),{status:403});
    });
    const auth=createAuthHttp({baseUrl:()=>'/api/v1',fetcher:fetcher as typeof fetch});
    await auth.getSession();await expect(auth.switchIntegrationIdentity('unknown')).rejects.toMatchObject({code:'FORBIDDEN'});
    expect((await auth.getSession())?.id).toBe('integration-planner');
  });
});

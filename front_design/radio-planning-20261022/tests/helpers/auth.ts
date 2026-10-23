import { vi } from 'vitest';
import { useAuthStore } from '../../src/stores/auth';
import { previewService } from '../../src/services';
import { initialSystemWorkspace, DEMO_PASSWORD } from '../../src/mocks/system-presets';
import { allPermissions } from '../../src/config/permissions';
import { createMockService } from '../../src/services/mock';
import { createAccessService } from '../../src/services/access';
import { createOperationLogger } from '../../src/services/operation-log';
import { readSystem } from '../../src/services/system-storage';
import { TestStorage } from './storage';

// 旧模块单测显式注入身份；完整权限测试使用下方真实登录与公开服务包装。
export function authorizeStore(username='planner'){
  const w=initialSystemWorkspace(),a=w.accounts.find(a=>a.username===username)!,r=w.roles.find(r=>r.id===a.roleId)!;
  const auth=useAuthStore();
  auth.accept({sessionId:'test-session-'+username,id:a.id,username:a.username,name:a.name,roleId:r.id,roleName:r.name,epoch:w.epoch,revision:w.revision,
    permissions:username.startsWith('kg_')?[...r.permissions]:allPermissions.filter(p=>!p.startsWith('knowledge.')||p==='knowledge.view')});
  vi.spyOn(previewService,'getSession').mockImplementation(async()=>auth.identity);
  return auth;
}
export function authFixture(){
  const storage=new TestStorage(),sessions=new TestStorage(),logger=createOperationLogger(()=>storage);
  const raw=createMockService(()=>storage,()=>sessions),service=createAccessService(()=>raw,logger,()=>{});
  const login=(username='admin')=>service.login({username,password:DEMO_PASSWORD});
  const mutation=()=>({baseRevision:readSystem(storage).revision,requestId:crypto.randomUUID()});
  const bind=()=>{const live=createAccessService(()=>raw,logger);const target=previewService as unknown as Record<string,(...args:any[])=>Promise<any>>;for(const [key,method]of Object.entries(live))vi.spyOn(target,key).mockImplementation(method);};
  return {storage,sessions,logger,raw,service,login,mutation,bind};
}

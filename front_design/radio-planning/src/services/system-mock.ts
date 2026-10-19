import type { ResourceStorage } from '../types/resource-edit';
import type { AuthIdentity, SystemParameter, SystemServices, SystemMutation, SystemWorkspace, SystemResult, OperationEvent } from '../types/system';
import { permissions, type Permission } from '../config/permissions';
import { initialSystemWorkspace, initialOperationJournal, loginCatalog, DEMO_PASSWORD, legacySystem, systemParameters } from '../mocks/system-presets';
import { readSystem, writeSystem, readJournal, writeJournal } from './system-storage';
import { readSession, writeSession, browserSessionStorage } from './session-storage';
import { systemAssert, systemSignature, systemPage, textValid, validTime } from './system-validation';
import { ApiError } from './types';

// 生效说明属于当前展示契约；旧存储定义仍按原规则严格校验，不因读参数改写历史。
function parameterDisplay(parameter:SystemParameter):SystemParameter {
  return {...parameter,description:parameter.id==='PAR-01'
    ? '设备与链路态势的 Mock 观测播放周期；下一轮采用新值，频谱使用采集源周期，其他轮询不受影响。'
    : parameter.description};
}

export function resolveSystemIdentity(storage:ResourceStorage,sessions:ResourceStorage):AuthIdentity|null {
  const s=readSession(sessions);if(!s)return null;
  const w=readSystem(storage);
  systemAssert(w.epoch===s.epoch,'系统配置已重置，请重新登录','AUTH_EXPIRED');
  const account=w.accounts.find(a=>a.id===s.accountId);
  systemAssert(account&&account.enabled,'账号已停用或不再存在，会话已失效','AUTH_DISABLED');
  const role=w.roles.find(r=>r.id===account.roleId);
  systemAssert(role,'账号角色不可用','AUTH_INVALID_ROLE');
  return {sessionId:s.id,id:account.id,username:account.username,name:account.name,roleId:role.id,roleName:role.name,permissions:[...role.permissions],epoch:w.epoch,revision:w.revision};
}
export function createSystemMock(getStorage:()=>ResourceStorage,getSessions:()=>ResourceStorage=browserSessionStorage,clock=()=>Date.now()):SystemServices {
  const now=()=>new Date(clock()).toISOString(),id=(prefix:string)=>prefix+'-'+crypto.randomUUID();
  function authorize(...required:Permission[]) {
    const actor=resolveSystemIdentity(getStorage(),getSessions());
    systemAssert(actor,'请先登录','AUTH_REQUIRED');
    systemAssert(required.every(p=>actor.permissions.includes(p)),'当前账号没有此操作权限','FORBIDDEN');
    return actor;
  }
  function transact(kind:string,r:SystemMutation,p:Permission,change:(w:SystemWorkspace)=>{objectId:string;changed:boolean}):SystemResult {
    const actor=authorize(p),storage=getStorage(),w=readSystem(storage);
    systemAssert(textValid(r.requestId)&&textValid(r.baseRevision),'缺少请求 ID 或配置基线');
    const signature=systemSignature({kind,actorId:actor.id,request:r}),receipt=w.receipts.find(x=>x.requestId===r.requestId);
    if(receipt){systemAssert(receipt.signature===signature,'请求 ID 已用于不同内容','SYSTEM_REQUEST_CONFLICT');return {revision:w.revision,objectId:receipt.objectId,changed:receipt.changed};}
    systemAssert(w.revision===r.baseRevision,'系统配置已变化，请重新加载后复核','SYSTEM_CONFLICT');
    const result=change(w);
    if(!result.changed)return {...result,revision:w.revision};
    w.revision=id('SYSM');w.receipts.push({requestId:r.requestId,signature,...result});writeSystem(storage,w);
    return {...result,revision:w.revision};
  }
  const contains=(text:unknown,q='')=>String(text).toLowerCase().includes(q.trim().toLowerCase());
  return {
    async getLoginCatalog(){return loginCatalog();},
    async login(r){
      systemAssert(r&&textValid(r.username,1,32)&&textValid(r.password,1,128),'请输入有效的演示账号和口令','AUTH_INPUT');
      const storage=getStorage(),w=readSystem(storage),a=w.accounts.find(x=>x.username===r.username.trim());
      systemAssert(a&&r.password===DEMO_PASSWORD,'演示账号或口令错误','AUTH_CREDENTIALS');
      systemAssert(a.enabled,'账号已停用','AUTH_DISABLED');
      const sessions=getSessions();
      let existing:AuthIdentity|null=null;
      try{existing=resolveSystemIdentity(storage,sessions);}catch(e){if(!(e instanceof ApiError)||!['AUTH_EXPIRED','AUTH_DISABLED','SESSION_CORRUPT'].includes(String(e.code)))throw e;}
      systemAssert(!existing||existing.id===a.id,'请先退出当前账号再切换身份','AUTH_ACTIVE_SESSION');
      if(existing)return existing;
      writeSession(sessions,{schemaVersion:1,state:'ACTIVE',id:id('SESSION'),accountId:a.id,epoch:w.epoch,loginAt:now()});
      return resolveSystemIdentity(storage,sessions)!;
    },
    async logout(){
      const sessions=getSessions();
      try{const s=readSession(sessions);if(s)writeSession(sessions,{...s,state:'SIGNED_OUT'});}
      catch(e){
        // 损坏会话允许显式退出覆盖标记；读取拒绝和写入失败仍原样报错。
        if(!(e instanceof ApiError)||e.code!=='SESSION_CORRUPT')throw e;
        writeSession(sessions,{schemaVersion:1,state:'SIGNED_OUT',id:id('SESSION'),accountId:'unknown',epoch:'unknown',loginAt:now()});
      }
    },
    async getSession(){return resolveSystemIdentity(getStorage(),getSessions());},
    async loadSystemCatalog(){
      authorize('system.view');const w=readSystem(getStorage());
      return {revision:w.revision,roles:w.roles.map(({id,name})=>({id,name})),parameters:systemParameters.map(parameterDisplay),permissions:structuredClone(permissions),legacy:structuredClone(legacySystem)};
    },
    async querySystemAccounts(q={}){
      authorize('system.accounts');const w=readSystem(getStorage());
      let events:OperationEvent[]=[];try{events=readJournal(getStorage()).events;}catch{/* 日志不可读时最近登录显示未记录，不影响账号管理。 */}
      const rows=w.accounts.filter(a=>contains(a.username+' '+a.name+' '+a.department+' '+a.id,q.query)&&(!q.roleId||a.roleId===q.roleId)&&(q.enabled===undefined||a.enabled===q.enabled)).map(a=>({...a,roleName:w.roles.find(r=>r.id===a.roleId)!.name,lastLogin:events.filter(e=>e.action==='login'&&e.outcome==='SUCCESS'&&e.actor?.id===a.id).map(e=>e.time).sort().at(-1)??null}));
      return systemPage(rows,q,w.revision,['username','name','department','roleName','enabled','lastLogin']);
    },
    async saveSystemAccount(r){
      return transact('ACCOUNT_SAVE',r,'system.accounts',w=>{
        const a=r.account;systemAssert(a&&textValid(a.username,3,32)&&textValid(a.name,1,40)&&textValid(a.department,1,60)&&textValid(a.roleId),'账号字段无效');
        const old=a.id?w.accounts.find(x=>x.id===a.id):null;
        systemAssert(!a.id||old,'账号不存在');
        systemAssert(!old||old.username===a.username.trim(),'保存后的登录名不可修改');
        const next={id:old?.id??id('SYSU'),username:a.username.trim(),name:a.name.trim(),department:a.department.trim(),roleId:a.roleId,enabled:old?.enabled??true};
        if(old&&systemSignature(old)===systemSignature(next))return {objectId:old.id,changed:false};
        if(old)Object.assign(old,next);else w.accounts.push(next);
        return {objectId:next.id,changed:true};
      });
    },
    async setSystemAccountState(r){
      return transact('ACCOUNT_STATE',r,'system.accounts',w=>{
        const a=w.accounts.find(x=>x.id===r.accountId);systemAssert(a&&typeof r.enabled==='boolean','账号或启停状态无效');
        const changed=a.enabled!==r.enabled;a.enabled=r.enabled;return {objectId:a.id,changed};
      });
    },
    async querySystemRoles(q={}){
      authorize('system.roles');const w=readSystem(getStorage());
      return systemPage(w.roles.filter(r=>contains(r.name+' '+r.description+' '+r.id,q.query)).map(r=>({...r,accountCount:w.accounts.filter(a=>a.roleId===r.id).length})),q,w.revision,['name','description','accountCount']);
    },
    async saveSystemRole(r){
      return transact('ROLE_SAVE',r,'system.roles',w=>{
        const r0=r.role;systemAssert(r0&&textValid(r0.name,1,40)&&textValid(r0.description,0,200)&&Array.isArray(r0.permissions),'角色字段无效');
        const old=r0.id?w.roles.find(x=>x.id===r0.id):null;systemAssert(!r0.id||old,'角色不存在');
        const next={id:old?.id??id('SYSR'),name:r0.name.trim(),description:r0.description.trim(),permissions:[...r0.permissions]};
        if(old&&systemSignature(old)===systemSignature(next))return {objectId:old.id,changed:false};
        if(old)Object.assign(old,next);else w.roles.push(next);
        return {objectId:next.id,changed:true};
      });
    },
    async querySystemParameters(q={}){
      authorize('system.parameters');const w=readSystem(getStorage());
      return systemPage(w.parameters.map(parameterDisplay).filter(p=>contains(p.name+' '+p.description+' '+p.id,q.query)),q,w.revision,['name','id','value']);
    },
    async saveSystemParameter(r){
      return transact('PARAMETER_SAVE',r,'system.parameters',w=>{
        const p=w.parameters.find(x=>x.id===r.parameterId);systemAssert(p&&!p.readonly,'参数不存在或只读');
        const changed=p.value!==r.value;p.value=r.value;return {objectId:p.id,changed};
      });
    },
    async queryOperationLogs(q={}){
      authorize('system.logs');const w=readJournal(getStorage());
      systemAssert((!q.from||validTime(q.from))&&(!q.to||validTime(q.to))&&(!q.from||!q.to||Date.parse(q.from)<=Date.parse(q.to)),'日志时间范围无效');
      const rows=w.events.filter(e=>contains(e.actor?.name+' '+e.actor?.id+' '+e.attemptedUsername+' '+e.objectId+' '+e.summary,q.query)&&(!q.actorId||e.actor?.id===q.actorId)&&(!q.module||e.module===q.module)&&(!q.action||e.action===q.action)&&(!q.outcome||e.outcome===q.outcome)&&(!q.from||Date.parse(e.time)>=Date.parse(q.from))&&(!q.to||Date.parse(e.time)<=Date.parse(q.to)));
      return systemPage(rows,{sort:'time',descending:true,...q},w.revision,['time','module','action','outcome','objectId'],w.epoch);
    },
    async resetSystemWorkspace(r){
      return transact('SYSTEM_RESET',r,'system.reset',w=>{
        const restored=initialSystemWorkspace();Object.assign(w,restored);w.epoch=id('SYSE');
        return {objectId:w.epoch,changed:true};
      });
    },
    async recoverSystemWorkspace(r){
      systemAssert(r&&r.username==='admin'&&r.password===DEMO_PASSWORD,'请输入内置管理员演示账号及口令','AUTH_CREDENTIALS');
      const storage=getStorage();let corrupt=false;
      try{readSystem(storage);}catch(e){if(e instanceof ApiError&&['SYSTEM_CORRUPT','SYSTEM_INCOMPATIBLE'].includes(String(e.code)))corrupt=true;else throw e;}
      systemAssert(corrupt,'健康配置不能使用损坏恢复入口','SYSTEM_RECOVERY_DENIED');
      const w=initialSystemWorkspace();w.epoch=id('SYSE');w.revision=id('SYSM');writeSystem(storage,w);
      return {revision:w.revision,objectId:w.epoch,changed:true};
    },
    async resetOperationLogs(r){
      const actor=authorize('system.logs','system.reset'),storage=getStorage();
      let current=null;try{current=readJournal(storage);}catch(e){if(!(e instanceof ApiError)||e.code!=='LOG_CORRUPT')throw e;}
      systemAssert(!current||current.revision===r.baseRevision,'日志已变化，请重新加载再确认重置','LOG_CONFLICT');
      const w=initialOperationJournal();w.revision=id('LOGM');w.epoch=id('LOGE');
      w.events.push({id:id('LOG'),epoch:w.epoch,time:now(),actor:{id:actor.id,name:actor.name,roleId:actor.roleId,roleName:actor.roleName},attemptedUsername:'',module:'系统管理',action:'resetOperationLogs',objectId:w.epoch,requestId:null,outcome:'SUCCESS',summary:'用户确认重置操作日志及旧待补记录',errorCode:'',dedupeKey:'reset:'+w.epoch});
      writeJournal(storage,w);return {revision:w.revision,objectId:w.epoch,changed:true};
    },
  };
}

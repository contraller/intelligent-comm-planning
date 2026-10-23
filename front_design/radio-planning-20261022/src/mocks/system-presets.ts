import legacy from './system.json';
import { permissions, allPermissions, type Permission } from '../config/permissions';
import { SYSTEM_PRESET_VERSION, SYSTEM_SCHEMA_VERSION } from '../config/demo';
import type { SystemWorkspace, SystemRole, SystemParameter, OperationJournal, LoginCatalog } from '../types/system';

export const DEMO_PASSWORD = 'Demo@2026';
const views = permissions.filter(p=>p.code.endsWith('.view')&&!p.code.startsWith('system.')).map(p=>p.code);
const role = (id:string,name:string,codes:Permission[],description:string):SystemRole => ({id,name,permissions:codes,description});
export const systemRoles = [
  // 内置管理员覆盖完整 Mock 演示流程，其他角色仍保留原有职责。
  role('ROLE-ADMIN','系统管理员',[...allPermissions],'全部模块演示权限；内置 admin 可审核本人提交的知识变更'),
  role('ROLE-RESOURCE','资源维护员',['situation.view','resources.view','resources.edit'],'维护节点、设备、干扰源、导入及频谱配置'),
  role('ROLE-PLANNER','规划诊断人员',['situation.view','resources.view','planning.view','planning.execute','planning.save','planning.confirm','diagnosis.view','diagnosis.scenario','diagnosis.execute','diagnosis.export'],'规划及故障场景、诊断和报告'),
  role('ROLE-KG-EDITOR','知识编辑人',['knowledge.view','knowledge.edit'],'维护本人知识草稿'),
  role('ROLE-KG-REVIEWER','知识审核人',['knowledge.view','knowledge.review','knowledge.publish','knowledge.rollback','knowledge.reset'],'审核他人变更、发布和回滚'),
  role('ROLE-VIEWER','只读观察员',views,'只读查看各业务模块'),
];
export const systemParameters: SystemParameter[] = [
  {id:'PAR-01',name:'状态采集间隔',value:30,unit:'s',description:'设备与链路态势的 Mock 观测播放周期；下一轮采用新值，频谱使用采集源周期，其他轮询不受影响。',readonly:false,min:1,max:3600},
  {id:'PAR-02',name:'接口请求超时',value:15,unit:'s',description:'演示配置，尚未接入 HTTP 客户端。',readonly:false,min:1,max:120},
  {id:'PAR-03',name:'默认坐标系',value:'EPSG:4326',unit:'',description:'对外固定 WGS84，经度在前、纬度在后。',readonly:true,min:null,max:null},
];
// 内置知识账号与当前预设草稿、历史记录使用相同身份 ID。
export function initialSystemWorkspace(): SystemWorkspace {
  return structuredClone({
    schemaVersion:SYSTEM_SCHEMA_VERSION,presetVersion:SYSTEM_PRESET_VERSION,revision:'system-initial',epoch:'system-epoch-initial',
    roles:systemRoles,parameters:systemParameters,receipts:[],
    accounts:[
      {id:'SYS-ADMIN',username:'admin',name:'演示管理员',department:'教学管理中心',roleId:'ROLE-ADMIN',enabled:true},
      {id:'SYS-RESOURCE',username:'resource',name:'资源维护员',department:'通信教学组',roleId:'ROLE-RESOURCE',enabled:true},
      {id:'SYS-PLANNER',username:'planner',name:'规划教员',department:'通信教学组',roleId:'ROLE-PLANNER',enabled:true},
      {id:'KG-EDITOR',username:'kg_editor',name:'知识编辑人',department:'教研保障组',roleId:'ROLE-KG-EDITOR',enabled:true},
      {id:'KG-REVIEWER',username:'kg_reviewer',name:'知识审核人',department:'教研保障组',roleId:'ROLE-KG-REVIEWER',enabled:true},
      {id:'SYS-VIEWER',username:'viewer',name:'演示观察员',department:'教学管理中心',roleId:'ROLE-VIEWER',enabled:true},
      {id:'SYS-DISABLED',username:'disabled_viewer',name:'停用观察员',department:'教学管理中心',roleId:'ROLE-VIEWER',enabled:false},
    ],
  });
}
export const initialOperationJournal = ():OperationJournal => ({schemaVersion:1,revision:'logs-initial',epoch:'logs-epoch-initial',events:[]});
export function loginCatalog():LoginCatalog {
  const w=initialSystemWorkspace();
  return {passwordHint:DEMO_PASSWORD,accounts:w.accounts.map(a=>({username:a.username,name:a.name,enabled:a.enabled,role:w.roles.find(r=>r.id===a.roleId)!.name}))};
}
export const legacySystem = legacy;

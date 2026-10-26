import type { KnowledgeWorkspace,KnowledgeIdentitySnapshot,KnowledgeActor } from '../types/knowledge';
import type { AuthIdentity } from '../types/system';
import { ApiError } from './types';

// 仅内置 admin 在管理员角色下享有 Mock 自审例外，历史记录使用当时的身份快照。
export function canSelfReviewKnowledge(actor:Pick<AuthIdentity,'id'|'roleId'>|null|undefined) {
  return actor?.id==='SYS-ADMIN'&&actor.roleId==='ROLE-ADMIN';
}

// 仅追加工作区元数据，原变更/提交/版本/日志对象保持原字节含义。
export function knowledgeIdentityReferences(w:KnowledgeWorkspace) {
  const refs:{key:string;id:string;role:KnowledgeActor['role']}[]=[];
  for(const v of w.versions)refs.push({key:'version:'+v.id,id:v.actorId,role:'REVIEWER'});
  for(const c of w.changes){
    refs.push({key:'change:'+c.id,id:c.authorId,role:'EDITOR'});
    for(const s of c.submissions){
      refs.push({key:'submit:'+c.id+':'+s.number,id:s.actorId,role:'EDITOR'});
      if(s.review)refs.push({key:'review:'+c.id+':'+s.number,id:s.review.actorId,role:s.outcome==='WITHDRAWN'?'EDITOR':'REVIEWER'});
    }
  }
  for(const l of w.logs)refs.push({key:'log:'+l.id,id:l.actorId,role:['SAVE','SUBMIT','WITHDRAW'].includes(l.action)?'EDITOR':'REVIEWER'});
  return refs;
}
// 初始记录使用固定账号快照，后续操作仍由统一登录身份授权。
export function presetKnowledgeIdentity(id:string,role:KnowledgeActor['role']):KnowledgeIdentitySnapshot {
  if(id!==(role==='EDITOR'?'KG-EDITOR':'KG-REVIEWER'))throw new ApiError('知识身份与记录角色不一致','KNOWLEDGE_CORRUPT');
  return {key:'',id,name:role==='EDITOR'?'知识编辑人':'知识审核人',role,roleId:role==='EDITOR'?'ROLE-KG-EDITOR':'ROLE-KG-REVIEWER',roleName:role==='EDITOR'?'知识编辑人':'知识审核人'};
}
export function captureKnowledgeIdentity(w:KnowledgeWorkspace,actor:KnowledgeIdentitySnapshot) {
  w.identitySnapshots??=[];
  for(const r of knowledgeIdentityReferences(w))if(!w.identitySnapshots.some(s=>s.key===r.key)){
    if(r.id!==actor.id||r.role!==actor.role)throw new ApiError('新增知识记录与当前操作身份不一致','KNOWLEDGE_FORBIDDEN');
    w.identitySnapshots.push({...actor,key:r.key});
  }
}
export function currentKnowledgeIdentity(a:AuthIdentity,role:KnowledgeActor['role']):KnowledgeIdentitySnapshot {
  return {key:'',id:a.id,name:a.name,role,roleId:a.roleId,roleName:a.roleName};
}
export function historicalKnowledgeIdentity(w:KnowledgeWorkspace,key:string,id:string,role?:KnowledgeActor['role']) {
  const s=w.identitySnapshots?.find(s=>s.key===key);
  if(!s||s.id!==id||(role&&s.role!==role))throw new ApiError('知识历史身份快照缺失或关联不一致','KNOWLEDGE_CORRUPT');
  return s;
}
export function validateKnowledgeIdentities(w:KnowledgeWorkspace) {
  const refs=knowledgeIdentityReferences(w),snapshots=w.identitySnapshots;
  if(!Array.isArray(snapshots)||snapshots.length!==refs.length||new Set(snapshots.map(s=>s.key)).size!==snapshots.length)throw new ApiError('知识身份快照不完整或重复','KNOWLEDGE_CORRUPT');
  for(const r of refs){
    const s=historicalKnowledgeIdentity(w,r.key,r.id,r.role);
    if(!s.name?.trim()||s.name.length>40||!s.roleId?.trim()||!s.roleName?.trim()||s.roleName.length>40)throw new ApiError('知识历史身份内容无效','KNOWLEDGE_CORRUPT');
  }
}

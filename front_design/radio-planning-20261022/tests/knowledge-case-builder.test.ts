import { describe,it,expect } from 'vitest';
import { initialKnowledgeWorkspace,knowledgeCatalog } from '../src/mocks/knowledge-presets';
import { buildKnowledgeCases } from '../src/services/knowledge-case-builder';
import type { KnowledgeCaseInput } from '../src/types/knowledge-case';
const sample=():KnowledgeCaseInput=>({caseId:'FC-TEST-NEW',title:'测试案例',faultType:'HW_FAILURE',objectType:'DEVICE',deviceClass:'',cause:'测试原因',component:'',solution:'测试处置',source:'构造测试资料，不作为现场证据',symptoms:['测试现象'],steps:[{order:2,text:'复核运行状态'},{order:1,text:'检查供电连接'}]});
const base=()=>structuredClone(initialKnowledgeWorkspace().versions.at(-1)!);
describe('结构化案例构建的业务保护',()=>{
  it('生成可追溯案例中心和有序步骤，选填缺失不补虚构部件',()=>{
    const input=sample(),before=structuredClone(input),result=buildKnowledgeCases([input],base(),knowledgeCatalog());expect(result.issues).toEqual([]);
    const draft=result.draft!,fault=draft.entities.find(e=>e.type==='Fault')!;
    expect(draft.relations.filter(r=>r.head===fault.id).map(r=>r.type)).toEqual(expect.arrayContaining(['recordedIn','instanceOf','occursOn','hasSymptom','causedBy','resolvedBy','diagnosedBy']));
    expect(draft.entities.filter(e=>e.type==='DiagnosisStep').map(e=>e.name)).toEqual(['01:检查供电连接','02:复核运行状态']);
    expect(draft.entities.some(e=>e.type==='Component')).toBe(false);expect(draft.relations.some(r=>r.type==='constrainedBy')).toBe(false);
    expect(draft.entities.every(e=>e.source===input.source)).toBe(true);expect(input).toEqual(before);
  });
  it('一条非法记录使整批无草稿，拒绝错误对象类型和步骤跳号',()=>{
    const bad={...sample(),caseId:'FC-BAD',faultType:'LINK_DOWN',objectType:'DEVICE',steps:[{order:3,text:'检查'}]};
    const result=buildKnowledgeCases([sample(),bad],base(),knowledgeCatalog());expect(result.draft).toBeNull();expect(result.issues.map(e=>e.message).join('；')).toContain('搭配无效');expect(result.issues.map(e=>e.message).join('；')).toContain('连续');
  });
  it('精确复用且不覆盖原来源；全重复时不提交空草稿，原案例不同原因拒绝追加',()=>{
    const published=base(),input=sample(),first=buildKnowledgeCases([input],published,knowledgeCatalog()).draft!;
    published.entities.push(...first.entities);published.relations.push(...first.relations);const before=structuredClone(published);
    const duplicate=buildKnowledgeCases([{...input,source:'另一个输入来源'}],published,knowledgeCatalog());expect(duplicate.draft).toBeNull();expect(duplicate.issues[0].message).toContain('无可生成');expect(duplicate.skippedRelations).toBe(first.relations.length);
    const conflict=buildKnowledgeCases([{...input,cause:'另一个根因'}],published,knowledgeCatalog());expect(conflict.draft).toBeNull();expect(conflict.issues.some(e=>e.message.includes('内容不同'))).toBe(true);expect(published).toEqual(before);
  });
  it('按展开后的实体关系数限制容量，100项允许、超限整批拒绝',()=>{
    const input=sample();input.symptoms=['功放过温现象'];input.steps=Array.from({length:44},(_,i)=>({order:i+1,text:'测试步骤'+i}));
    const result=buildKnowledgeCases([input],base(),knowledgeCatalog());expect(result.issues).toEqual([]);expect(result.entityCount+result.relationCount).toBe(100);
    const overflow=buildKnowledgeCases([{...input,component:'测试部件'}],base(),knowledgeCatalog());expect(overflow.draft).toBeNull();expect(overflow.issues.some(e=>e.field==='容量')).toBe(true);
  });
  it.each(['替换','追加','删减'] as const)('已有案例步骤%s时整批拒绝，不追加第二条同序号步骤',action=>{
    const published=base(),input=sample(),original=buildKnowledgeCases([input],published,knowledgeCatalog()).draft!;
    published.entities.push(...original.entities);published.relations.push(...original.relations);const before=structuredClone(published);
    const steps=action==='替换'?[{order:1,text:'改查馈线'},{order:2,text:'复核运行状态'}]:action==='追加'?[...input.steps,{order:3,text:'补充检查'}]:[{order:1,text:'检查供电连接'}];
    const result=buildKnowledgeCases([{...input,steps}],published,knowledgeCatalog());
    expect(result.draft).toBeNull();expect(result.issues.some(e=>e.message.includes('步骤集合不同'))).toBe(true);expect(published).toEqual(before);
  });
  it('新增对象使用临时身份，子表业务错误保留原始行号',()=>{
    const valid=buildKnowledgeCases([sample()],base(),knowledgeCatalog()).draft!;
    expect([...valid.entities,...valid.relations].every(e=>e.id.startsWith('new:'))).toBe(true);
    const input={...sample(),row:2,symptoms:['重复现象','重复现象'],symptomRows:[5,9],steps:[{order:2,text:'检查',row:12}]};
    const result=buildKnowledgeCases([input],base(),knowledgeCatalog());expect(result.draft).toBeNull();
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({sheet:'故障现象',row:9,message:'同一案例的现象重复'}),expect.objectContaining({sheet:'排故步骤',row:12})]));
  });
});

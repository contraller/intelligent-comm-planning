import { describe, expect, it } from 'vitest';
import { initialKnowledgeWorkspace } from '../src/mocks/knowledge-presets';
import { deviceKnowledgeSnapshot, knowledgeEntityDetail, queryKnowledgeSnapshot, searchKnowledgeSnapshot } from '../src/services/knowledge-query';
import type { KnowledgeCategory } from '../src/types/knowledge';

const categories:KnowledgeCategory[]=['设备知识','网络态势知识','故障运维知识'];
describe('知识发布查询',()=>{
  // 验证用户可见正文及单位能找到同一发布版的知识。
  it.each([['错误比特比例','KGE-METRIC'],['接收灵敏度','KGE-PARAMETER'],['dBi','KGE-PARAMETER'],['业务通联复测','KGE-STEP']])('属性检索 %s 命中 %s', (search,id)=>{
    const w=initialKnowledgeWorkspace(),q={versionId:w.currentVersionId,categories,search};
    expect(searchKnowledgeSnapshot(w,q).items.map(e=>e.id)).toContain(id);
    const graph=queryKnowledgeSnapshot(w,q);expect(graph.matchedIds).toContain(id);
    expect(graph.entities.some(e=>!graph.matchedIds.includes(e.id))).toBe(true);
  });
  // 类型名称与正文一起可读、可检索，不把检查动作当成配接对象。
  it('天线名称与链路余量符号说明来自当前版本并可检索',()=>{
    const w=initialKnowledgeWorkspace(),q={versionId:w.currentVersionId,categories};
    expect(knowledgeEntityDetail(w,w.currentVersionId,'KGE-ANTENNA').entity).toMatchObject({name:'短波天线',type:'Antenna'});
    expect(searchKnowledgeSnapshot(w,{...q,search:'短波天线'}).items.map(entity=>entity.id)).toContain('KGE-ANTENNA');
    expect(searchKnowledgeSnapshot(w,{...q,search:'M 表示链路余量'}).items.map(entity=>entity.id)).toEqual(['KGE-RULE']);
  });
  it('设备字段和排障阶段有完整内容，原理与规则已存入两个版本',()=>{
    const w=initialKnowledgeWorkspace();
    for(const v of w.versions){
      const attributes=v.entities.filter(e=>e.category==='设备知识').flatMap(e=>e.attributes.map(a=>a.name));
      for(const name of ['设备名称','型号','类别','厂家','组成接口','功能名称','工作模式','支持业务类型','功能约束条件','工作频段','发射功率','接收灵敏度','调制方式','信道带宽','天线增益'])expect(attributes).toContain(name);
      expect(v.entities.find(e=>e.id==='KGE-STEP')!.attributes.map(a=>a.name)).toEqual(['1. 故障发现','2. 分析诊断','3. 根因定位','4. 处置恢复','5. 恢复验证']);
      expect(v.entities.find(e=>e.id==='KGE-PRINCIPLE')!.principleFlow?.steps).toHaveLength(4);
      expect(v.entities.find(e=>e.id==='KGE-RULE')!.networkRule?.criteria).toHaveLength(4);
    }
  });
  it('明确版本查询，草稿内容和审核通过前的输入不泄漏',()=>{const w=initialKnowledgeWorkspace();const q={versionId:w.currentVersionId,categories,search:'操作时间'};expect(searchKnowledgeSnapshot(w,q).total).toBe(0);expect(knowledgeEntityDetail(w,w.currentVersionId,'KGE-OPERATION').entity.description).not.toContain('操作时间');});
  it('分页稳定，类型、关键词、描述和 ID 可检索',()=>{const w=initialKnowledgeWorkspace(),q={versionId:w.currentVersionId,categories};const first=searchKnowledgeSnapshot(w,q),last=searchKnowledgeSnapshot(w,{...q,pageNum:2});expect(first.items).toHaveLength(20);expect(last.items.length).toBe(first.total-20);expect(searchKnowledgeSnapshot(w,{...q,search:'射频'}).items.some(e=>e.id==='KGE-PRINCIPLE')).toBe(true);expect(searchKnowledgeSnapshot(w,{...q,type:'Symptom'}).total).toBe(1);expect(searchKnowledgeSnapshot(w,{...q,search:'kge-model'}).total).toBe(1);});
  it('只对既定别名返回推荐，不编造相似度和任意推荐',()=>{const w=initialKnowledgeWorkspace(),q={versionId:w.currentVersionId,categories};const r=searchKnowledgeSnapshot(w,{...q,search:'发烫'});expect(r.code).toBe(4001);expect(r.similar.map(e=>e.id)).toEqual(['KGE-SYMPTOM','KGE-SOLUTION']);expect(searchKnowledgeSnapshot(w,{...q,search:'完全未知词'}).similar).toHaveLength(0);expect(searchKnowledgeSnapshot(w,{...q,categories:[],search:'发烫'}).similar).toHaveLength(0);});
  it('单类图不画跨类边，详情保留可定位的跨类邻居',()=>{const w=initialKnowledgeWorkspace();const graph=queryKnowledgeSnapshot(w,{versionId:w.currentVersionId,categories:['故障运维知识']});expect(graph.relations.some(r=>r.tail==='KGE-POWER')).toBe(false);const detail=knowledgeEntityDetail(w,w.currentVersionId,'KGE-SYMPTOM');expect(detail.neighbors.some(e=>e.id==='KGE-POWER')).toBe(true);});
  it('一跳按展开顺序加入节点，跨类必须明确选择，收起可恢复',()=>{const w=initialKnowledgeWorkspace(),q={versionId:w.currentVersionId,categories,focusId:'KGE-MODEL'};const root=queryKnowledgeSnapshot(w,q);expect(root.entities).toHaveLength(1);const expanded=queryKnowledgeSnapshot(w,{...q,expandedIds:['KGE-MODEL','KGE-POWER']});expect(expanded.entities.some(e=>e.id==='KGE-SYMPTOM')).toBe(true);const collapsed=queryKnowledgeSnapshot(w,{...q,expandedIds:['KGE-MODEL']});expect(collapsed.entities.some(e=>e.id==='KGE-SYMPTOM')).toBe(false);expect(queryKnowledgeSnapshot(w,{...q,categories:['设备知识'],expandedIds:['KGE-MODEL','KGE-POWER']}).entities.some(e=>e.id==='KGE-SYMPTOM')).toBe(false);});
  it('型号知识只查明确关联，旧版和当前内容各自固定',()=>{const w=initialKnowledgeWorkspace();const old=deviceKnowledgeSnapshot(w,{versionId:w.versions[0].id,modelId:'DM-0001',search:'日常维护'});const current=deviceKnowledgeSnapshot(w,{versionId:w.currentVersionId,modelId:'DM-0001',search:'日常维护'});expect(old.items[0].entity.description).not.toContain('复查');expect(current.items[0].entity.description).toContain('复查');expect(deviceKnowledgeSnapshot(w,{versionId:w.currentVersionId,modelId:'DM-0003'}).items).toHaveLength(0);expect(()=>deviceKnowledgeSnapshot(w,{versionId:w.currentVersionId,modelId:'HF'})).toThrow('型号不存在');});
  it('空分类与缺失版本/实体都准确反馈，不能悄悄选第一项',()=>{const w=initialKnowledgeWorkspace();expect(queryKnowledgeSnapshot(w,{versionId:w.currentVersionId,categories:[]}).entities).toHaveLength(0);expect(()=>knowledgeEntityDetail(w,'missing','KGE-MODEL')).toThrow('版本不存在');expect(()=>knowledgeEntityDetail(w,w.currentVersionId,'missing')).toThrow('实体不在');expect(()=>queryKnowledgeSnapshot(w,{versionId:w.currentVersionId,categories,focusId:'missing'})).toThrow('聚焦实体不存在');});
  it('返回数据独立复制，关系权重缺失保留 null',()=>{const w=initialKnowledgeWorkspace(),d=knowledgeEntityDetail(w,w.currentVersionId,'KGE-MODEL');d.entity.name='外部改动';expect(w.versions[1].entities[0].name).not.toBe('外部改动');expect(d.relations[0].weight).toBeNull();});
});

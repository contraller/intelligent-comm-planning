import { describe, expect, it } from 'vitest';
import { initialKnowledgeWorkspace, knowledgeRelationTypes, knowledgeTypes } from '../src/mocks/knowledge-presets';
import { queryKnowledgeSnapshot } from '../src/services/knowledge-query';
import { knowledgeGraphModel } from '../src/graphs/knowledge-graph';
const types=knowledgeTypes.map(t=>t.id),names=Object.fromEntries(knowledgeRelationTypes.map(t=>[t.id,t.name]));
describe('知识图形展示数据',()=>{
  // 上限限制绘制数量，命中优先和图例仍需保持完整可辨。
  it('截断优先显示后排命中，背景保留且图中没有悬空关系',()=>{
    const w=initialKnowledgeWorkspace(),v=w.versions[1];v.entities=Array.from({length:75},(_,i)=>({...v.entities[0],id:'test-'+i}));v.relations=[];
    const graph=queryKnowledgeSnapshot(w,{versionId:v.id,categories:['设备知识'],search:'test-74'});
    expect(graph.matchedIds).toEqual(['test-74']);expect(graph.entities[0].id).toBe('test-74');expect(graph.entities).toHaveLength(60);expect(graph.totalNodes).toBe(75);
    const model=knowledgeGraphModel(graph,'',types,names,graph.matchedIds);
    expect(new Set(model.nodes.map(n=>`${n.x},${n.y}`)).size).toBe(60);
    expect(model.nodes.find(n=>n.id==='test-74')!.label.show).toBe(true);
    expect(model.nodes.some(n=>!n.label.show)).toBe(true);
  });
  it('同类不同实体类型有不同配色，各类图例只列实际显示类型',()=>{
    const w=initialKnowledgeWorkspace(),graph=queryKnowledgeSnapshot(w,{versionId:w.currentVersionId,categories:['设备知识']});
    const model=knowledgeGraphModel(graph,'',types,names);
    expect(model.legend.map(g=>g.name)).toEqual(['设备知识']);
    expect(model.legend[0].items.map(i=>i.type)).toContain('Interface');
    expect(model.nodes.find(n=>n.id==='KGE-MODEL')!.itemStyle.color).not.toBe(model.nodes.find(n=>n.id==='KGE-POWER')!.itemStyle.color);
  });
  it('实体/关系保留 ID，聚焦节点居中高亮并保留分类图例',()=>{const w=initialKnowledgeWorkspace(),graph=queryKnowledgeSnapshot(w,{versionId:w.currentVersionId,categories:['设备知识','网络态势知识','故障运维知识']});const m=knowledgeGraphModel(graph,'KGE-MODEL',types,names);expect(m.nodes.find(n=>n.id==='KGE-MODEL')).toMatchObject({x:450,y:300,symbolSize:76});expect(m.legend).toHaveLength(3);expect(new Set(m.nodes.map(n=>n.symbol)).size).toBeGreaterThan(1);expect(m.links[0].id).toBe(graph.relations[0].id);expect(m.truncated).toBe(false);});
  it('显示上限保留总数，边不指向未显示节点',()=>{const w=initialKnowledgeWorkspace(),v=w.versions[1];v.entities=Array.from({length:75},(_,i)=>({...v.entities[0],id:'test-'+i}));v.relations=Array.from({length:140},(_,i)=>({...v.relations[0],id:'edge-'+i,head:'test-'+Math.floor(i/74),tail:'test-'+(i%74+1)}));const graph=queryKnowledgeSnapshot(w,{versionId:v.id,categories:['设备知识']});expect(graph.entities).toHaveLength(60);expect(graph.relations.length).toBeLessThanOrEqual(120);expect(graph.totalNodes).toBe(75);expect(graph.totalEdges).toBe(140);const ids=new Set(graph.entities.map(e=>e.id));expect(graph.relations.every(r=>ids.has(r.head)&&ids.has(r.tail))).toBe(true);expect(knowledgeGraphModel(graph,'',types,names).truncated).toBe(true);});
  it('画布外的匹配对象仍可作为聚焦根节点',()=>{const w=initialKnowledgeWorkspace(),v=w.versions[1];v.entities=Array.from({length:75},(_,i)=>({...v.entities[0],id:'test-'+i}));v.relations=[];const graph=queryKnowledgeSnapshot(w,{versionId:v.id,categories:['设备知识'],focusId:'test-74'});expect(graph.entities.map(e=>e.id)).toEqual(['test-74']);});
  it('布局仅产生图形字段，不改原实体与关系业务值',()=>{const w=initialKnowledgeWorkspace(),q={versionId:w.currentVersionId,categories:['设备知识'] as const};const graph=queryKnowledgeSnapshot(w,{...q,categories:[...q.categories]});const original=JSON.stringify(graph);knowledgeGraphModel(graph,graph.entities[0].id,types,names);expect(JSON.stringify(graph)).toBe(original);});

  // 高亮仅为展示字段，不改变分类语义或原始关系。
  it('多个命中保留原类别和形状，用描边高亮；非命中弱化',()=>{
    const w=initialKnowledgeWorkspace(),graph=queryKnowledgeSnapshot(w,{versionId:w.currentVersionId,categories:['设备知识','网络态势知识','故障运维知识']});
    const ids=['KGE-POWER','KGE-LINK'],base=knowledgeGraphModel(graph,'',types,names),before=JSON.stringify(graph);
    const model=knowledgeGraphModel(graph,'',types,names,ids);
    for(const id of ids) {
      const hit=model.nodes.find(n=>n.id===id)!,original=base.nodes.find(n=>n.id===id)!;
      expect(hit.itemStyle).toMatchObject({color:original.itemStyle.color,borderColor:'#f0ce79',borderWidth:3,opacity:1});
      expect(hit.symbol).toBe(original.symbol);expect(hit.symbolSize).toBe(58);
    }
    expect(model.nodes.find(n=>n.id==='KGE-MODEL')!.itemStyle.opacity).toBe(0.55);
    expect(model.links.map(e=>e.id)).toEqual(base.links.map(e=>e.id));expect(JSON.stringify(graph)).toBe(before);
  });
  it('明确选中优先于命中概览，空高亮列表保持原分类样式',()=>{
    const w=initialKnowledgeWorkspace(),graph=queryKnowledgeSnapshot(w,{versionId:w.currentVersionId,categories:['设备知识','网络态势知识','故障运维知识']});
    const selected=knowledgeGraphModel(graph,'KGE-MODEL',types,names,['KGE-POWER','KGE-LINK']);
    expect(selected.nodes.find(n=>n.id==='KGE-MODEL')).toMatchObject({x:450,y:300,symbolSize:76,itemStyle:{borderColor:'#eef9ff',opacity:1}});
    expect(selected.nodes.find(n=>n.id==='KGE-POWER')).toMatchObject({symbolSize:48,itemStyle:{borderWidth:1,opacity:0.55}});
    expect(knowledgeGraphModel(graph,'',types,names,[])).toEqual(knowledgeGraphModel(graph,'',types,names));
    expect(knowledgeGraphModel({...graph,entities:[],relations:[],totalNodes:0,totalEdges:0},'',types,names,[]).nodes).toEqual([]);
  });
});

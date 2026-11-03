import { describe, expect, it } from 'vitest';
import { knowledgeIcon, knowledgeMedia } from '../src/config/knowledge-media';
import { knowledgeGraphModel } from '../src/graphs/knowledge-graph';
import { readKnowledgeGraph } from '../src/services/knowledge-http-validation';
import type { KnowledgeEntitySummary, KnowledgeGraph } from '../src/types/knowledge';
const entity = (name: string, type = 'DeviceModel'): KnowledgeEntitySummary => ({
  id: 'entity-a',
  name,
  type,
  category: '设备知识',
});
describe('知识实物图片', () => {
  it('只匹配明确型号和通用馈线，不把其他电台或天线误配', () => {
    expect(knowledgeMedia({...entity('DM-0001'),modelName:'AN/PRC-150(C)'})?.url).toContain('radio-prc150.png');
    expect(knowledgeMedia({...entity('DM-0008'),modelName:'FT-891'})?.url).toContain('radio-ft891.png');
    expect(knowledgeMedia(entity('AN/PRC-150(C)'))?.url).toContain('radio-prc150.png');
    expect(knowledgeMedia(entity('FT-891'))?.url).toContain('radio-ft891.png');
    expect(knowledgeMedia(entity('天线馈线', 'Component'))?.url).toContain('antenna-feedline.png');
    for (const name of ['RF-7800H-MP', '短波电台型号知识', 'DM-0001', 'AN/PRC-150(C)、RF-7800H-MP'])
      expect(knowledgeMedia(entity(name))).toBeNull();
    expect(knowledgeMedia(entity('短波天线', 'Antenna'))).toBeNull();
    expect(
      knowledgeMedia({
        ...entity('FT-891'),
        attributes: [{ name: 'model_name', value: 'RF-7800H-MP', unit: null }],
      }),
    ).toBeNull();
  });
  it('节点ID、关系与布局保持原值；缺照片时使用本地电台图标', () => {
    const graph: KnowledgeGraph = {
        versionId: 'KGV-1',
        entities: [entity('FT-891')],
        relations: [],
        totalNodes: 1,
        totalEdges: 0,
        matchedIds: [],
      },
      before = JSON.stringify(graph);
    const photo = knowledgeGraphModel(graph, '', ['DeviceModel'], {}).nodes[0];
    expect(photo.symbol).toContain('image://');
    expect(photo.symbolKeepAspect).toBe(true);
    const fallback = knowledgeGraphModel(graph, '', ['DeviceModel'], {}, [], undefined, new Set())
      .nodes[0];
    expect(fallback.symbol).toBe('image://' + knowledgeIcon('DeviceModel').url);
    expect(fallback.id).toBe(photo.id);
    expect([fallback.x, fallback.y]).toEqual([photo.x, photo.y]);
    expect(JSON.stringify(graph)).toBe(before);
  });
  it('同版型号名称仅接受有效型号实体的非空文本；缺属性保留符号',()=>{
    const graph:KnowledgeGraph={versionId:'KGV-1',entities:[{...entity('DM-0001'),modelName:'AN/PRC-150(C)'}],relations:[],totalNodes:1,totalEdges:0,matchedIds:[]};
    expect(readKnowledgeGraph(graph,'KGV-1').entities[0].modelName).toBe('AN/PRC-150(C)');
    for(const modelName of [null,12,'', 'x'.repeat(501)])expect(()=>readKnowledgeGraph({...graph,entities:[{...graph.entities[0],modelName}]},'KGV-1')).toThrow();
    expect(()=>readKnowledgeGraph({...graph,entities:[{...graph.entities[0],type:'Component'}]},'KGV-1')).toThrow();
    expect(knowledgeMedia(entity('DM-0001'))).toBeNull();
  });
});

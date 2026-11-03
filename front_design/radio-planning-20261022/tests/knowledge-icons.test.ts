import { describe, expect, it } from 'vitest';
import { knowledgeIcon, knowledgeMedia } from '../src/config/knowledge-media';
import { knowledgeTypeLabels } from '../src/services/knowledge-display';
import { knowledgeGraphModel } from '../src/graphs/knowledge-graph';
import type { KnowledgeGraph } from '../src/types/knowledge';

describe('local semantic knowledge icons', () => {
  it('every current entity type has a distinct self-contained pictogram and stable meaning', () => {
    const values = Object.keys(knowledgeTypeLabels).map(type => knowledgeIcon(type));
    expect(new Set(values.map(value => value.url)).size).toBe(values.length);
    for (const icon of values) {
      expect(icon.url).toMatch(/^data:image\/svg\+xml;charset=UTF-8,/);
      expect(icon.label).not.toContain('其他知识');
      const svg = decodeURIComponent(icon.url.split(',')[1]);
      expect(svg).toContain('viewBox="0 0 64 64"');
      expect(svg).toContain(icon.color);
      expect(svg).not.toMatch(/<(?:script|image|foreignObject)|\son\w+=|href=|url\(/i);
    }
    expect(knowledgeIcon('Manufacturer').label).toContain('工厂');
    expect(knowledgeIcon('Parameter').label).toContain('仪表');
    expect(knowledgeIcon('Cause').label).toContain('查找');
    expect(knowledgeIcon('DiagnosisStep').label).toContain('清单');
    expect(knowledgeIcon('Component').label).toContain('芯片');
  });

  it('unknown types use a knowledge-entry icon without interpolating untrusted type text', () => {
    const unknown = knowledgeIcon('OtherType');
    expect(knowledgeIcon('<script>alert(1)</script>')).toBe(unknown);
    expect(knowledgeIcon('__proto__')).toBe(unknown);
    expect(unknown.label).toContain('其他知识实体');
  });

  it('graph and legend use the same type pictograms independent of catalog order, retaining ids and layout', () => {
    const types = ['Manufacturer', 'Parameter', 'Node', 'Link', 'Cause', 'DiagnosisStep'];
    const graph: KnowledgeGraph = { versionId: 'KGV-TEST', totalNodes: types.length, totalEdges: 1, matchedIds: [],
      entities: types.map((type, index) => ({ id: `E${index}`, name: `实体${index}`, type,
        category: index < 2 ? '设备知识' : index < 4 ? '网络态势知识' : '故障运维知识' })),
      relations: [{ id: 'R1', head: 'E0', tail: 'E1', type: 'hasParameter', weight: null, source: '受控构造' }] };
    const before = JSON.stringify(graph);
    const model = knowledgeGraphModel(graph, '', types, {}), reordered = knowledgeGraphModel(graph, '', [...types].reverse(), {});
    expect(model).toEqual(reordered);
    for (const entity of graph.entities) {
      const node = model.nodes.find(row => row.id === entity.id)!, legend = model.legend.flatMap(group => group.items).find(row => row.type === entity.type)!;
      expect(node.symbol).toBe('image://' + legend.url);
      expect(node.itemStyle.color).toBe(legend.color);
    }
    expect(model.links[0]).toMatchObject({ id: 'R1', source: 'E0', target: 'E1' });
    expect(knowledgeGraphModel(graph, 'E0', types, {}).nodes.find(row => row.id === 'E0')!.itemStyle)
      .toMatchObject({ shadowBlur: 14, shadowColor: '#eef9ff' });
    expect(knowledgeGraphModel(graph, '', types, {}, ['E1']).nodes.find(row => row.id === 'E1')!.itemStyle)
      .toMatchObject({ shadowBlur: 10, shadowColor: '#f0ce79' });
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('exact-model photographs remain preferred, and unrelated models never borrow them', () => {
    const entity = { id: 'MODEL', name: '型号', type: 'DeviceModel', category: '设备知识' as const, modelName: 'FT-891' };
    const graph: KnowledgeGraph = { versionId: 'KGV-TEST', totalNodes: 1, totalEdges: 0, matchedIds: [], entities: [entity], relations: [] };
    const photo = knowledgeMedia(entity)!;
    expect(knowledgeGraphModel(graph, '', [], {}, [], undefined, new Set([photo.url])).nodes[0].symbol).toBe('image://' + photo.url);
    expect(knowledgeGraphModel(graph, '', [], {}, [], undefined, new Set()).nodes[0].symbol).toBe('image://' + knowledgeIcon(entity.type).url);
    expect(knowledgeMedia({ ...entity, modelName: 'FT-891-OTHER' })).toBeNull();
    expect(knowledgeGraphModel({ ...graph, entities: [{ ...entity, modelName: 'FT-891-OTHER' }] }, '', [], {}).nodes[0].symbol)
      .toBe('image://' + knowledgeIcon(entity.type).url);
  });
});

import { describe, expect, it } from 'vitest';
import {
  describeKnowledge, knowledgeAttributeName, knowledgeAttributeValue, knowledgeEntityName,
  knowledgeRelationName, knowledgeSource, knowledgeText, knowledgeTypeLabels, knowledgeTypeName,
} from '../src/services/knowledge-display';
import { knowledgeGraphModel } from '../src/graphs/knowledge-graph';
import type { KnowledgeEntity, KnowledgeGraph } from '../src/types/knowledge';

const entity: KnowledgeEntity = {
  id: 'KGE-DV-0001', type: 'Device', name: 'DV-0001', category: '设备知识',
  description: 'CONSTRUCTED', source: 'devices_v1.csv#DV-0001 [CONSTRUCTED]',
  keywords: ['HF', 'NORMAL'], modelIds: ['DM-0001'],
  attributes: [{ name: 'device_selftest', value: 'ALARM_PA', unit: null }],
};

describe('知识图谱中文展示边界', () => {
  it('受控本体、枚举、属性中文化，未知扩展保持原文', () => {
    expect(knowledgeTypeName('DeviceModel', 'DeviceModel')).toBe('设备型号');
    expect(knowledgeRelationName('hasSymptom', 'hasSymptom')).toBe('具有现象');
    expect(knowledgeAttributeName('snr_db')).toBe('信噪比（dB）');
    expect(knowledgeText('HW_FAILURE / EXCELLENT / voice / ALE')).toBe('硬件故障 / 优秀 / 话音 / 自动链路建立（ALE）');
    expect(knowledgeText('hasParameter: freq_min_khz=1600')).toBe('具有参数: 最低工作频率（kHz）=1600');
    expect(knowledgeTypeName('CustomType', '用户类别')).toBe('用户类别');
    expect(knowledgeText('vendor_specific')).toBe('vendor_specific');
    expect(knowledgeText('版本 1：Constructed device, network and fault knowledge; not field-validated')).toBe('版本 1：构造设备、网络和故障知识；未经外场验证');
    expect(knowledgeText('FREEZE')).toBe('冻结版本');
  });
  it('编号补充中文含义，不翻译型号、文件名、编号或单位片段', () => {
    expect(knowledgeEntityName(entity)).toBe('设备 DV-0001');
    expect(knowledgeEntityName({ type: 'Fault', name: 'FC-0001' })).toBe('故障实例 FC-0001');
    expect(knowledgeEntityName({ type: 'DeviceModel', name: 'HF SDR-2000' })).toBe('HF SDR-2000');
    expect(knowledgeEntityName({ type: 'Manufacturer', name: 'Hytera' })).toBe('海能达');
    expect(knowledgeEntityName({ type: 'Parameter', name: 'device_class=HF' })).toBe('设备频段：短波');
    expect(knowledgeText('HF-001 model_HF filename/HF.csv DM-0001 dBm')).toBe('HF-001 model_HF filename/HF.csv DM-0001 dBm');
    expect(knowledgeAttributeValue('HF SDR-2000', 'model_name')).toBe('HF SDR-2000');
    expect(knowledgeAttributeValue('AM-0001', 'antenna_id')).toBe('AM-0001');
    expect(knowledgeAttributeValue('CONSTRUCTED', 'source_doc')).toBe('构造数据');
    expect(knowledgeAttributeValue('PRC-150_用户操作手册.pdf', 'source_doc')).toBe('PRC-150_用户操作手册.pdf');
    expect(knowledgeSource('HF SDR manual.docx [CONSTRUCTED]')).toBe('HF SDR manual.docx [构造数据]');
    expect(knowledgeSource('link_status_v1.csv [CONSTRUCTED, DERIVED:LR-0001]')).toBe('链路状态资料 · link_status_v1.csv [构造数据, 派生资料:LR-0001]');
  });
  it('结构化值逐层显示中文，保留数值、原编号以及空值语义', () => {
    const raw = JSON.stringify({state:'GOOD', is_backup:true, tx_power_dbm:0, node_id:'ND-0001', model_name:'HF SDR-2000', threshold:null});
    expect(JSON.parse(knowledgeAttributeValue(raw))).toEqual({状态:'良好', 是否备用:'是', '发射功率（dBm）':0, 节点编号:'ND-0001', 设备型号名称:'HF SDR-2000', 判定门限:'未提供'});
    expect(knowledgeAttributeValue('C', 'polarization')).toBe('圆极化');
    expect(knowledgeAttributeValue('C')).toBe('C');
    expect(knowledgeAttributeValue('IV', 'echelon')).toBe('IV级');
    expect(knowledgeAttributeValue('')).toBe('');
    expect(knowledgeAttributeValue('{bad json}')).toBe('{bad json}');
  });
  it('快照比较包含工作原理和组网规则，显示转换不写回原实体', () => {
    const value = {...entity, principleFlow:{steps:[{title:'Device',description:'hasFunction voice'},{title:'Function',description:'data'}]}};
    const before = JSON.stringify(value), text = describeKnowledge(value);
    for (const term of ['设备 DV-0001','设备知识 / 设备','功放告警','工作原理流程','1. 设备：具有功能 话音','2. 功能：数据','状态规则说明：未提供']) expect(text).toContain(term);
    expect(JSON.stringify(value)).toBe(before);
  });
  it('图形标签使用中文，节点和边点击编号仍与原接口一致', () => {
    const graph:KnowledgeGraph = { versionId:'KGV5',entities:[entity,{...entity,id:'KGE-MODEL',type:'DeviceModel',name:'DM-0001'}],
      relations:[{id:'KGR-1',head:entity.id,tail:'KGE-MODEL',type:'instanceOf',source:'CONSTRUCTED',weight:1}],
      matchedIds:[],totalNodes:2,totalEdges:1 };
    const before=JSON.stringify(graph), model=knowledgeGraphModel(graph,'',Object.keys(knowledgeTypeLabels),{instanceOf:'instanceOf'});
    expect(model.nodes[0]).toMatchObject({id:entity.id,name:'设备 DV-0001',emphasis:{label:{formatter:'设备 DV-0001'}}});
    expect(model.links[0]).toMatchObject({id:'KGR-1',source:entity.id,target:'KGE-MODEL',value:'实例属于'});
    expect(JSON.stringify(graph)).toBe(before);
  });
});

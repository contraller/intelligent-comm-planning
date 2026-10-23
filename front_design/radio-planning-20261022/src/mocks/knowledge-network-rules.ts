import type { KnowledgeEntity, KnowledgeNetworkRule } from '../types/knowledge';

// 数据直接纳入版本快照；规则条件只供阅读，不在浏览器执行。
export const networkRuleSeed: KnowledgeEntity = {
  id: 'KGE-RULE', name: '链路状态判定说明', type: 'NetRule', category: '网络态势知识',
  description: '链路质量指标、状态等级与状态变化的关联说明。',
  keywords: ['链路质量','状态判定'], source: '网络状态知识库', attributes: [], modelIds: [],
};
export const knowledgeNetworkRule: KnowledgeNetworkRule = {
  // 符号定义随正文进入版本；等级定义及指标关联不代表实时判级结果。
  scope: 'M 表示链路余量，单位为 dB。信噪比反映信号质量，误码率与丢包率反映传输差错，时延与吞吐率反映业务承载。下列内容定义状态等级及指标关联，不表示某条链路同时处于四种状态；实时状态以评估结果为准。',
  source: '数据字典附：链路质量四级判据；接口文档 §4 链路评估。资料中的余量门限与信噪比、丢包率口径尚待统一。',
  criteria: [
    { state: 'EXCELLENT', condition: 'M ≥ 20 dB（资料参考门限）', meaning: '余量充裕；结合低差错、低丢包及业务时延和吞吐率要求查看承载质量。' },
    { state: 'GOOD', condition: '10 ≤ M < 20 dB（资料参考门限）', meaning: '链路正常可用，关注信噪比及传输差错的持续变化。' },
    { state: 'WARNING', condition: '3 ≤ M < 10 dB（资料参考门限）', meaning: '余量偏薄；信噪比下降、误码或丢包上升、时延增长及吞吐下降是需关联查看的异常指标。' },
    { state: 'FAULT', condition: 'M < 3 dB（资料参考门限）', meaning: '链路不可用，结合中断、持续丢包及无有效吞吐定位影响。' },
  ],
  transitions: [
    { from: 'GOOD', to: 'WARNING', description: '对照相邻采样的信噪比、误码率、丢包率、时延和吞吐率，查看状态下降的依据及受影响业务。' },
    { from: 'FAULT', to: 'GOOD', description: '处置后核对链路恢复记录、指标稳定性及业务通联结果，再查看恢复结论。' },
  ],
};

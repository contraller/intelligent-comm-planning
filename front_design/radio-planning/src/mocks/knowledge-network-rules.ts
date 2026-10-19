import type { KnowledgeEntity, KnowledgeNetworkRule } from '../types/knowledge';

// 原种子内容指纹保持独立；读取补充不改写已存知识版本。
export const networkRuleSeed: KnowledgeEntity = {
  id: 'KGE-RULE', name: '链路状态判定说明', type: 'NetRule', category: '网络态势知识',
  description: '由服务输出状态；本页只展示规则说明，不计算或执行表达式。',
  keywords: [], source: '独立教学预设 · 非厂家操作手册', attributes: [], modelIds: [],
};
export const networkRuleTeaching: KnowledgeNetworkRule = {
  scope: '资料阅读示例：以下为数据字典的链路余量 M 四级说明。接口评估示例另用信噪比 12 dB、丢包率 5% 解释状态，两套口径待甲方统一，不能据此在前端判级。',
  source: '01_数据字典.md L629–649；03_接口文档.md L720–732；变化说明为独立教学示例',
  criteria: [
    { state: 'EXCELLENT', condition: 'M ≥ 20 dB（原资料自拟参考门限）', meaning: '余量充裕，可抗深衰落。' },
    { state: 'GOOD', condition: '10 ≤ M < 20 dB（原资料自拟参考门限）', meaning: '正常可用。' },
    { state: 'WARNING', condition: '3 ≤ M < 10 dB（原资料自拟参考门限）', meaning: '余量偏薄，衰落时易中断。' },
    { state: 'FAULT', condition: 'M < 3 dB（原资料自拟参考门限）', meaning: '不可用。' },
  ],
  transitions: [
    { from: 'GOOD', to: 'WARNING', description: '独立教学说明：相邻采样由可用变为预警时，应查看服务给出的指标变化和解释；本条不是自动推断条件。' },
    { from: 'FAULT', to: 'GOOD', description: '独立教学说明：后续采样被服务标注恢复可用，不代表前端执行了修复或能够预测恢复。' },
  ],
};

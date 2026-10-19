import detailSource from './link-details.json';
import { monitoringPresets } from './monitoring-presets';
import type { LinkDetailCatalog } from '../types/link-detail';
import type { LinkStateAssessment } from '../types/link-assessment';

type Conclusion = Omit<LinkStateAssessment, 'owner' | 'source' | 'version'>;
// 下列结论为独立教学常量，不从观测值或四级门限计算。
const excellent: Conclusion = { state: 'EXCELLENT', confidence: .96, matchedRuleIds: ['DEMO-LR-STABLE'], dominantMetric: null,
  explanation: '固定教学记录：本次观测标注优秀，运行稳定。', rules: [{ ruleId: 'DEMO-LR-STABLE', title: '稳定状态教学说明', conditionText: '此固定采样对应预先给定的稳定状态；不是通用判级表达式。', source: '独立教学说明', version: 'assessment-demo-v1' }] };
const good: Conclusion = { state: 'GOOD', confidence: .9, matchedRuleIds: [], dominantMetric: null, explanation: '固定教学记录：本次观测标注正常可用，未返回命中规则。' };
const warning: Conclusion = { state: 'WARNING', confidence: .88, matchedRuleIds: ['DEMO-LR-WARNING'], dominantMetric: 'snrDb',
  explanation: '固定教学记录：信噪比偏低并伴随丢包，服务标注预警。', rules: [{ ruleId: 'DEMO-LR-WARNING', title: '预警记录说明', conditionText: '服务已给定此采样的预警标签；前端不按信噪比或丢包率另行判断。', source: '独立教学说明；字段参考接口文档 L728–732', version: 'assessment-demo-v1' }] };
const fault: Conclusion = { state: 'FAULT', confidence: 1, matchedRuleIds: ['DEMO-LR-INTERRUPTED'], dominantMetric: 'packetLossRate',
  explanation: '固定教学记录：链路中断，部分指标未采集，吞吐率为零。规则内容未提供。' };
const ordinary = [excellent, warning, good, good, fault, good, good];
const phases = [[excellent, good, good], [excellent, warning, good], [excellent, fault, good], [excellent, excellent, good]];
// 固定资产完整采样作为匹配依据；读取服务只在精确匹配时附加常量解释。
export const ordinaryAssessmentPreset = { catalog: structuredClone(detailSource) as LinkDetailCatalog, conclusions: ordinary };
export const monitoringAssessmentPresets = monitoringPresets.map(preset => ({
  id: preset.id, network: structuredClone(preset.network), frames: structuredClone(preset.frames), conclusions: phases,
}));

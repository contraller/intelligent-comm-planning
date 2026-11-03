import type { DiagnosisRecord, DiagnosisSuggestion } from '../types/diagnosis';
import { diagnosisOriginLabel } from '../services/diagnosis-presentation';

export const reportValue = (value: unknown): string => value === null || value === undefined || value === '' ? '未提供' : String(value);
// 稳定排序副本：同优先级沿用服务顺序，冻结记录与 JSON 不被修改。
export const orderedDiagnosisSuggestions = (suggestions: readonly DiagnosisSuggestion[]) => [...suggestions].sort((a,b) => a.priority - b.priority);
// 主干身份与案例耗时直接展示服务字段，缺省不推算。
export const backboneText = (value: boolean | null | undefined) => value === true ? '主干' : value === false ? '非主干' : '未提供';
export const caseRepairTimeText = (value: number | null | undefined) => value == null ? '未提供' : `${value} 分钟`;
export const confidenceText = (value: number | null) => value === null ? '未提供' : `${(value * 100).toFixed(1)}%`;
export const diagnosisLabels: Record<string, string> = { CURRENT: '当前有效', HISTORICAL: '历史记录', UNKNOWN: '有效性无法核实', NODE: '节点', DEVICE: '设备', LINK: '链路', HW_FAILURE: '硬件故障', LINK_DOWN: '链路中断', SW_CONFIG: '软件配置异常', EMI: '电磁干扰', SEVERE: '严重', MODERATE: '一般', MINOR: '轻微', DIRECT: '直接', INDIRECT: '间接', INTERRUPTED: '业务中断', DEGRADED: '降级运行', NORMAL: '正常', RULE: '规则', KG: '知识图谱', ML: '机器学习' };
export const diagnosisLabel = (value: string | null) => value === null ? '未提供' : diagnosisLabels[value] ?? value;
// 故障未识别与网络来源未知是两种状态，不能共用 UNKNOWN 的来源文案。
export const diagnosisFaultLabel = (value: string | null) => value === 'UNKNOWN' ? '未识别故障类型' : diagnosisLabel(value);

const evidenceLabels: Record<string, string> = {
  rule_ids: '规则编号', match_kind: '匹配方式', source_case_ids: '来源案例编号',
  source: '数据来源', case_id: '选用案例', triple_ids: '三元组编号',
  equally_supported_cases: '同等支持案例', candidate_rankings: '候选案例',
  source_docs: '来源文档', source_doc: '来源文档',
  fault_type: '故障类型', score: '匹配得分', matched_symptom_count: '匹配现象数',
};
const evidenceListFields = new Set(['rule_ids', 'source_case_ids', 'triple_ids', 'equally_supported_cases', 'source_docs']);
const evidenceMatchLabels: Record<string, string> = { EXACT: '精确匹配', PARTIAL_MISSING_INPUT: '输入缺失下的部分匹配' };

function evidenceValues(key: string, value: unknown): string[] | null {
  if (value === null || value === undefined || value === '') return ['未提供'];
  if (key === 'candidate_rankings') {
    if (!Array.isArray(value)) return null;
    const rows: string[] = [];
    const fields = ['case_id', 'fault_type', 'score', 'matched_symptom_count', 'triple_ids', 'source_docs'];
    for (const candidate of value) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
      // 新增或损坏的字段保留整条原文，不静默裁掉无法解释的证据。
      if (Object.keys(candidate).some(field => !fields.includes(field))) return null;
      const parts: string[] = [];
      for (const field of fields) {
        const values = evidenceValues(field, candidate[field]);
        if (!values) return null;
        parts.push(`${field === 'case_id' ? '案例编号' : evidenceLabels[field]}：${values.join('、')}`);
      }
      rows.push(parts.join('；'));
    }
    return rows.length ? rows : ['未提供'];
  }
  if (evidenceListFields.has(key)) {
    if (Array.isArray(value)) return value.every(item => typeof item === 'string') ? (value.length ? value.map(item => item || '未提供') : ['未提供']) : null;
    // 兼容历史记录已有的单值文字，不从当前规则或图谱补写冻结依据。
    return typeof value === 'string' ? [value] : null;
  }
  if (key === 'score') return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? [confidenceText(value)] : null;
  if (key === 'matched_symptom_count') return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? [String(value)] : null;
  if (typeof value !== 'string') return null;
  if (key === 'match_kind') return [Object.hasOwn(evidenceMatchLabels, value) ? evidenceMatchLabels[value]! : value];
  if (key === 'fault_type') return [Object.hasOwn(diagnosisLabels, value) ? diagnosisFaultLabel(value) : value];
  if (key === 'source' && value === 'CONSTRUCTED') return ['构造数据（未经现场实测验证）'];
  return [value];
}

// 页面和报告共用显示副本；只转换已知字段，不修改原始记录及 JSON 导出。
export function diagnosisEvidenceDisplay(evidence: readonly { label: string; value: string }[]): { label: string; values: string[] }[] {
  return evidence.map(item => {
    if (!Object.hasOwn(evidenceLabels, item.label)) return { label: item.label, values: [reportValue(item.value)] };
    let value: unknown = item.value;
    try { value = JSON.parse(item.value); } catch { /* 兼容历史纯文本及无法解析的原始依据。 */ }
    return { label: evidenceLabels[item.label]!, values: evidenceValues(item.label, value) ?? [reportValue(item.value)] };
  });
}

export interface DiagnosisReportSection { title: string; text: string[]; headers: string[]; rows: string[][] }
export function diagnosisReportSections(record: DiagnosisRecord): DiagnosisReportSection[] {
  const table = (title: string, headers: string[], rows: unknown[][], text: string[] = []): DiagnosisReportSection => ({ title, headers, rows: rows.map((r) => r.map(reportValue)), text });
  const sections = [table('记录与网络版本', ['项目','内容'], [
    ['报告 ID',record.id],['场景 / 版本',`${record.scenarioId} / ${record.scenarioVersion}`],['规划任务 / 版本',`${record.network.taskId} / ${record.network.id}`],['网络快照',record.network.snapshotId],
    ['诊断任务',record.diagnoseTaskId],['影响任务',record.impactTaskId],['开始时间',record.startedAt],['完成时间',record.completedAt],['来源状态',diagnosisLabel(record.source.state)],['状态原因',record.source.reasons.join('；') || '所选版本当前有效'],
    ['抗干扰来源',record.network.workflow?.interferenceOrigin ? JSON.stringify(record.network.workflow.interferenceOrigin) : '无'],
    ['规划部署坐标',record.network.workflow?.configuration.deployment.filter(row => row.plannedCoordinate).map(row => row.stationId + '：' + row.plannedCoordinate!.join(', ')).join('；') || '沿用输入坐标'],
    ['备注',record.description],['数据来源',diagnosisOriginLabel(record.dataOrigin)],
  ]), table('故障输入', ['对象','故障类型','现象','发生时间','干扰源'], record.faults.map((f) => [`${diagnosisLabel(f.objectType)} ${f.objectId}`,diagnosisLabel(f.faultType),f.symptomIds.join('；'),f.occurTime,f.interferenceId]), record.faults.length ? [] : ['原历史记录未提供完整故障输入。'])];
  for (const c of record.result.conclusions) {
    sections.push(table(`诊断结论 · ${c.label}`, ['项目','内容'], [['融合类型',diagnosisFaultLabel(c.faultType)],['置信度',confidenceText(c.confidence)],['人工研判',c.needManualReview === null ? null : c.needManualReview ? '需要' : '无需'],['根因',c.rootCause],['部件',c.component],['根因链',c.chain.join(' → ')]], [record.result.disabledReason]));
    sections.push(table(`分路依据 · ${c.label}`, ['分路','结论 / 依据','置信度','权重 / 贡献'], c.branches.map((b) => [diagnosisLabel(b.source),[b.conclusion,b.disabledReason,...diagnosisEvidenceDisplay(b.evidence).map((e) => `${e.label}：${e.values.join('；\n')}`)].filter(Boolean).join('\n'),confidenceText(b.confidence),`${reportValue(b.weight)} / ${reportValue(b.contribution)}`])));
    if (c.candidates.length) sections.push(table('候选结论', ['类型','置信度'], [...c.candidates].sort((a,b) => b.confidence - a.confidence).map((c) => [diagnosisLabel(c.faultType),confidenceText(c.confidence)])));
  }
  const s = record.result.summary;
  // 传播是独立的预生成因果顺序，备份路径仍在节点表中独立展示。
  const paths=record.result.propagationPaths;
  sections.push(table('故障传播路径 · 全场景', ['路径','来源故障 / 等级','原因','有序对象步骤'], (paths ?? []).map(path => [path.id,`${path.faultKey} / ${diagnosisLabel(path.level)}`,path.reason,path.steps.map((step,i) => `${i+1}. ${diagnosisLabel(step.objectType)} ${step.objectId}：${step.reason}`).join('\n')]), paths === undefined ? ['该历史结果未提供传播路径，不从备份路由推断。'] : paths.length ? [] : ['服务返回无传播路径。']));
  sections.push(table('影响统计', ['指标','分析结果'], s ? [['受影响节点',s.affectedNodeCount],['直接 / 间接',`${s.directCount} / ${s.indirectCount}`],['中断 / 降级节点',`${s.interruptedNodeCount} / ${s.degradedNodeCount}`],['受影响链路',s.affectedLinkCount],['带宽损失 kbps',s.totalBandwidthLossKbps],['受影响必要需求',s.affectedDemandIds.join('；')]] : [], s ? [] : ['原历史记录未提供结构化统计，不按清单自行补算。']));
  sections.push(table('受影响节点', ['节点','关联 / 等级','状态','原因 / 备份路径'], record.result.nodes.map((n) => [n.nodeId,`${diagnosisLabel(n.affectType)} / ${diagnosisLabel(n.level)}`,diagnosisLabel(n.state),[n.reason,n.detourRoute.join(' → ')].filter(Boolean).join('\n')])));
  sections.push(table('受影响链路', ['链路','等级 / 状态','损失 kbps','关联故障 / 原因','主干属性'], record.result.links.map((l) => [l.linkId,`${diagnosisLabel(l.level)} / ${diagnosisLabel(l.state)}`,l.bandwidthLossKbps,`${reportValue(l.faultKey)}\n${l.reason}`,backboneText(l.isBackbone)])));
  for (const suggestion of orderedDiagnosisSuggestions(record.result.suggestions)) sections.push(table(`修复建议 ${suggestion.priority}`, ['项目','内容'], [['建议',suggestion.action],['适用情况',suggestion.applicability],['步骤',suggestion.steps.map((s,i) => `${i + 1}. ${s}`).join('\n')],['备件',suggestion.spares.join('；')],['工具',suggestion.tools.join('；')],['预计分钟',suggestion.estimatedTimeMin],['图谱依据',suggestion.tripleIds.join('；')],['相似案例',suggestion.similarCases.map((c) => `${c.id}（${confidenceText(c.similarity)}）：${c.solution}\n案例修复耗时：${caseRepairTimeText(c.repairTimeMin)}`).join('\n')]]));
  sections.push({ title: '来源及说明', headers: [], rows: [], text: record.result.notes });
  return sections;
}

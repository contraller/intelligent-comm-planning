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
    sections.push(table(`分路依据 · ${c.label}`, ['分路','结论 / 依据','置信度','权重 / 贡献'], c.branches.map((b) => [diagnosisLabel(b.source),[b.conclusion,b.disabledReason,...b.evidence.map((e) => `${e.label}：${e.value}`)].filter(Boolean).join('\n'),confidenceText(b.confidence),`${reportValue(b.weight)} / ${reportValue(b.contribution)}`])));
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

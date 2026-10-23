import type { PlanVersion } from '../types/domain';
import type { ResourceFile } from '../types/resource-edit';
import { ApiError } from './types';
import type { ApiPlan } from '../types/planning-api';
import type { PlanningResultDetails } from '../types/planning-result-details';
import type { PlanningAdjustment } from '../types/planning-adjustment';
import type { DeploymentConstraints } from '../types/deployment-constraints';
import { deploymentFields, deploymentLabels, deploymentValue } from './deployment-constraints';
import type { PlanningInput } from '../types/planning';
import { optimizationConclusion } from './planning-optimization';
import { backupRequestLabel, routeStrategyLabel } from './planning-routing';

// 频率筛选与求解输入只展开所选方案的冻结值。
function optionsTables(table:(name:string,rows:Record<string,unknown>[],empty?:string)=>void,input?:PlanningInput){
  table('频率筛选输入',input?.frequencyConstraints?.filters.map(row=>({...row}))??[],'未设置');
  table('部署求解输入',input?.deploymentSolve?[{...input.deploymentSolve}]:[],'未设置');
  // 可读摘要也只用所选版本，未指定和明确 false 分别展示。
  table('逐需求路由条件',input?.demands.map(row=>({需求编号:row.id,路由策略:routeStrategyLabel(row.routeStrategy),备份请求:backupRequestLabel(row.needBackup)}))??[],'未提供');
}

// 条件和几何原样读取选定版本，不重新计算距离、通视或禁区关系。
function deploymentTables(table: (name: string, rows: Record<string, unknown>[], empty?: string) => void, value?: DeploymentConstraints | null) {
  table('部署筛选条件', value ? deploymentFields.slice(0,7).map(key => ({ 条件: deploymentLabels[key], 值: deploymentValue(value[key]) })) : [], '未设置');
  table('强制部署点', value?.forcedInclude.map((point,index) => ({ 序号:index+1, 经度:point.lon, 纬度:point.lat, 坐标系:'WGS84' })) ?? [], value ? '无' : '未设置');
  table('禁部署区', value?.forcedExcludePolygons.map((polygon,index) => ({ 序号:index+1, 类型:polygon.type, 坐标环:polygon.coordinates, 坐标系:'WGS84 / [lon,lat]' })) ?? [], value ? '无' : '未设置');
}

// 两类来源共用工作簿编码；数据映射仍分别读取各自冻结契约。
async function createExportBook() {
  const Excel = (await import('exceljs')).default, book = new Excel.Workbook();
  const table = (name: string, rows: Record<string, unknown>[], empty = '未提供') => {
    const sheet = book.addWorksheet(name), keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
    if (!keys.length) { sheet.addRow([empty]); return; }
    sheet.addRow(keys);
    for (const row of rows) sheet.addRow(keys.map(k => row[k] == null ? '未提供' : typeof row[k] === 'object' ? JSON.stringify(row[k]) : row[k]));
    sheet.columns.forEach(c => c.width = 26); sheet.getRow(1).font = { bold: true }; sheet.views = [{ state: 'frozen', ySplit: 1 }];
  };
  return { book, table };
}

// 各表只展开同一冻结容器；空集合与未提供分开，0 和 false 原样保留。
function resultDetailsTables(table: (name: string, rows: Record<string, unknown>[], empty?: string) => void, details?: PlanningResultDetails) {
  const rows = (name: string, values: Record<string, unknown>[] | null | undefined) => table(name, values ?? [], values == null ? '未提供' : '没有记录');
  table('结果明细版本', details ? [{ schemaVersion: details.schemaVersion, assetVersion: details.assetVersion }] : []);
  rows('设备参数补充', details?.deviceParameters?.map(x => ({ ...x })));
  rows('路由质量', details?.routeQuality?.map(x => ({ ...x })));
  rows('频率分配', details?.frequencyAssignments?.map(x => ({ ...x })));
  rows('频率冲突', details?.frequencyConflicts?.map(x => ({ ...x })));
  table('频率缺口与结论', details ? [{ requiredChannels: details.frequencyGap?.requiredChannels ?? null, availableChannels: details.frequencyGap?.availableChannels ?? null, shortage: details.frequencyGap?.shortage ?? null, conflictFree: details.conflictFree }] : []);
  rows('不可达需求', details?.unreachableDemandIds?.map(demandId => ({ demandId })));
  // 三张表来自所选冻结版本，不按明细长度重算服务统计。
  const candidates = details?.candidateScreening;
  table('候选统计', candidates ? [{ 来源: candidates.sourceLabel, 服务候选统计: candidates.candidateCount, 服务可部署统计: candidates.deployableCount,
    已返回明细条数: candidates.candidates === null ? null : candidates.candidates.length }] : []);
  rows('候选明细', candidates?.candidates?.map(row => ({ ...row })));
  rows('筛除统计', candidates?.rejectedStats == null ? null : Object.entries(candidates.rejectedStats).map(([项目, 数量]) => ({ 项目, 数量 })));
  const optimization=details?.optimization;
  table('优化分析来源',optimization?[{来源:optimization.sourceLabel}]:[]);
  rows('优化权衡',optimization?.tradeoff?.map(row=>({...row,服务结论:optimizationConclusion(row.meetsConstraints)})));
  rows('关键链路影响',optimization?.criticalBridges?.map(row=>({...row})));
}

// 来源与人工输入均取自保存版本；历史方案缺省时明确说明，绝不套用当前草稿。
function adjustmentTables(table: (name: string, rows: Record<string, unknown>[], empty?: string) => void, adjustment?: PlanningAdjustment) {
  table('方案调整来源', adjustment ? [{ schemaVersion: adjustment.schemaVersion, sourcePlanId: adjustment.sourcePlanId, sourceSnapshotId: adjustment.sourceSnapshotId }] : [], '此历史版本未保存人工调整信息');
  table('人工设备输入', adjustment?.manualOverrides.map(d => ({ deviceId: d.deviceId, txPowerDbm: d.txPowerDbm ?? '沿用父方案', antennaHeightM: d.antennaHeightM ?? '沿用父方案' })) ?? [], adjustment ? '没有人工设备覆盖' : '未提供');
  table('人工主路由', adjustment?.manualPaths.map(r => ({ demandId: r.demandId, nodePath: r.nodePath })) ?? [], adjustment ? '没有人工主路由覆盖' : '未提供');
}

// 导出只读取所选方案快照，历史缺项不从当前资源或草稿补齐。
export async function exportPlanFile(plan:PlanVersion,format:'json'|'xlsx'):Promise<ResourceFile>{
  if(!['json','xlsx'].includes(format))throw new ApiError('方案导出格式无效','EXPORT_FORMAT');
  const snapshot=structuredClone(plan),exportedAt=new Date().toISOString();
  const name='方案-'+plan.id.replace(/[^\w\u4e00-\u9fff-]/g,'_')+'-'+exportedAt.replace(/[:.]/g,'-');
  const record={schemaVersion:1,source:'Mock 教学预生成结果',exportedAt,plan:snapshot};
  if(format==='json')return {name:name+'.json',mime:'application/json;charset=utf-8',bytes:new TextEncoder().encode(JSON.stringify(record,null,2))};
  const {book,table}=await createExportBook();
  const flow=snapshot.workflow;
  deploymentTables(table, flow?.input.deploymentConstraints);
  optionsTables(table,flow?.input);
  table('完整结果来源',flow?.solutionOrigin?[{作业ID:snapshot.jobId,快照ID:snapshot.snapshotId,...flow.solutionOrigin}]:[],'旧单结果，未提供多结果身份');
  table('方案说明',[{方案ID:snapshot.id,名称:snapshot.name,任务ID:snapshot.taskId,版本:snapshot.version,状态:snapshot.state,来源已变化:snapshot.sourceChanged,数据来源:record.source,导出时间:exportedAt}]);
  table('任务输入',flow?[{...flow.input,stationIds:flow.input.stationIds,demands:undefined}]:[]);
  table('通联需求',flow?.input.demands.map(d=>({...d}))??[]);
  table('节点快照',snapshot.inputSnapshot.stations.map(s=>({...s})));
  table('设备快照',snapshot.inputSnapshot.devices.map(d=>({...d})));
  // 来源与输出部署坐标独立列出，不把资源输入位置改成规划位置。
  if (flow?.interferenceOrigin) table('抗干扰来源',[{...flow.interferenceOrigin}]);
  adjustmentTables(table, flow?.adjustment);
  table('部署',flow?.configuration.deployment.map(d=>({...d}))??[]);
  table('设备参数',flow?.configuration.devices.map(d=>({...d}))??[]);
  table('路由',flow?.configuration.routes.map(d=>({...d}))??[]);
  table('频率',flow?.configuration.frequencies.map(d=>({...d}))??[]);
  table('链路',snapshot.links.map(d=>({...d})));table('区域',snapshot.regions.map(d=>({...d})));
  table('指标',[{...snapshot.metrics,部署成本:flow?.deploymentCost,成本单位:flow?.costUnit}]);
  table('校验',flow?.checks.map(d=>({...d}))??[]);
  table('建议',snapshot.notes.concat(flow?.outcome.suggestions??[]).map(说明=>({说明})));
  resultDetailsTables(table, snapshot.resultDetails);
  // 完整 JSON 分片存入工作表，避免单元格长度限制丢失快照元数据。
  const json=JSON.stringify(record),pieces:Record<string,unknown>[]=[];
  for(let i=0;i<json.length;i+=16000)pieces.push({顺序:pieces.length+1,JSON片段:json.slice(i,i+16000)});
  table('完整快照',pieces);
  return {name:name+'.xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',bytes:new Uint8Array(await book.xlsx.writeBuffer())};
}

export async function exportApiPlanFile(plan: ApiPlan, format: 'json' | 'xlsx'): Promise<ResourceFile> {
  if (!['json', 'xlsx'].includes(format)) throw new ApiError('方案导出格式无效', 'EXPORT_FORMAT');
  const record = { schemaVersion: 'planning-http-draft-0.1', source: plan.source, exportedAt: new Date().toISOString(), plan: structuredClone(plan) };
  const name = '方案-' + plan.id.replace(/[^\w\u4e00-\u9fff-]/g, '_') + '-' + record.exportedAt.replace(/[:.]/g, '-');
  if (format === 'json') return { name: name + '.json', mime: 'application/json;charset=utf-8', bytes: new TextEncoder().encode(JSON.stringify(record, null, 2)) };
  const { book, table } = await createExportBook(), p = record.plan, r = p.result;
  deploymentTables(table, p.input.deploymentConstraints);
  optionsTables(table,p.input);
  table('完整结果来源',p.solutionId?[{作业ID:p.jobId,快照ID:r.snapshotId,solutionId:p.solutionId,label:p.solutionLabel,radioCount:p.radioCount}]:[],'旧单结果，未提供多结果身份');
  table('方案说明', [{ 方案ID: p.id, 任务ID: p.taskId, 作业ID: p.jobId, 名称: p.name, 版本: p.version, 状态: p.state, 当前确认版本: p.current, 来源已变化: p.sourceChanged, 数据来源: p.source, 保存时间: p.savedAt, 导出时间: record.exportedAt }]);
  adjustmentTables(table, p.adjustment);
  table('任务输入', [{ ...p.input, demands: undefined }]); table('通联需求', p.input.demands.map(x => ({ ...x })));
  table('节点快照', r.nodes.map(x => ({ ...x }))); table('设备快照', r.devices.map(x => ({ ...x })));
  table('部署', r.configuration.deployment.map(x => ({ ...x }))); table('设备参数', r.configuration.devices.map(x => ({ ...x })));
  table('路由', r.configuration.routes.map(x => ({ ...x }))); table('频率', r.configuration.frequencies.map(x => ({ ...x }))); table('链路', r.links.map(x => ({ ...x })));
  table('覆盖几何', r.coverage.contour?.features.map(x => ({ ...x })) ?? []); table('覆盖栅格元数据', r.coverage.rasterPng ? [{ ...r.coverage.rasterPng }] : []);
  table('指标', [{ ...r.metrics, 部署成本: r.deploymentCost, 成本单位: r.costUnit }]); table('校验', r.checks.map(x => ({ ...x })));
  table('建议', [...r.notes, ...p.outcome.suggestions].map(说明 => ({ 说明 })));
  resultDetailsTables(table, r.resultDetails);
  const json = JSON.stringify(record), pieces: Record<string, unknown>[] = [];
  for (let i = 0; i < json.length; i += 16000) pieces.push({ 顺序: pieces.length + 1, JSON片段: json.slice(i, i + 16000) });
  table('完整快照', pieces);
  return { name: name + '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: new Uint8Array(await book.xlsx.writeBuffer()) };
}

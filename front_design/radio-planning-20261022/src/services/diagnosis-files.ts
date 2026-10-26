import type { DiagnosisDraft, DiagnosisFile, DiagnosisImportPreview, DiagnosisIssue, DiagnosisPreset, DiagnosisRecord } from '../types/diagnosis';
import type { PlanVersion } from '../types/domain';
import { DIAGNOSIS_MAX_FILE_BYTES, DIAGNOSIS_MAX_IMPORT_SCENARIOS } from '../config/demo';
import { matchDiagnosisPreset, validateDiagnosisDraft } from './diagnosis-validation';
import { ApiError } from './types';
import { diagnosisOriginLabel } from './diagnosis-presentation';

export const diagnosisHeaders = ['scenario_key','scenario_name','description','object_type','object_id','fault_type','symptom_ids','occur_time','interference_id'];
const text = (v: unknown) => v == null ? '' : String(v).trim();
const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
async function workbook() { const Excel = (await import('exceljs')).default; return new Excel.Workbook(); }
async function xlsxFile(name: string, sheets: { name: string; rows: (string | number | null)[][] }[]): Promise<DiagnosisFile> {
  const book = await workbook();
  for (const table of sheets) {
    const sheet = book.addWorksheet(table.name);
    sheet.addRows(table.rows);
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach((column) => { column.width = 25; });
  }
  return { name, mime: xlsxMime, bytes: new Uint8Array(await book.xlsx.writeBuffer()) };
}
export async function diagnosisTemplate(format: 'csv' | 'xlsx', presets: DiagnosisPreset[]): Promise<DiagnosisFile> {
  const template = presets[0];
  if (!template) throw new ApiError('此网络暂无预生成诊断模板', 'NO_PRESET');
  const rows = [diagnosisHeaders, ...template.faults.map((f) => ['scene-1', template.label, '场景模板', f.objectType, f.objectId, f.faultType, f.symptomIds.join(';'), '', f.interferenceId ?? ''])];
  if (format === 'xlsx') return xlsxFile('故障场景模板.xlsx', [{ name: 'faults', rows }]);
  const Papa = (await import('papaparse')).default;
  return { name: '故障场景模板.csv', mime: 'text/csv;charset=utf-8', bytes: new TextEncoder().encode(Papa.unparse(rows)) };
}
export async function parseDiagnosisImport(file: { name: string; bytes: Uint8Array }, plan: PlanVersion, presets: DiagnosisPreset[]): Promise<DiagnosisImportPreview> {
  if (file.bytes.byteLength > DIAGNOSIS_MAX_FILE_BYTES) throw new ApiError('单文件最多 5 MiB', 'IMPORT_LIMIT');
  const issues: DiagnosisIssue[] = [];
  let headers: string[] = [];
  let rows: string[][] = [];
  if (/\.csv$/i.test(file.name)) {
    const Papa = (await import('papaparse')).default;
    let decoded: string;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); }
    catch { throw new ApiError('CSV 需为 UTF-8 编码', 'IMPORT_ENCODING'); }
    const parsed = Papa.parse<string[]>(decoded, { skipEmptyLines: 'greedy' });
    headers = (parsed.data.shift() ?? []).map(text);
    rows = parsed.data;
    for (const e of parsed.errors) issues.push({ row: (e.row ?? 0) + 1, field: 'CSV', message: e.message });
  } else if (/\.xlsx$/i.test(file.name)) {
    const book = await workbook();
    try { await book.xlsx.load(new Uint8Array(file.bytes).buffer); }
    catch { throw new ApiError('XLSX 无法读取，请使用模板', 'IMPORT_FORMAT'); }
    const sheet = book.getWorksheet('faults');
    if (!sheet) throw new ApiError('XLSX 需包含 faults 工作表', 'IMPORT_SHEET');
    if (sheet.rowCount > 401 || sheet.columnCount > diagnosisHeaders.length) throw new ApiError('表格超出模板行列范围', 'IMPORT_LIMIT');
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const values: string[] = [];
      for (let column = 1; column <= Math.max(sheet.columnCount, diagnosisHeaders.length); column++) {
        const value = row.getCell(column).value;
        if (value !== null && typeof value === 'object') {
          issues.push({ row: rowNumber, field: diagnosisHeaders[column - 1] ?? String(column), message: '只接受文本或数值，不接受公式、日期对象或富文本' });
          values.push('');
        } else values.push(text(value));
      }
      if (rowNumber === 1) headers = values; else rows.push(values);
    });
  } else throw new ApiError('请选择 CSV 或 XLSX 文件', 'IMPORT_FORMAT');
  if (headers.length !== diagnosisHeaders.length || new Set(headers).size !== headers.length || diagnosisHeaders.some((h) => !headers.includes(h)))
    issues.push({ row: 1, field: 'header', message: '表头需与下载模板完全对应，不接受未知列或重复列' });
  if (rows.length > 400) throw new ApiError('导入最多 400 条故障行', 'IMPORT_LIMIT');
  const groups = new Map<string, { draft: DiagnosisDraft; rowNumbers: number[] }>();
  rows.forEach((values, index) => {
    const row = index + 2;
    if (values.every((v) => !text(v))) return;
    if (values.length !== headers.length) issues.push({ row, field: 'row', message: '字段数量与表头不一致' });
    const data = Object.fromEntries(headers.map((h,i) => [h,text(values[i])]));
    if (!data.scenario_key) { issues.push({ row, field: 'scenario_key', message: '文件内场景分组标识不能为空' }); return; }
    let group = groups.get(data.scenario_key);
    if (!group) {
      group = { draft: { name: data.scenario_name, description: data.description, planId: plan.id, faults: [] }, rowNumbers: [] };
      groups.set(data.scenario_key, group);
    }
    if (group.draft.name !== data.scenario_name || group.draft.description !== data.description) issues.push({ row, field: 'scenario_name', message: '同组场景的名称及备注必须一致' });
    group.draft.faults.push({ objectType: data.object_type as 'NODE', objectId: data.object_id, faultType: data.fault_type as 'HW_FAILURE', symptomIds: data.symptom_ids?.split(';').map(text).filter(Boolean) ?? [], occurTime: data.occur_time || null, interferenceId: data.interference_id || null });
    group.rowNumbers.push(row);
  });
  if (!groups.size || groups.size > DIAGNOSIS_MAX_IMPORT_SCENARIOS) issues.push({ field: 'scenarios', message: '每次导入需为 1–20 个场景' });
  const drafts: DiagnosisDraft[] = [];
  const matches: boolean[] = [];
  for (const { draft, rowNumbers } of groups.values()) {
    drafts.push(draft);
    issues.push(...validateDiagnosisDraft(draft, plan).map((issue) => ({ ...issue, row: rowNumbers[(issue.row ?? 1) - 1], field: issue.field })));
    try { matchDiagnosisPreset(draft, plan, presets); matches.push(true); } catch { matches.push(false); }
  }
  return { fileName: file.name, drafts, issues, matches };
}
export async function diagnosisImpactWorkbook(record: DiagnosisRecord, filters: string) {
  // 导出全部影响数据，筛选条件仅作为说明，文本不会变成公式。
  return xlsxFile(`${record.name}-影响清单.xlsx`, [
    { name: '说明', rows: [['项目','内容'],['报告',record.id],['方案',record.network.id],['抗干扰来源',record.network.workflow?.interferenceOrigin?.variantId ?? '无'],['来源状态',record.source.reasons.join('；') || '当前有效快照'],['页面筛选',filters || '全部'],['导出范围','完整结果，不受筛选影响'],['数据来源',diagnosisOriginLabel(record.dataOrigin)]] },
    { name: '节点', rows: [['节点','关联类型','等级','状态','原因','备份路径'], ...record.result.nodes.map((n) => [n.nodeId,n.affectType,n.level,n.state,n.reason,n.detourRoute.join(' → ')])] },
    // 末列追加已有主干属性，保留旧列顺序及完整导出范围。
    { name: '链路', rows: [['链路','等级','状态','关联故障','带宽损失 kbps','原因','主干属性'], ...record.result.links.map((l) => [l.linkId,l.level,l.state,l.faultKey,l.bandwidthLossKbps,l.reason,l.isBackbone === true ? '主干' : l.isBackbone === false ? '非主干' : '未提供'])] },
    // 新工作表独立追加，不改变已有列位置；历史缺省与服务空集合分开说明。
    { name: '传播路径', rows: [['路径','来源故障','等级','原因','有序对象步骤'], ...(record.result.propagationPaths ?? []).map(path => [path.id,path.faultKey,path.level,path.reason,path.steps.map((step,i) => `${i+1}. ${step.objectType}:${step.objectId} ${step.reason}`).join('\n')]), ...(record.result.propagationPaths === undefined ? [['未提供传播路径','','','','']] : !record.result.propagationPaths.length ? [['服务返回无传播路径','','','','']] : [])] },
  ]);
}

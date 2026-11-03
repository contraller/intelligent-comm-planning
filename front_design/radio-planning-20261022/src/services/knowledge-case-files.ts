import type { KnowledgeCaseInput, KnowledgeCaseIssue } from '../types/knowledge-case';
import type { ResourceFile } from '../types/resource-edit';
import { KNOWLEDGE_MAX_OPERATIONS } from '../config/demo';

export const caseSheets = {
  知识条目: [
    '条目标识',
    '案例编号',
    '案例标题',
    '故障类型',
    '适用对象类型',
    '设备类别',
    '原因',
    '故障部件',
    '解决方案',
    '知识来源',
  ],
  故障现象: ['条目标识', '现象'],
  排故步骤: ['条目标识', '序号', '步骤内容'],
} as const;
export async function knowledgeCaseTemplate(): Promise<ResourceFile> {
  const { Workbook } = await import('exceljs');
  const workbook = new Workbook();
  const samples: Record<string, unknown[][]> = {
    知识条目: [
      [
        'CASE-1',
        'FC-NEW-001',
        '供电异常排查',
        '硬件故障',
        '设备',
        'HF',
        '供电连接松动',
        '',
        '恢复供电连接并复核运行状态',
        '请替换为真实规程或经核对的案例来源',
      ],
    ],
    故障现象: [['CASE-1', '供电告警']],
    排故步骤: [
      ['CASE-1', 1, '按设备规程检查供电和连接状态'],
      ['CASE-1', 2, '完成处理后复核告警与通联结果'],
    ],
  };
  for (const [name, headers] of Object.entries(caseSheets)) {
    const sheet = workbook.addWorksheet(name);
    sheet.addRow([...headers]);
    for (const row of samples[name]) sheet.addRow(row);
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF193B60' } };
    sheet.columns.forEach((column, index) => {
      column.width = index === headers.length - 1 ? 48 : 22;
    });
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }
  const help = workbook.addWorksheet('说明');
  [
    '三个业务工作表按条目标识关联；每条知识只表达一个原因和一个解决方案。',
    '故障类型：硬件故障、链路中断、软件配置异常、电磁干扰。适用对象：设备、节点、链路。',
    '部件和设备类别选填；设备类别为空、HF或VUHF。其它核心字段必填，案例标题选填。',
    '现象、原因、方案和部件名称最多80字；步骤内容最多77字，序号从1连续递增。来源最多200字。',
    '填写文本，不使用公式、超链接、富文本或隐藏业务表。单文件最多5MiB。',
    `预检后每单最多${KNOWLEDGE_MAX_OPERATIONS}项实体/关系操作。超限请拆分，错误批次不会部分导入。`,
    '示例用于说明填法，须替换为有来源的真实内容；来源栏不能只写文件名。',
    '生成的是未保存草稿，需另行保存、送审和发布。发布后重新加载故障诊断即可选择新增现象；诊断命中取决于已发布关系及适用对象、频段。',
  ].forEach((line) => help.addRow([line]));
  help.getColumn(1).width = 115;
  return {
    name: '故障知识结构化导入模板.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: new Uint8Array(await workbook.xlsx.writeBuffer()),
  };
}
export async function parseKnowledgeCaseFile(file: {
  name: string;
  bytes: Uint8Array;
}): Promise<{ cases: KnowledgeCaseInput[]; issues: KnowledgeCaseIssue[] }> {
  const issues: KnowledgeCaseIssue[] = [];
  if (!/\.xlsx$/i.test(file.name) || file.bytes.length > 5 * 1024 * 1024)
    throw new Error('请选择不超过 5 MiB 的 .xlsx 文件');
  const { Workbook } = await import('exceljs');
  const workbook = new Workbook();
  await workbook.xlsx.load(file.bytes as never);
  const records: Record<string, Record<string, string>[]> = Object.create(null);
  for (const sheet of workbook.worksheets)
    if (!Object.hasOwn(caseSheets, sheet.name) && sheet.name !== '说明')
      issues.push({
        sheet: sheet.name,
        row: 0,
        field: '工作表',
        message: '未知工作表，请使用下载的模板',
      });
  for (const [name, headers] of Object.entries(caseSheets)) {
    const sheet = workbook.getWorksheet(name);
    records[name] = [];
    if (!sheet) {
      issues.push({ sheet: name, row: 0, field: '工作表', message: '缺少必需工作表' });
      continue;
    }
    if (sheet.state !== 'visible' || sheet.rowCount > 1000 || sheet.columnCount > 20) {
      issues.push({
        sheet: name,
        row: 0,
        field: '工作表',
        message: '业务表须可见，且最多1000行、20列',
      });
      continue;
    }
    if (
      headers.some((h, i) => sheet.getRow(1).getCell(i + 1).value !== h) ||
      sheet.getRow(1).cellCount > headers.length
    ) {
      issues.push({
        sheet: name,
        row: 1,
        field: '表头',
        message: '表头与模板不一致，请勿增删或改名',
      });
      continue;
    }
    for (let line = 2; line <= sheet.rowCount; line++) {
      const row = sheet.getRow(line);
      if (!row.actualCellCount) continue;
      const data: Record<string, string> = { _row: String(line) };
      headers.forEach((header, index) => {
        const value = row.getCell(index + 1).value;
        if (value == null) data[header] = '';
        else if (typeof value === 'string') data[header] = value.trim();
        else if (
          name === '排故步骤' &&
          header === '序号' &&
          typeof value === 'number' &&
          Number.isInteger(value)
        )
          data[header] = String(value);
        else {
          issues.push({
            sheet: name,
            row: line,
            field: header,
            message: '只接受文本；序号可填整数，不接受公式、日期或富文本',
          });
          data[header] = '';
        }
      });
      if (
        row.cellCount > headers.length &&
        row.values &&
        Array.isArray(row.values) &&
        row.values.slice(headers.length + 1).some((v) => v != null)
      )
        issues.push({ sheet: name, row: line, field: '列', message: '存在模板外的数据列' });
      if (headers.some((h) => data[h])) records[name].push(data);
    }
  }
  const faultCodes: Record<string, string> = {
      硬件故障: 'HW_FAILURE',
      链路中断: 'LINK_DOWN',
      软件配置异常: 'SW_CONFIG',
      电磁干扰: 'EMI',
    },
    objectCodes: Record<string, string> = { 设备: 'DEVICE', 节点: 'NODE', 链路: 'LINK' };
  const main = records['知识条目'],
    keys = new Set<string>();
  for (const row of main) {
    const key = row['条目标识'];
    if (!key || keys.has(key))
      issues.push({
        sheet: '知识条目',
        row: Number(row._row),
        field: '条目标识',
        message: '条目标识不能为空且不能重复',
      });
    keys.add(key);
  }
  for (const name of ['故障现象', '排故步骤'])
    for (const row of records[name])
      if (!keys.has(row['条目标识']))
        issues.push({
          sheet: name,
          row: Number(row._row),
          field: '条目标识',
          message: '找不到对应的知识条目',
        });
  const cases = main.map((row) => ({
    caseId: row['案例编号'],
    title: row['案例标题'],
    faultType: faultCodes[row['故障类型']] ?? row['故障类型'],
    objectType: objectCodes[row['适用对象类型']] ?? row['适用对象类型'],
    deviceClass: row['设备类别'] as KnowledgeCaseInput['deviceClass'],
    cause: row['原因'],
    component: row['故障部件'],
    solution: row['解决方案'],
    source: row['知识来源'],
    row: Number(row._row),
    symptoms: records['故障现象']
      .filter((r) => r['条目标识'] === row['条目标识'])
      .map((r) => r['现象']),
    symptomRows: records['故障现象']
      .filter((r) => r['条目标识'] === row['条目标识'])
      .map((r) => Number(r._row)),
    steps: records['排故步骤']
      .filter((r) => r['条目标识'] === row['条目标识'])
      .map((r) => ({ order: Number(r['序号']), text: r['步骤内容'], row: Number(r._row) })),
  }));
  return { cases, issues };
}

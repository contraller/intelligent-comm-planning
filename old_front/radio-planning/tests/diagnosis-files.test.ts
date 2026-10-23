import { interferenceFixture } from './helpers/interference';
import { networkDiagnosisPresets, allDiagnosisPresets } from '../src/services/diagnosis-catalog';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { diagnosisHeaders, diagnosisTemplate, parseDiagnosisImport, diagnosisImpactWorkbook } from '../src/services/diagnosis-files';
import { diagnosisPresets } from '../src/mocks/diagnosis-presets';
import { planningPresets } from '../src/mocks/planning-presets';
import historical from '../src/mocks/planning.json';
import { createMockService } from '../src/services/mock';
import type { PlanVersion } from '../src/types/domain';
import { TestStorage } from './helpers/storage';
const preset = planningPresets[0];
const plan = {...historical.plans[0],id:'file-network',inputSnapshot:preset.baseline,links:preset.result!.links} as PlanVersion;
const csv = (text:string) => ({name:'场景.csv',bytes:new TextEncoder().encode(text)});
const header = diagnosisHeaders.join(',');
// 文件测试覆盖实际解析器和工作簿字节，不用模拟解析成功替代格式检查。
describe('故障场景文件', () => {
  it.each(['csv','xlsx'] as const)('%s 模板可读取为完整场景', async (format) => {
    const template = await diagnosisTemplate(format,diagnosisPresets); const parsed = await parseDiagnosisImport(template,plan,diagnosisPresets);
    expect(parsed.issues).toEqual([]); expect(parsed.drafts).toHaveLength(1); expect(parsed.drafts[0].faults).toEqual(diagnosisPresets[0].faults);
  });
  it('CSV 引号、换行、逗号、输入 BOM 和分号现象按字段边界解析', async () => {
    const parsed = await parseDiagnosisImport(csv('\ufeff'+header+'\r\na,"场景,一","第一行\n第二行",DEVICE,DV-0027,HW_FAILURE,"SY-0001; SY-0003;",2026-10-03T10:00:00+08:00,'),plan,diagnosisPresets);
    expect(parsed.issues).toEqual([]); expect(parsed.drafts[0].name).toBe('场景,一'); expect(parsed.drafts[0].description).toBe('第一行\n第二行'); expect(parsed.drafts[0].faults[0].symptomIds).toEqual(['SY-0001','SY-0003']);
  });
  it('类型不适配、重复对象、错误时间定位到原文件行', async () => {
    const parsed = await parseDiagnosisImport(csv(header+'\na,同名,,DEVICE,DV-0027,LINK_DOWN,SY-0005,不是时间,\na,同名,,DEVICE,DV-0027,HW_FAILURE,SY-0003,,'),plan,diagnosisPresets);
    expect(parsed.issues).toEqual(expect.arrayContaining([expect.objectContaining({row:2,field:'faultType'}),expect.objectContaining({row:2,field:'occurTime'}),expect.objectContaining({row:3,field:'objectId'})]));
  });
  it('未知列/重复表头拒绝；不静默接受截断数据', async () => {
    const parsed = await parseDiagnosisImport(csv(header+',extra\na,例,,DEVICE,DV-0027,HW_FAILURE,SY-0001,,,data'),plan,diagnosisPresets);
    expect(parsed.issues.some(i => i.field === 'header')).toBe(true);
    await expect(parseDiagnosisImport({name:'大文件.csv',bytes:new Uint8Array(5*1024*1024+1)},plan,diagnosisPresets)).rejects.toMatchObject({code:'IMPORT_LIMIT'});
  });
  it('XLSX 公式不使用缓存值，报告所在行列', async () => {
    const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('faults'); sheet.addRow(diagnosisHeaders); sheet.addRow(['x','名称','','DEVICE','DV-0027','HW_FAILURE','SY-0003','','']); sheet.getCell('B2').value = {formula:'1+1',result:2};
    const parsed = await parseDiagnosisImport({name:'公式.xlsx',bytes:new Uint8Array(await book.xlsx.writeBuffer())},plan,diagnosisPresets);
    expect(parsed.issues).toEqual(expect.arrayContaining([expect.objectContaining({row:2,field:'scenario_name',message:expect.stringContaining('公式')})]));
  });
  it('无效 UTF-8 和缺少 faults 工作表明确拒绝', async () => {
    await expect(parseDiagnosisImport({name:'bad.csv',bytes:new Uint8Array([255,254,192])},plan,diagnosisPresets)).rejects.toMatchObject({code:'IMPORT_ENCODING'});
    const book = new ExcelJS.Workbook(); book.addWorksheet('wrong');
    await expect(parseDiagnosisImport({name:'wrong.xlsx',bytes:new Uint8Array(await book.xlsx.writeBuffer())},plan,diagnosisPresets)).rejects.toMatchObject({code:'IMPORT_SHEET'});
  });
  it('日历无效日期不能被 Date.parse 自动归一化成有效输入', async () => {
    const parsed = await parseDiagnosisImport(csv(header+'\na,时间校验,,DEVICE,DV-0027,HW_FAILURE,SY-0003,2026-02-30T10:00:00Z,'),plan,diagnosisPresets);
    expect(parsed.issues.some((i) => i.field === 'occurTime')).toBe(true);
  });
  it('影响 XLSX 导出完整清单并保留筛选说明，文本不变成公式', async () => {
    const record = await createMockService(() => new TestStorage()).getDiagnosisReport('DG-HW'); record.name = '=1+1';
    const file = await diagnosisImpactWorkbook(record,'只显示严重'); const book = new ExcelJS.Workbook(); await book.xlsx.load(new Uint8Array(file.bytes).buffer);
    expect(book.getWorksheet('节点')!.rowCount).toBe(record.result.nodes.length+1);
    expect(book.getWorksheet('链路')!.rowCount).toBe(record.result.links.length+1);
    const notes=book.getWorksheet('说明')!;
    const scope=notes.getRows(1,notes.rowCount)!.find(row=>row.getCell(1).text==='导出范围');
    expect(scope!.getCell(2).text).toContain('完整结果');
  });
});

it.each(['csv','xlsx'] as const)('新网络 %s 模板按所选完整配置生成并预检匹配', async format => {
  const s=await interferenceFixture(),run=await s.submit();s.advance();const adopted=await s.adopt(run.view.run.analysisId,'POWER_OPT');
  const plan=(await s.confirm(adopted.plan.id)).plan,file=await s.diagnosis.getDiagnosisTemplate(format,plan.id);
  const parsed=await parseDiagnosisImport(file,plan,allDiagnosisPresets);
  expect(parsed.issues).toEqual([]);expect(parsed.matches).toEqual([true]);
  expect(parsed.drafts[0].faults).toEqual(networkDiagnosisPresets(plan)[0].faults);
});

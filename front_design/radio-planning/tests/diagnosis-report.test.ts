import { interferenceFixture } from './helpers/interference';
import { networkDiagnosisPresets } from '../src/services/diagnosis-catalog';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
// 兼容旧环境变量，但不再默认向前批目录落盘。
const outputDir=process.env.FRONTEND_CHECK_OUTPUT_DIR??process.env.DIAGNOSIS_CHECK_OUTPUT_DIR;
import JSZip from 'jszip';
import { createMockService } from '../src/services/mock';
import { createDiagnosisExport } from '../src/reports/diagnosis-export';
import { diagnosisReportSections } from '../src/reports/diagnosis-report';
import { diagnosisFigureSvg } from '../src/reports/diagnosis-figure';
import { diagnosisPresets, diagnosisDemoResult } from '../src/mocks/diagnosis-presets';
import { planningPresets } from '../src/mocks/planning-presets';
import { TestStorage } from './helpers/storage';

afterEach(() => vi.restoreAllMocks());
const samplePng = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5m8AAAAASUVORK5CYII=','base64'));
async function sample(id = 'balanced:multiple') {
  const old = await createMockService(() => new TestStorage()).getDiagnosisReport('DG-HW');
  const preset = diagnosisPresets.find(p => p.id === id)!; const network = planningPresets[0];
  return {...old,id:'DG-REPORT-CHECK',legacy:false,name:'中文多故障报告自检',scenarioId:'CHECK-SCENE',scenarioVersion:'2',faults:structuredClone(preset.faults),
    network:{...old.network,id:'CHECK-NETWORK',inputSnapshot:structuredClone(network.baseline),links:structuredClone(network.result!.links)},result:diagnosisDemoResult(preset.result,true)};
}
// 生成真实字节并检查内容；PDF 渲染和 DOCX 查看器验收另行记录。
describe('诊断报告三格式', () => {
  it('统一模型保留缺失值、人工研判和历史来源，不把 null 变成 0', async () => {
    const record = await sample(); const serialized = JSON.stringify(diagnosisReportSections(record));
    expect(serialized).toContain('52.0%'); expect(serialized).toContain('需要'); expect(serialized).toContain('未提供'); expect(serialized).toContain('CHECK-NETWORK');
    const legacy = await createMockService(() => new TestStorage()).getDiagnosisReport('DG-HW');
    expect(JSON.stringify(diagnosisReportSections(legacy))).toContain('不按清单自行补算');
  });
  it('JSON 保留完整冻结数据和单位，修改返回值不改变原记录', async () => {
    const record = await sample(); const file = await createDiagnosisExport(record,'json',{exportedAt:'2026-10-03T10:00:00Z'}); const parsed = JSON.parse(new TextDecoder().decode(file.bytes));
    expect(parsed.network).toEqual(record.network); expect(parsed.result).toEqual(record.result); expect(parsed.schemaVersion).toBe(1); expect(parsed.exportedAt).toBe('2026-10-03T10:00:00Z');
    parsed.network.name = '后续修改'; expect(record.network.name).not.toBe('后续修改');
  });
  it('DOCX 为真实 OOXML，正文可编辑，包含图片和重复表头', async () => {
    const record = await sample();
    let figurePng = samplePng;
    try { figurePng = new Uint8Array(await readFile('tmp/diagnosis-checks/figure.png')); } catch { /* 无渲染样件时仍检查打包结构，视觉自检另行执行。 */ }
    const file = await createDiagnosisExport(record,'docx',{figurePng,exportedAt:'2026-10-03T10:00:00Z'}); const zip = await JSZip.loadAsync(file.bytes); const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain(record.name); expect(xml).toContain('CHECK-NETWORK'); expect(xml).toContain('w:tblHeader'); expect(xml).toContain('需要'); expect(Object.keys(zip.files).some(name => name.startsWith('word/media/'))).toBe(true);
    if (outputDir) {
      await mkdir(outputDir,{recursive:true}); await writeFile(outputDir+'/diagnosis-report.docx',file.bytes); await writeFile(outputDir+'/figure.svg',diagnosisFigureSvg(record),'utf8');
    }
  });
  it('PDF 包含真实字体、分页和可选正文，输出长文本及历史样件', async () => {
    const fontBytes = new Uint8Array(await readFile('public/fonts/NotoSansCJKsc-Regular.otf'));
    if (outputDir) await mkdir(outputDir,{recursive:true});
    for (const [name,record] of [['multiple',await sample()],['single',await sample('balanced:hardware')],['legacy',await createMockService(() => new TestStorage()).getDiagnosisReport('DG-HW')]] as const) {
      if (name === 'multiple') record.result.notes.push('长文本换行与分页检查。'.repeat(80));
      const file = await createDiagnosisExport(record,'pdf',{fontBytes,exportedAt:'2026-10-03T10:00:00Z'});
      expect(new TextDecoder().decode(file.bytes.slice(0,8))).toContain('%PDF-'); expect(file.bytes.byteLength).toBeGreaterThan(10000);
      if (outputDir) await writeFile(outputDir+'/'+name+'.pdf',file.bytes);
    }
  },30000);
  it('字体加载失败明确拒绝，不伪装成功文件', async () => {
    vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('',{status:503}));
    await expect(createDiagnosisExport(await sample(),'pdf')).rejects.toThrow('字体加载失败');
  });
  it('图中全部文本转义，不把场景名称当成 SVG 指令', async () => {
    const record = await sample(); record.name = '<script>&测试'; const svg = diagnosisFigureSvg(record);
    expect(svg).toContain('&lt;script&gt;&amp;测试'); expect(svg).not.toContain('<script>'); expect(svg).toContain('LINK-A'); expect(svg).toContain('CHECK-NETWORK');
  });
});

it('抗干扰报告保留分析来源及部署坐标，示意图按新点位定位', async () => {
  const s=await interferenceFixture(),run=await s.submit();s.advance();const adopted=await s.adopt(run.view.run.analysisId,'NODE_REDEPLOY');
  const plan=(await s.confirm(adopted.plan.id)).plan,preset=networkDiagnosisPresets(plan)[0];
  const saved=await s.diagnosis.saveDiagnosisScenario({baseRevision:'initial',requestId:'scenario',scenarioId:null,draft:{name:'重部署诊断',description:'',planId:plan.id,faults:preset.faults}});
  const task=await s.diagnosis.submitDiagnosis({baseRevision:saved.revision,requestId:'diagnose',scenarioVersionId:saved.scenarios[0].versions[0].id,demo:'normal'});s.advance();
  const record=await s.diagnosis.getDiagnosisReport(task.view.run.id);
  const sections=JSON.stringify(diagnosisReportSections(record));
  expect(sections).toContain(run.view.run.analysisId);expect(sections).toContain('114.31, 37.26');
  const original=structuredClone(record);delete original.network.workflow!.configuration.deployment.find(row=>row.stationId==='ND-0004')!.plannedCoordinate;
  expect(diagnosisFigureSvg(record)).not.toBe(diagnosisFigureSvg(original));
  const file=await createDiagnosisExport(record,'json');
  expect(JSON.parse(new TextDecoder().decode(file.bytes)).network).toEqual(plan);
  if(outputDir){await mkdir(outputDir,{recursive:true});await writeFile(outputDir+'/interference-diagnosis.json',file.bytes);await writeFile(outputDir+'/interference-diagnosis.svg',diagnosisFigureSvg(record),'utf8');}
});

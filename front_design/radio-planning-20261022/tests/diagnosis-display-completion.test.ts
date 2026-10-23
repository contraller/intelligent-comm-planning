import { afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { h,nextTick,ssrContextKey,type App,type Component } from 'vue';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import { mkdir,writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { authorizeStore } from './helpers/auth';
import { interferenceFixture } from './helpers/interference';
import { networkDiagnosisPresets } from '../src/services/diagnosis-catalog';
import { assertDiagnosisResult } from '../src/services/diagnosis-validation';
import { readDiagnosis } from '../src/services/diagnosis-storage';
import { DIAGNOSIS_STORAGE_KEY } from '../src/config/demo';
import { diagnosisImpactWorkbook } from '../src/services/diagnosis-files';
import { createDiagnosisExport } from '../src/reports/diagnosis-export';
import { diagnosisReportSections } from '../src/reports/diagnosis-report';
import type { DiagnosisRecord } from '../src/types/diagnosis';
import DiagnosisNetworkPanel from '../src/components/DiagnosisNetworkPanel.vue';
import DiagnosisResultPanel from '../src/components/DiagnosisResultPanel.vue';
// 同型编译与基础宿主复用公共工具，业务夹具和生命周期保持本地。
import { clientTemplate, node, renderer, find, all, textOf, type HostNode } from './helpers/vue-client';
// 地图探针读取实际控件传值，故障和影响数组不作重新计算。
vi.mock('../src/components/MapCanvas.vue',()=>({default:Vue.defineComponent({inheritAttrs:false,props:['opacity','diagnosisFaults','diagnosisRegions','highlightLinkIds'],setup:p=>()=>Vue.h('map-probe',{...p})})}));
vi.mock('../src/components/ChartCanvas.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/AppDrawer.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/DiagnosisRootCausePanel.vue',()=>({default:{render:()=>null}}));
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }



let base:DiagnosisRecord,fixture:Awaited<ReturnType<typeof interferenceFixture>>,pinia:ReturnType<typeof createPinia>;const apps:App[]=[];
beforeAll(async()=>{
 for(const [component,path]of [[DiagnosisNetworkPanel,'src/components/DiagnosisNetworkPanel.vue'],[DiagnosisResultPanel,'src/components/DiagnosisResultPanel.vue']] as const)await clientTemplate(component,path, 'resource-ledger-render.ts');
 fixture=await interferenceFixture();const preset=networkDiagnosisPresets(fixture.plan)[0];
 const saved=await fixture.diagnosis.saveDiagnosisScenario({baseRevision:'initial',requestId:'display-scene',scenarioId:null,draft:{name:'诊断展示验证',description:'',planId:fixture.plan.id,faults:preset.faults}});
 const task=await fixture.diagnosis.submitDiagnosis({baseRevision:saved.revision,requestId:'display-run',scenarioVersionId:saved.scenarios[0].versions[0].id,demo:'normal'});
 fixture.advance();base=await fixture.diagnosis.getDiagnosisReport(task.view.run.id);
});
beforeEach(()=>{pinia=createPinia();setActivePinia(pinia);authorizeStore();class TestDocument extends EventTarget{activeElement=null;}vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());vi.stubGlobal('ShadowRoot',class{});});
afterEach(()=>{apps.splice(0).forEach(a=>a.unmount());disposePinia(pinia);vi.restoreAllMocks();vi.unstubAllGlobals();});
function mount(component:Component,props:Record<string,unknown>){const root=node('root'),app=renderer.createApp({render:()=>h(component,props)});app.provide(ssrContextKey,{modules:new Set()});app.mount(root);apps.push(app);return root;}
function sample(){
 const record=structuredClone(base),first=record.result.suggestions[0];
 record.result.suggestions=[{...structuredClone(first),priority:2,action:'后处理建议'},{...structuredClone(first),priority:1,action:'先处理甲'},{...structuredClone(first),priority:1,action:'先处理乙'}];
 record.result.suggestions[0].similarCases=[{id:'CASE-ZERO',solution:'零耗时样件',similarity:0.9,repairTimeMin:0},{id:'CASE-POSITIVE',solution:'修复案例样件',similarity:0.8,repairTimeMin:85},{id:'CASE-UNKNOWN',solution:'旧案例',similarity:null},{id:'CASE-NULL',solution:'空耗时',similarity:null,repairTimeMin:null}];
 const link=record.result.links[0];record.result.links=[true,false,null,null].map((isBackbone,i)=>({...link,linkId:'LINK-CHECK-'+i,isBackbone}));
 // 模拟旧数据缺列，不把当前必填类型放宽为可缺省。
 delete (record.result.links[3] as Partial<typeof link>).isBackbone;
 return record;
}
describe('诊断展示补齐',()=>{
 it.each([0,1])('透明度 %s 透传，故障图标与完整影响结果保持',async(value)=>{
  const record=structuredClone(base),before=JSON.stringify(record);
  const root=mount(DiagnosisNetworkPanel,{network:record.network,faults:record.faults,result:record.result,impactReady:true,drawing:false,selected:[],focus:null});
  const control=find(root,n=>n.tag==='input'&&n.props.type==='range')!;expect(control.props.min).toBe('0');expect(control.props.max).toBe('1');
  (control.props['onUpdate:modelValue'] as Function)(value);await nextTick();
  const p=find(root,n=>n.tag==='map-probe')!.props;expect(p.opacity).toBe(value);expect(p.diagnosisFaults).toEqual(record.faults);expect(p.diagnosisRegions).toEqual(record.result.regions);expect(JSON.stringify(record)).toBe(before);
 });
 it('页面与报告按 priority 稳定排序，同优先级保留所有建议，JSON 保持原序',async()=>{
  const record=sample(),before=JSON.stringify(record),root=mount(DiagnosisResultPanel,{result:record.result,impactReady:true,reportReady:true,exporting:false});
  await click(root,'建议');const summaries=all(root,n=>n.tag==='summary').map(textOf);
  expect(summaries).toEqual(['1. 先处理甲','1. 先处理乙','2. 后处理建议']);expect(textOf(root)).toContain('案例修复耗时：0 分钟');expect(textOf(root)).toContain('案例修复耗时：85 分钟');expect(textOf(root)).toContain('案例修复耗时：未提供');
  const sections=diagnosisReportSections(record).filter(s=>s.title.startsWith('修复建议'));expect(sections.map(s=>s.rows[0][1])).toEqual(['先处理甲','先处理乙','后处理建议']);expect(JSON.stringify(sections)).toContain('案例修复耗时：0 分钟');
  const json=await createDiagnosisExport(record,'json');expect(JSON.parse(new TextDecoder().decode(json.bytes)).result.suggestions.map((s:any)=>s.action)).toEqual(['后处理建议','先处理甲','先处理乙']);expect(JSON.stringify(record)).toBe(before);
 });
 it('报告与真实 XLSX 区分主干、非主干及缺省，其他列和完整范围保持',async()=>{
  const record=sample(),section=diagnosisReportSections(record).find(s=>s.title==='受影响链路')!;
  expect(section.headers.at(-1)).toBe('主干属性');expect(section.rows.map(r=>r.at(-1))).toEqual(['主干','非主干','未提供','未提供']);
  const file=await diagnosisImpactWorkbook(record,'仅严重'),book=new ExcelJS.Workbook();await book.xlsx.load(new Uint8Array(file.bytes).buffer);
  const sheet=book.getWorksheet('链路')!;expect(sheet.rowCount).toBe(5);expect(sheet.getRow(1).values).toEqual([,'链路','等级','状态','关联故障','带宽损失 kbps','原因','主干属性']);expect([2,3,4,5].map(i=>sheet.getCell(i,7).value)).toEqual(['主干','非主干','未提供','未提供']);
 });
 it.each([undefined,null,0,85])('结果边界接受案例耗时 %s，旧样例缺省保持',value=>{
  const record=structuredClone(base);record.result.suggestions[0].similarCases=[{id:'case',solution:'服务值',similarity:null,repairTimeMin:value}];
  expect(()=>assertDiagnosisResult(record.result,record.network,record.faults)).not.toThrow();
 });
 it.each([-1,NaN,Infinity,'85',false])('结果边界拒绝非法已提供案例耗时 %s',value=>{
  const record=structuredClone(base);record.result.suggestions[0].similarCases=[{id:'case',solution:'服务值',similarity:null,repairTimeMin:value as number}];
  expect(()=>assertDiagnosisResult(record.result,record.network,record.faults)).toThrow('诊断结果字段或引用不完整');
 });
 it('新增展示字段不放宽现有 Mock 持久化身份校验',()=>{
  const raw=fixture.storage.entries.get(DIAGNOSIS_STORAGE_KEY)!,workspace=JSON.parse(raw);
  workspace.runs[0].result.suggestions[0].similarCases[0].repairTimeMin=85;
  fixture.storage.entries.set(DIAGNOSIS_STORAGE_KEY,JSON.stringify(workspace));
  try{expect(()=>readDiagnosis(fixture.storage)).toThrow();expect(fixture.storage.entries.get(DIAGNOSIS_STORAGE_KEY)).toContain('repairTimeMin');}finally{fixture.storage.entries.set(DIAGNOSIS_STORAGE_KEY,raw);}
 });
 it('真实 DOCX 和 PDF 包含新增字段与长建议，并可输出分页样件',async()=>{
  const record=sample();record.result.suggestions[2].steps.push('长步骤换行检查。'.repeat(90));
  const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5m8AAAAASUVORK5CYII=','base64'));
  const docx=await createDiagnosisExport(record,'docx',{figurePng:png}),zip=await JSZip.loadAsync(docx.bytes),xml=await zip.file('word/document.xml')!.async('string');
  expect(xml).toContain('主干属性');expect(xml).toContain('案例修复耗时：85 分钟');expect(xml.indexOf('先处理甲')).toBeLessThan(xml.indexOf('先处理乙'));expect(xml.indexOf('先处理乙')).toBeLessThan(xml.indexOf('后处理建议'));
  const pdf=await createDiagnosisExport(record,'pdf',{fontBytes:new Uint8Array(readFileSync('public/fonts/NotoSansCJKsc-Regular.otf'))});
  expect(new TextDecoder().decode(pdf.bytes.slice(0,8))).toContain('%PDF-');expect(pdf.bytes.length).toBeGreaterThan(10000);
  if(process.env.FRONTEND_CHECK_OUTPUT_DIR){await mkdir(process.env.FRONTEND_CHECK_OUTPUT_DIR,{recursive:true});await writeFile(process.env.FRONTEND_CHECK_OUTPUT_DIR+'/batch52-report.pdf',pdf.bytes);await writeFile(process.env.FRONTEND_CHECK_OUTPUT_DIR+'/batch52-report.docx',docx.bytes);}
 },30000);
});


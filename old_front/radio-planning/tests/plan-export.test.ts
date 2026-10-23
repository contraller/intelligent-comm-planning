import { interferenceFixture } from './helpers/interference';
import { describe,it,expect } from 'vitest';
import { mkdir,writeFile } from 'node:fs/promises';
import Excel from 'exceljs';
import { createMockService } from '../src/services/mock';
import { createPlanningMock } from '../src/services/planning-mock';
import { planningPresets } from '../src/mocks/planning-presets';
import { readResources } from '../src/services/resource-storage';
import { initialResources } from '../src/mocks/resource-presets';
import { TestStorage } from './helpers/storage';
import { saveTaskInput } from './helpers/tasks';
import { exportApiPlanFile } from '../src/services/plan-export';
import { apiPlan } from './fixtures/planning-api';
import type { PlanningResultDetails } from '../src/types/planning-result-details';
import { getPresetResultDetails } from '../src/services/planning-result-details-mock';
// 样件输出由本次验证显式指定。
const outputDir=process.env.FRONTEND_CHECK_OUTPUT_DIR;
describe('方案快照文件',()=>{
  // 导出只展开当前保存版本，不重算服务数量或将未知值转成0/false。
  it('候选三张表和完整JSON保留统计差异、原分数及空值', async () => {
    const plan = apiPlan(), details = getPresetResultDetails('balanced', planningPresets[0].input)!;
    const screening = details.candidateScreening!; screening.candidateCount = 1137; screening.deployableCount = 1117; screening.candidates![0].score = 0.82;
    plan.result.resultDetails = details; const before = structuredClone(plan);
    const json = await exportApiPlanFile(plan, 'json'); expect(JSON.parse(new TextDecoder().decode(json.bytes)).plan.result.resultDetails.candidateScreening).toEqual(screening);
    const file = await exportApiPlanFile(plan, 'xlsx'), book = new Excel.Workbook(); await book.xlsx.load(new Uint8Array(file.bytes).buffer);
    expect(book.getWorksheet('候选统计')!.getRow(2).values).toEqual([undefined, screening.sourceLabel, 1137, 1117, 4]);
    const sheet = book.getWorksheet('候选明细')!, headers = sheet.getRow(1).values as string[];
    expect(sheet.getCell(2, headers.indexOf('score')).value).toBe(0.82);
    expect(sheet.getCell(4, headers.indexOf('isDeployable')).value).toBe(false);
    expect(sheet.getCell(5, headers.indexOf('coordinate')).value).toBe('未提供');
    expect(book.getWorksheet('筛除统计')!.getCell('B3').value).toBe(0); expect(plan).toEqual(before);
  });
  it('HTTP 补充表逐项读取冻结原值，null、空数组、0 和 false 分开保留',async()=>{
    const plan=apiPlan();
    const details:PlanningResultDetails={schemaVersion:1,assetVersion:'http-export-v1',deviceParameters:[{deviceId:'E1',tiltDeg:0,tiltEffective:false}],
      routeQuality:[{routeId:'R1',demandId:'D1',hopCount:0,totalDistanceM:null,totalDelayMs:0,bottleneckMarginDb:-3,reliability:0,isFeasible:false,bottleneckLinkId:'L1'}],
      frequencyAssignments:[{id:'A1',linkId:'L1',resourceGroupId:'F1',freqId:null,reuseGroup:0,frequencyKhz:3000,bandwidthKhz:25}],frequencyConflicts:[],
      frequencyGap:{requiredChannels:353,availableChannels:48,shortage:0},conflictFree:false,unreachableDemandIds:null};
    plan.result.resultDetails=details;const before=structuredClone(plan);
    const json=await exportApiPlanFile(plan,'json');expect(JSON.parse(new TextDecoder().decode(json.bytes)).plan.result.resultDetails).toEqual(details);
    const file=await exportApiPlanFile(plan,'xlsx'),book=new Excel.Workbook();await book.xlsx.load(new Uint8Array(file.bytes).buffer);
    expect(book.getWorksheet('结果明细版本')!.getCell('B2').value).toBe('http-export-v1');
    expect(book.getWorksheet('设备参数补充')!.getCell('B2').value).toBe(0);expect(book.getWorksheet('设备参数补充')!.getCell('C2').value).toBe(false);
    expect(book.getWorksheet('路由质量')!.getCell('D2').value).toBe('未提供');expect(book.getWorksheet('路由质量')!.getCell('G2').value).toBe(0);
    expect(book.getWorksheet('频率分配')!.getCell('D2').value).toBe('未提供');expect(book.getWorksheet('频率分配')!.getCell('E2').value).toBe(0);
    expect(book.getWorksheet('频率冲突')!.getCell('A1').value).toBe('没有记录');expect(book.getWorksheet('不可达需求')!.getCell('A1').value).toBe('未提供');
    expect(book.getWorksheet('频率缺口与结论')!.getRow(2).values).toEqual([undefined,353,48,0,false]);expect(plan).toEqual(before);
  });
  it('HTTP 方案 JSON/XLSX 保留多面孔洞、PNG 元数据和完整冻结输入',async()=>{
    const plan=apiPlan(),json=await exportApiPlanFile(plan,'json'),parsed=JSON.parse(new TextDecoder().decode(json.bytes));
    expect(parsed.source).toBe('测试接口');expect(parsed.plan).toEqual(plan);
    const xlsx=await exportApiPlanFile(plan,'xlsx'),book=new Excel.Workbook();await book.xlsx.load(new Uint8Array(xlsx.bytes).buffer);
    const parts:string[]=[];book.getWorksheet('完整快照')!.eachRow((row,i)=>{if(i>1)parts.push(String(row.getCell(2).value));});
    expect(JSON.parse(parts.join('')).plan).toEqual(plan);expect(book.getWorksheet('覆盖几何')!.rowCount).toBe(2);expect(book.getWorksheet('覆盖栅格元数据')!.rowCount).toBe(2);
    expect(book.getWorksheet('结果明细版本')!.getCell('A1').value).toBe('未提供');expect(book.getWorksheet('频率分配')!.getCell('A1').value).toBe('未提供');
  });
  it('JSON/XLSX 保留同一保存快照及元数据，不混入当前资源',async()=>{
    const storage=new TestStorage(),resource=createMockService(()=>storage);let time=1000;
    const planning=createPlanningMock(()=>storage,()=>readResources(storage,initialResources()),()=>time),input=structuredClone(planningPresets[0].input);
    await saveTaskInput(storage,input,'T');const run=await planning.submitPlanning({baseRevision:'initial',requestId:'run',taskId:'T',parentPlanVersionId:null,input});time+=10000;
    const saved=await planning.savePlanVersion({baseRevision:run.workspace.revision,requestId:'save',jobId:run.view.job.id,name:'=方案文本',note:'冻结记录'});
    await resource.commitResources({baseRevision:'initial',stations:[{id:'ND-0001',name:'当前新名称'}],devices:[]});
    const json=await planning.exportPlanVersion({planId:saved.plan.id,format:'json'}),parsed=JSON.parse(new TextDecoder().decode(json.bytes));
    expect(parsed.plan.inputSnapshot).toEqual(saved.plan.inputSnapshot);expect(parsed.plan.sourceChanged).toBe(true);expect(parsed.source).toContain('Mock');
    const xlsx=await planning.exportPlanVersion({planId:saved.plan.id,format:'xlsx'}),book=new Excel.Workbook();await book.xlsx.load(new Uint8Array(xlsx.bytes).buffer);
    expect(book.getWorksheet('方案说明')!.getCell('B2').value).toBe('=方案文本');
    const rows=book.getWorksheet('完整快照')!,parts:string[]=[];rows.eachRow((row,i)=>{if(i>1)parts.push(String(row.getCell(2).value));});
    const full=JSON.parse(parts.join(''));expect(full.plan).toEqual(parsed.plan);expect(book.getWorksheet('通联需求')!.rowCount).toBe(3);
    expect(parsed.plan.resultDetails).toEqual(saved.plan.resultDetails);expect(saved.plan.resultDetails).toBeDefined();
    expect(book.getWorksheet('设备参数补充')!.getCell('B2').value).toBe('未提供');expect(book.getWorksheet('设备参数补充')!.getCell('C2').value).toBe(false);
    expect(book.getWorksheet('频率分配')!.rowCount).toBe(saved.plan.resultDetails!.frequencyAssignments!.length+1);
    if (outputDir) {
      await mkdir(outputDir,{recursive:true});
      await writeFile(outputDir+'/plan.json',json.bytes);await writeFile(outputDir+'/plan.xlsx',xlsx.bytes);
    }
  });
  it('历史缺字段明确未提供，不补当前任务；不存在或格式无效拒绝',async()=>{
    const service=createMockService(()=>new TestStorage()),file=await service.exportPlanVersion({planId:'PLAN-V1',format:'xlsx'}),book=new Excel.Workbook();await book.xlsx.load(new Uint8Array(file.bytes).buffer);
    expect(book.getWorksheet('任务输入')!.getCell('A1').value).toBe('未提供');
    expect(book.getWorksheet('路由质量')!.getCell('A1').value).toBe('未提供');
    await expect(service.exportPlanVersion({planId:'UNKNOWN',format:'json'})).rejects.toMatchObject({code:'PLAN_NOT_FOUND'});
    await expect(service.exportPlanVersion({planId:'PLAN-V1',format:'csv' as never})).rejects.toMatchObject({code:'EXPORT_FORMAT'});
  });
});

it('抗干扰方案 JSON/XLSX 同时保留来源、输入点位和重部署输出', async () => {
  const s=await interferenceFixture(),run=await s.submit();s.advance();
  const adopted=await s.adopt(run.view.run.analysisId,'NODE_REDEPLOY');
  const json=await s.planning.exportPlanVersion({planId:adopted.plan.id,format:'json'});
  const parsed=JSON.parse(new TextDecoder().decode(json.bytes));
  expect(parsed.plan.workflow.interferenceOrigin.analysisId).toBe(run.view.run.analysisId);
  expect(parsed.plan.inputSnapshot).toEqual(s.plan.inputSnapshot);
  expect(parsed.plan.resultDetails).toEqual(adopted.plan.resultDetails);expect(adopted.plan.resultDetails).toBeDefined();
  const xlsx=await s.planning.exportPlanVersion({planId:adopted.plan.id,format:'xlsx'}),book=new Excel.Workbook();
  await book.xlsx.load(new Uint8Array(xlsx.bytes).buffer);
  expect(book.getWorksheet('抗干扰来源')!.rowCount).toBe(2);
  expect(book.getWorksheet('结果明细版本')!.getCell('B2').value).toBe(adopted.plan.resultDetails!.assetVersion);
  expect(JSON.stringify(book.getWorksheet('部署')!.getSheetValues())).toContain('[114.31,37.26]');
  if(outputDir){await mkdir(outputDir,{recursive:true});await writeFile(outputDir+'/interference-plan.json',json.bytes);await writeFile(outputDir+'/interference-plan.xlsx',xlsx.bytes);}
});

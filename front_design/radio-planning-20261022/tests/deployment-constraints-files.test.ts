import { describe,it,expect } from 'vitest';
import Excel from 'exceljs';
import { taskTemplate,parseTaskFileInput } from '../src/services/task-files';
import { deploymentPlanningPresets } from '../src/mocks/deployment-constraint-presets';
import { exportApiPlanFile } from '../src/services/plan-export';
import { apiPlan } from './fixtures/planning-api';
import type { PlanningInput } from '../src/types/planning';
const input=()=>structuredClone(deploymentPlanningPresets[0].input);
const parse=(files:Awaited<ReturnType<typeof taskTemplate>>[],current=input())=>parseTaskFileInput({files,input:current,context:'planning',baseResourceRevision:'initial',baseTaskRevision:'initial'});
// 真实 CSV/XLSX 编解码，检查空列清除、实际行号及冻结导出。
describe('部署条件任务文件',()=>{
  it.each(['csv','xlsx'] as const)('%s 完整扩展含坐标内环往返',async format=>{
    const value=input();value.deploymentConstraints!.forcedInclude=[{lon:170,lat:-70}];value.deploymentConstraints!.elevationRangeM=[-50,0];
    value.deploymentConstraints!.forcedExcludePolygons=[{type:'Polygon',coordinates:[[[114,37],[115,37],[115,38],[114,37]],[[114.2,37.1],[114.3,37.1],[114.3,37.2],[114.2,37.1]]]}];
    const files=format==='xlsx'?[await taskTemplate('xlsx','task_scenarios',value)]:await Promise.all(['task_scenarios','task_links'].map(k=>taskTemplate('csv',k as never,value)));
    const result=await parse(files);expect(result.issues).toEqual([]);expect(result.input).toEqual(value);
  });
  it('旧文件明确清除已有约束，应用前可见差异和提示',async()=>{
    const value:PlanningInput=input();delete value.deploymentConstraints;
    const result=await parse([await taskTemplate('xlsx','task_scenarios',value)]);
    expect(result.input).not.toHaveProperty('deploymentConstraints');expect(result.notes.join('')).toContain('清空');
    expect(result.differences.find(d=>d.field==='deploymentConstraints')).toMatchObject({before:input().deploymentConstraints,after:undefined});
  });
  it.each(['forced_include_json','min_elevation_m','forced_exclude_polygons_json'])('坏 %s 精确报告实际行号',async field=>{
    const file=await taskTemplate('xlsx','task_scenarios',input()),book=new Excel.Workbook();await book.xlsx.load(new Uint8Array(file.bytes).buffer);
    const sheet=book.getWorksheet('task_scenarios')!,headers=sheet.getRow(1).values as string[];
    sheet.getRow(4).values=sheet.getRow(2).values;sheet.getRow(2).values=[];
    sheet.getRow(4).getCell(headers.indexOf(field)).value=field==='min_elevation_m'?'':field==='forced_include_json'?'{broken':'[{"type":"Polygon","coordinates":[]}]';
    const result=await parse([{...file,bytes:new Uint8Array(await book.xlsx.writeBuffer())}]);expect(result.input).toBeNull();expect(result.issues.some(i=>i.sheet==='task_scenarios'&&i.row===4)).toBe(true);
  });
  it('XLSX三张条件表与JSON均取选定版本，旧版本未设置',async()=>{
    const plan=apiPlan();plan.input.deploymentConstraints=input().deploymentConstraints;
    const expected=structuredClone(plan.input.deploymentConstraints),json=await exportApiPlanFile(plan,'json');expect(JSON.parse(new TextDecoder().decode(json.bytes)).plan.input.deploymentConstraints).toEqual(expected);
    for(const old of [false,true]){if(old)delete plan.input.deploymentConstraints;const f=await exportApiPlanFile(plan,'xlsx'),book=new Excel.Workbook();await book.xlsx.load(new Uint8Array(f.bytes).buffer);
      expect(['部署筛选条件','强制部署点','禁部署区'].every(name=>!!book.getWorksheet(name))).toBe(true);if(old)expect(book.getWorksheet('部署筛选条件')!.getCell('A1').value).toBe('未设置');else expect(book.getWorksheet('部署筛选条件')!.getCell('B2').value).toBe('18');}
  });
});

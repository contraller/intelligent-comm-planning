import { describe, expect, it } from 'vitest';
import Excel from 'exceljs';
import Papa from 'papaparse';
import { parseTaskFileInput, taskTemplate } from '../src/services/task-files';
import { exportApiPlanFile } from '../src/services/plan-export';
import { input, apiPlan } from './fixtures/planning-api';
const value=()=>{const v=input();Object.assign(v.demands[0],{routeStrategy:'MIN_DELAY',needBackup:false});return v;};
const parse=(files:Awaited<ReturnType<typeof taskTemplate>>[])=>parseTaskFileInput({files,input:value(),context:'planning',baseResourceRevision:'r1',baseTaskRevision:'t1'});
// 使用真实编码器验证文件，不把文本 false 当作真假判断。
describe('路由文件边界与冻结导出',()=>{
  it.each(['csv','xlsx'] as const)('%s往返保持 false 和策略',async format=>{
    const files=format==='xlsx'?[await taskTemplate(format,'task_scenarios',value())]:await Promise.all((['task_scenarios','task_links'] as const).map(kind=>taskTemplate(format,kind,value())));
    const result=await parse(files);expect(result.issues).toEqual([]);expect(result.input).toEqual(value());
  });
  it('旧CSV缺两列清空当前要求且保留差异',async()=>{
    const files=await Promise.all((['task_scenarios','task_links'] as const).map(kind=>taskTemplate('csv',kind,value())));
    const rows=Papa.parse<string[]>(new TextDecoder().decode(files[1].bytes)).data;
    files[1].bytes=new TextEncoder().encode(Papa.unparse(rows.map(row=>row.slice(0,-2))));
    const preview=await parse(files);expect(preview.input!.demands[0]).not.toHaveProperty('routeStrategy');expect(preview.input!.demands[0]).not.toHaveProperty('needBackup');
    expect(preview.notes.join('')).toContain('清空');expect(preview.differences.some(d=>d.field==='demands')).toBe(true);
  });
  it.each([['strategy','UNKNOWN'],['need_backup','1'],['need_backup','FALSE']])('非法 %s=%s 定位第四行',async(field,bad)=>{
    const file=await taskTemplate('xlsx','task_scenarios',value()),book=new Excel.Workbook();await book.xlsx.load(new Uint8Array(file.bytes).buffer);
    const sheet=book.getWorksheet('task_links')!,headers=sheet.getRow(1).values as string[];
    sheet.getRow(4).values=sheet.getRow(2).values;sheet.getRow(2).values=[];sheet.getRow(4).getCell(headers.indexOf(field)).value=bad;
    const preview=await parse([{...file,bytes:new Uint8Array(await book.xlsx.writeBuffer())}]);
    expect(preview.input).toBeNull();expect(preview.issues).toContainEqual(expect.objectContaining({sheet:'task_links',row:4,field}));
  });
  it('XLSX原生false与空值分别读取',async()=>{
    const file=await taskTemplate('xlsx','task_scenarios',value()),book=new Excel.Workbook();await book.xlsx.load(new Uint8Array(file.bytes).buffer);
    const sheet=book.getWorksheet('task_links')!,headers=sheet.getRow(1).values as string[];sheet.getRow(2).getCell(headers.indexOf('need_backup')).value=false;
    expect((await parse([{...file,bytes:new Uint8Array(await book.xlsx.writeBuffer())}])).input!.demands[0].needBackup).toBe(false);
    sheet.getRow(2).getCell(headers.indexOf('need_backup')).value=null;
    expect((await parse([{...file,bytes:new Uint8Array(await book.xlsx.writeBuffer())}])).input!.demands[0]).not.toHaveProperty('needBackup');
  });
  it('模板拒绝坏布尔而不生成可下载的默认请求',async()=>{const v=value();Object.assign(v.demands[0],{needBackup:'false'});await expect(taskTemplate('csv','task_links',v)).rejects.toMatchObject({code:'VALIDATION_ERROR'});});
  it('HTTP方案JSON及XLSX只取冻结输入，旧版显示未指定',async()=>{
    const plan=apiPlan();plan.input=value();const file=await exportApiPlanFile(plan,'xlsx'),book=new Excel.Workbook();await book.xlsx.load(new Uint8Array(file.bytes).buffer);
    const sheet=book.getWorksheet('逐需求路由条件')!;expect(sheet.getCell('B2').value).toBe('最小时延');expect(sheet.getCell('C2').value).toBe('不请求备份');
    expect(JSON.parse(new TextDecoder().decode((await exportApiPlanFile(plan,'json')).bytes)).plan.input).toEqual(value());
    const old=apiPlan();await book.xlsx.load(new Uint8Array((await exportApiPlanFile(old,'xlsx')).bytes).buffer);expect(book.getWorksheet('逐需求路由条件')!.getCell('C2').value).toBe('未指定');
    expect(old.input.demands[0]).not.toHaveProperty('needBackup');
  });
});

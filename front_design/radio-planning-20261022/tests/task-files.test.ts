import { describe,it,expect } from 'vitest';
import Excel from 'exceljs';
import { createMockService } from '../src/services/mock';
import { planningPresets } from '../src/mocks/planning-presets';
import { TestStorage } from './helpers/storage';
import type { TaskImportRequest } from '../src/types/task';
import { taskTemplate, parseTaskFileInput } from '../src/services/task-files';
import { input } from './fixtures/planning-api';
const fixture=()=>{const storage=new TestStorage(),service=createMockService(()=>storage);const request=(files:TaskImportRequest['files']):TaskImportRequest=>({files,context:'planning',input:structuredClone(planningPresets[0].input),baseResourceRevision:'initial',baseTaskRevision:'initial'});return {storage,service,request};};
async function altered(edit:(book:Excel.Workbook)=>void){
  const {service}=fixture(),file=await service.getTaskTemplate('xlsx'),book=new Excel.Workbook();await book.xlsx.load(new Uint8Array(file.bytes).buffer);edit(book);
  return {...file,bytes:new Uint8Array(await book.xlsx.writeBuffer())};
}
// 文件真实解析、错误行定位和边界语义验证。
describe('完整任务文件导入',()=>{
  it('HTTP 模板保留当前时间、偏好和设备端点，解析不强加 Mock 预设',async()=>{
    const defaults={...input(),startTime:'2026-10-05T09:00:00+08:00',durationH:8};
    Object.assign(defaults.demands[0],{endpointMode:'device',sourceDeviceId:'E1',targetDeviceId:'E2',preferredClass:'HF'});
    const file=await taskTemplate('xlsx','task_scenarios',defaults),s=fixture();
    const parsed=await parseTaskFileInput({...s.request([file]),input:defaults});
    expect(parsed.issues).toEqual([]);expect(parsed.input).toEqual(defaults);expect(parsed.taskId).toBe('TASK-NEW');expect(parsed.sourceRows).toEqual({D1:2});
  });
  it.each(['xlsx','csv'] as const)('%s 模板往返保留空值和布尔，预检不落盘',async format=>{
    const s=fixture(),files=format==='xlsx'?[await s.service.getTaskTemplate('xlsx')]:[await s.service.getTaskTemplate('csv','task_links'),await s.service.getTaskTemplate('csv','task_scenarios')];
    const preview=await s.service.previewTaskImport(s.request(files));expect(preview.issues).toEqual([]);expect(preview.input!.demands[0].mandatory).toBe(true);expect(preview.input!.demands[0].dataVolumeMb).toBeNull();expect(preview.input!.startTime).toBeNull();expect(s.storage.writes).toBe(0);
  });
  it.each(['wrong-task','duplicate-id','device-owner','bool','number','date','unknown-column'])('错误阻止整个任务应用并提供行号：%s',async kind=>{
    const file=await altered(book=>{
      const links=book.getWorksheet('task_links')!,scene=book.getWorksheet('task_scenarios')!;
      if(kind==='wrong-task')links.getCell('B2').value='OTHER';
      if(kind==='duplicate-id')links.getCell('A3').value=links.getCell('A2').value;
      if(kind==='device-owner'){links.getCell('M2').value='device';links.getCell('N2').value='DV-0027';links.getCell('O2').value='DV-0001';}
      if(kind==='bool')links.getCell('F2').value='False';
      if(kind==='number')links.getCell('H2').value='';
      if(kind==='date')scene.getCell('D2').value='2026-02-30T08:00:00+08:00';
      if(kind==='unknown-column')scene.getCell('J1').value='unknown';
    });
    const s=fixture();
    try{const result=await s.service.previewTaskImport(s.request([file]));expect(result.input).toBeNull();expect(result.issues.length).toBeGreaterThan(0);expect(result.issues.every(i=>i.row)).toBe(true);}catch(e){expect((e as {code:string}).code).toBe('IMPORT_LIMIT');}
    expect(s.storage.writes).toBe(0);
  });
  it('公式和隐藏行拒绝，不执行表格内容',async()=>{
    for(const edit of [(b:Excel.Workbook)=>{b.getWorksheet('task_links')!.getCell('G2').value={formula:'1+1',result:2};},(b:Excel.Workbook)=>{b.getWorksheet('task_links')!.getRow(2).hidden=true;}]){
      const s=fixture(),result=await s.service.previewTaskImport(s.request([await altered(edit)]));expect(result.input).toBeNull();expect(result.issues.length).toBeGreaterThan(0);
    }
  });
  it('支持原始两表头并明确默认来源，时间/偏好不被丢弃',async()=>{
    const file=await altered(book=>{const scene=book.getWorksheet('task_scenarios')!,links=book.getWorksheet('task_links')!;scene.spliceColumns(7,3);links.spliceColumns(13,3);scene.getCell('D2').value='2026-09-08T08:00:00+08:00';scene.getCell('E2').value=12;links.getCell('L2').value='HF';});
    const s=fixture(),r=await s.service.previewTaskImport(s.request([file]));expect(r.issues).toEqual([]);expect(r.input!.startTime).toBe('2026-09-08T08:00:00+08:00');expect(r.input!.durationH).toBe(12);expect(r.input!.demands[0].preferredClass).toBe('HF');expect(r.notes).toHaveLength(3);
  });
  it('只选一张 CSV、多任务及过期版本不会写入',async()=>{
    const s=fixture();await expect(s.service.previewTaskImport(s.request([await s.service.getTaskTemplate('csv','task_links')]))).rejects.toMatchObject({code:'IMPORT_FORMAT'});
    const multi=await altered(b=>b.getWorksheet('task_scenarios')!.addRow(['OTHER','多任务','114;36;115;37','','','']));
    expect((await s.service.previewTaskImport(s.request([multi]))).input).toBeNull();
    const req=s.request([await s.service.getTaskTemplate('xlsx')]);req.baseTaskRevision='stale';
    await expect(s.service.previewTaskImport(req)).rejects.toMatchObject({code:'TASK_REVISION_CONFLICT'});expect(s.storage.writes).toBe(0);
  });
});

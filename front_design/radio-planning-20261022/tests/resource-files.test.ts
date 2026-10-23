import { describe, expect, it } from 'vitest';
import Excel from 'exceljs';
import { mkdir, writeFile } from 'node:fs/promises';
import Papa from 'papaparse';
import { initialResources } from '../src/mocks/resource-presets';
import { exportResourceFile, parseResourceImport, resourceHeaders, resourceKinds, resourceTemplate, selectResourceExport } from '../src/services/resource-files';
import { createMockService } from '../src/services/mock';
import { RESOURCE_MAX_FILE_BYTES, RESOURCE_STORAGE_KEY } from '../src/config/demo';
import type { ResourceFile,ResourceKind } from '../src/types/resource-edit';
import { TestStorage } from './helpers/storage';

// 未显式指定本批目录时只验证内存字节，不覆盖历史样件。
const outputDir=process.env.FRONTEND_CHECK_OUTPUT_DIR;
const source=initialResources();
const parse=(file:ResourceFile,kind:ResourceKind='nodes')=>parseResourceImport({file,kind,baseRevision:'initial',context:'ledger'},source,source);
const csv=(kind:ResourceKind,rows:unknown[][],head=resourceHeaders[kind]):ResourceFile=>({name:'test.csv',mime:'text/csv',bytes:new TextEncoder().encode(Papa.unparse([head,...rows]))});
async function editWorkbook(file:ResourceFile,edit:(book:Excel.Workbook)=>void){
  const book=new Excel.Workbook();await book.xlsx.load(new Uint8Array(file.bytes).buffer);edit(book);
  return {...file,bytes:new Uint8Array(await book.xlsx.writeBuffer())};
}
describe('资源 CSV/XLSX 预检与往返',()=>{
  it('旧设备模板往返保留实例模式和端口，不清空未导出的维护字段',async()=>{
    const current=initialResources();current.devices[0].currentWorkMode='MOCK_HOPPING';current.devices[0].ports![0].rateKbps=19.2;
    const file=await exportResourceFile(current,{format:'csv',kinds:['devices']}),result=await parseResourceImport({file,kind:'devices',baseRevision:'initial',context:'ledger'},current,initialResources());
    expect(result.issues).toEqual([]);expect(result.candidate.devices[0].ports).toEqual(current.devices[0].ports);expect(result.candidate.devices[0].currentWorkMode).toBe('MOCK_HOPPING');expect(result.rows.every(row=>row.action==='UNCHANGED')).toBe(true);
  });
  // 服务解析同一筛选条件，链路搜索不会因分页或缺失端点关系导出空表。
  it('GIS 链路筛选导出保留两端设备，预检与实际文件范围一致',async()=>{
    const service=createMockService(()=>new TestStorage());
    const workspace=await service.loadResourceReadContext({context:'gis'});
    const request={format:'csv' as const,kinds:['devices' as const],context:'gis' as const,
      gis:{revision:workspace.revision,range:'filtered' as const,browse:'devices' as const,filter:{search:'PL-001'}}};
    const preview=await service.previewResourceExport(request),file=await service.exportResources(request);
    const rows=Papa.parse<string[]>(new TextDecoder().decode(file.bytes)).data;
    expect(preview.tables).toEqual([{kind:'devices',count:2}]);
    expect(rows.slice(1).filter(row=>row.length>1).map(row=>row[0]).sort()).toEqual(['DV-0001','DV-0027']);
  });
  it.each(resourceKinds)('已保存 %s CSV 往返全部无变化',async kind=>{
    const result=await parse(await exportResourceFile(source,{format:'csv',kinds:[kind]}),kind);
    expect(result.issues).toEqual([]);expect(result.rows.every(r=>r.action==='UNCHANGED')).toBe(true);
  });
  it('XLSX 全库往返无变化，完整模板跨表新增引用不受表次序影响',async()=>{
    const savedFile=await exportResourceFile(source,{format:'xlsx',kinds:resourceKinds});
    const exported=await parse(savedFile);
    if (outputDir) {
      await mkdir(outputDir,{recursive:true});
      await writeFile(outputDir+'/saved-resources.xlsx',savedFile.bytes);
    }
    expect(exported.issues).toEqual([]);expect(exported.rows).toHaveLength(562);
    expect(exported.rows.every(r=>r.action==='UNCHANGED')).toBe(true);
    const template=await resourceTemplate('xlsx'),original=new Excel.Workbook(),reversed=new Excel.Workbook();
    if (outputDir) {
      await writeFile(outputDir+'/resource-template.xlsx',template.bytes);
      for(const kind of resourceKinds)await writeFile(outputDir+'/template-'+kind+'.csv',(await resourceTemplate('csv',kind)).bytes);
    }
    await original.xlsx.load(new Uint8Array(template.bytes).buffer);
    for(const kind of ['devices','interference_sources','nodes']) {
      const sheet=reversed.addWorksheet(kind);original.getWorksheet(kind)!.eachRow(row=>sheet.addRow(row.values));
    }
    const preview=await parse({...template,bytes:new Uint8Array(await reversed.xlsx.writeBuffer())});
    expect(preview.issues).toEqual([]);expect(preview.rows.map(r=>r.action)).toEqual(['NEW','NEW','NEW']);
    expect(preview.candidate.devices.at(-1)?.stationId).toBe('NEW-STATION-01');
  });
  it('模板整批提交一次，重复提交不写第二次，同 ID 不同文件被拒绝',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage);
    const preview=await service.previewResourceImport({file:await service.getResourceTemplate('xlsx'),kind:'nodes',context:'ledger',baseRevision:'initial'});
    const request={baseRevision:'initial',requestId:'import',preview};
    const saved=await service.commitResourceImport(request);
    expect(saved.resources.stations).toHaveLength(133);expect(storage.writes).toBe(1);
    expect((await service.commitResourceImport(request)).meta.revision).toBe(saved.meta.revision);expect(storage.writes).toBe(1);
    const altered=structuredClone(request);altered.preview.request.file.name='changed.xlsx';
    await expect(service.commitResourceImport(altered)).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
  });
  it('任一行错误保留原存储并给出工作表、行、字段；伪造预检不可绕过',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage);
    const file=await editWorkbook(await resourceTemplate('xlsx'),book=>{book.getWorksheet('devices')!.getCell('H2').value=999;});
    const preview=await service.previewResourceImport({file,kind:'nodes',context:'ledger',baseRevision:'initial'});
    expect(preview.issues).toContainEqual(expect.objectContaining({sheet:'devices',row:2,field:'txPowerDbm'}));
    preview.issues=[];
    await expect(service.commitResourceImport({baseRevision:'initial',requestId:'bad',preview})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBeNull();expect(storage.writes).toBe(0);
  });
  it('按 ID 更新已有开放字段，拒绝改设备归属和通过文件恢复下架',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage);
    const down=await service.setDeviceAvailability({baseRevision:'initial',requestId:'down',ids:['DV-0001'],availability:'OFF_SHELF'});
    const file=await exportResourceFile(down.resources,{format:'xlsx',kinds:['devices'],ids:{devices:['DV-0001']}});
    const edited=await editWorkbook(file,book=>{book.getWorksheet('devices')!.getCell('L2').value='ACTIVE';book.getWorksheet('devices')!.getCell('B2').value='ND-0002';});
    const preview=await parseResourceImport({file:edited,kind:'devices',context:'ledger',baseRevision:down.meta.revision},down.resources,source);
    expect(preview.issues.map(i=>i.field)).toEqual(expect.arrayContaining(['availability','stationId']));
  });
  it('CSV 允许 BOM、分号多值、文本布尔及空值，非法布尔不转真',async()=>{
    const file=await exportResourceFile(source,{format:'csv',kinds:['nodes'],ids:{nodes:['ND-0001']}});
    const bom={...file,bytes:new Uint8Array([239,187,191,...file.bytes])};
    expect((await parse(bom)).issues).toEqual([]);
    const rows=Papa.parse<string[]>(new TextDecoder().decode(file.bytes)).data;rows[1][12]='yes';
    expect((await parse(csv('nodes',rows.slice(1),rows[0]))).issues.some(i=>i.field==='relayCapable')).toBe(true);
  });
  it('未知、重复、缺列、重复 ID 与缺失引用均为整批错误',async()=>{
    const file=await resourceTemplate('csv','nodes'),rows=Papa.parse<string[]>(new TextDecoder().decode(file.bytes)).data;
    expect((await parse(csv('nodes',[rows[1],rows[1]],rows[0]))).issues.some(i=>i.field==='id'&&i.row===3)).toBe(true);
    expect((await parse(csv('nodes',[rows[1]],[...rows[0].slice(1),'unknown']))).issues.some(i=>i.field==='header')).toBe(true);
    rows[1][4]='missing-parent';expect((await parse(csv('nodes',[rows[1]],rows[0]))).issues.some(i=>i.field==='parentIds')).toBe(true);
  });
  it.each(['formula','date','rich','error','hidden-row','hidden-column','hidden-sheet','unknown-sheet'])('拒绝 XLSX %s',async type=>{
    const file=await editWorkbook(await resourceTemplate('xlsx'),book=>{
      const sheet=book.getWorksheet('nodes')!;
      if(type==='formula')sheet.getCell('B2').value={formula:'1+1',result:2};
      if(type==='date')sheet.getCell('B2').value=new Date();
      if(type==='rich')sheet.getCell('B2').value={richText:[{text:'名称'}]};
      if(type==='error')sheet.getCell('B2').value={error:'#VALUE!'};
      if(type==='hidden-row')sheet.getRow(2).hidden=true;
      if(type==='hidden-column')sheet.getColumn(2).hidden=true;
      if(type==='hidden-sheet')sheet.state='hidden';
      if(type==='unknown-sheet')sheet.name='unexpected';
    });
    const result=await parse(file).catch(e=>e);
    expect(result.issues?.length>0||!!result.code).toBe(true);
  });
  it('文件体积、行数、编码、旧格式均明确拒绝',async()=>{
    await expect(parse({name:'big.csv',mime:'',bytes:new Uint8Array(RESOURCE_MAX_FILE_BYTES+1)})).rejects.toMatchObject({code:'IMPORT_LIMIT'});
    await expect(parse(csv('nodes',Array.from({length:5001},()=>['id'])))).rejects.toMatchObject({code:'IMPORT_LIMIT'});
    await expect(parse({name:'bad.csv',mime:'',bytes:new Uint8Array([0xff])})).rejects.toMatchObject({code:'IMPORT_ENCODING'});
    await expect(parse({name:'old.xls',mime:'',bytes:new Uint8Array()})).rejects.toMatchObject({code:'IMPORT_FORMAT'});
  });
  it('危险文本可逆转义，XLSX 按文本写入；导出筛选补齐祖先且不截分页',async()=>{
    const data=structuredClone(source);data.stations[0].name='=1+1';data.stations[0].remark='~rp~原文';
    for(const format of ['csv','xlsx'] as const){
      const file=await exportResourceFile(data,{format,kinds:['nodes'],ids:{nodes:['ND-0001']}});
      const result=await parseResourceImport({file,kind:'nodes',context:'ledger',baseRevision:'initial'},data,source);
      expect(result.issues).toEqual([]);expect(result.rows[0].action).toBe('UNCHANGED');
      if(format==='csv')expect(new TextDecoder().decode(file.bytes)).toContain('~rp~');
    }
    const device=source.devices.find(d=>source.stations.find(s=>s.id===d.stationId)!.parentIds.length)!;
    const exported=selectResourceExport(source,{format:'xlsx',kinds:['nodes','devices'],ids:{nodes:[],devices:[device.id]}});
    expect(exported.added).toBeGreaterThan(1);expect(exported.tables[1].rows).toHaveLength(1);
    expect(exported.tables[0].rows.some(row=>row[0]===device.stationId)).toBe(true);
    expect(()=>selectResourceExport(source,{format:'csv',kinds:['devices'],ids:{devices:['unknown']}})).toThrow();
  });
});

describe('无变化导入的持久回执',()=>{
  it('初始空修改保留 initial 版本，重新创建服务也不能复用请求 ID 修改内容',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage);
    const preview=await service.previewResourceImport({file:await service.exportResources({format:'csv',kinds:['nodes'],ids:{nodes:['ND-0001']}}),kind:'nodes',baseRevision:'initial',context:'ledger'});
    const request={baseRevision:'initial',requestId:'noop-import',preview};
    const first=await service.commitResourceImport(request);
    expect(first.changed).toBe(false);expect(first.meta.revision).toBe('initial');expect(first.meta.savedAt).toBeNull();
    const restarted=createMockService(()=>storage),writes=storage.writes;
    expect((await restarted.loadPreview()).resourceMeta.revision).toBe('initial');
    expect((await restarted.commitResourceImport(request)).changed).toBe(false);expect(storage.writes).toBe(writes);
    const altered=structuredClone(request);altered.preview.request.file.name='different.csv';
    await expect(restarted.commitResourceImport(altered)).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
  });
});

// 候选文件独立验证原字段保真、引用和服务返回状态，不引入链路评估计算。
describe('GIS 候选拓扑专用文件',()=>{
  const parseCandidate=(file:ResourceFile,current=source,draftChanges?:import('../src/types/resource-edit').ResourceChanges)=>parseResourceImport({file,kind:'topology_links',baseRevision:'initial',context:'gis',draftChanges},current,source);
  const savedCandidate=(ids=source.candidateLinks!.map(row=>row.id))=>exportResourceFile(source,{format:'csv',kinds:['topology_links'],context:'gis',ids:{topology_links:ids}});
  const csvRows=(file:ResourceFile)=>Papa.parse<string[]>(new TextDecoder().decode(file.bytes)).data;

  it.each(['csv','xlsx'] as const)('%s 专用模板端点有效，空结果保持待评估',async format=>{
    const file=await resourceTemplate(format,'topology_links'),result=await parseCandidate(file);
    expect(result.issues).toEqual([]);expect(result.rows).toHaveLength(1);expect(result.rows[0]).toMatchObject({sheet:'topology_links',row:2,id:'NEW-LINK-01',action:'NEW'});
    expect(result.candidate.candidateLinks!.at(-1)).toMatchObject({assessmentState:'PENDING',distanceM:null,isAvailable:null,linkState:null,reference:null});
    if(format==='xlsx'){
      const book=new Excel.Workbook();await book.xlsx.load(new Uint8Array(file.bytes).buffer);
      expect(book.worksheets.map(sheet=>sheet.name)).toEqual(['topology_links','说明']);
      expect(book.getWorksheet('topology_links')!.getRow(1).values).toEqual([undefined,...resourceHeaders.topology_links]);
    }
    const original=new Excel.Workbook();await original.xlsx.load(new Uint8Array((await resourceTemplate('xlsx')).bytes).buffer);
    expect(original.worksheets.map(sheet=>sheet.name)).toEqual(['nodes','devices','interference_sources','说明']);
  });

  it('500 条原字段往返保真，来源疑点只提示且不修正外部结果',async()=>{
    const file=await savedCandidate(),result=await parseCandidate(file);
    expect(result.issues).toEqual([]);expect(result.rows).toHaveLength(500);
    expect(result.warnings!.some(issue=>issue.message.includes('FAULT'))).toBe(true);
    expect(result.warnings!.some(issue=>issue.message.includes('负值'))).toBe(true);
    const reexport=await exportResourceFile(result.candidate,{format:'csv',kinds:['topology_links'],context:'gis'});
    expect(csvRows(reexport)).toEqual(csvRows(file));
    expect(result.candidate.candidateLinks![0].source).toEqual({kind:'IMPORT',file:file.name,row:2});
    expect(result.candidate.candidateLinks!.every(row=>row.assessmentState==='REFERENCE')).toBe(true);
  });

  it('false、0 与部分空评估往返不混淆，筛选只导出指定记录',async()=>{
    const rows=csvRows(await savedCandidate([source.candidateLinks![0].id]));
    rows[1][8]='0';rows[1][9]='';rows[1][10]='0';rows[1][11]='0';rows[1][12]='false';rows[1][13]='';rows[1][14]='false';
    const file=csv('topology_links',[rows[1]]),result=await parseCandidate(file),row=result.candidate.candidateLinks![0];
    expect(result.issues).toEqual([]);
    expect(row).toMatchObject({distanceM:0,pathLossDb:null,rxPowerDbm:0,linkMarginDb:0,isAvailable:false,linkState:null,isBackup:false,assessmentState:'REFERENCE'});
    const selected=selectResourceExport(result.candidate,{format:'xlsx',kinds:['topology_links'],context:'gis',ids:{topology_links:[row.id]}});
    expect(selected.added).toBe(0);expect(selected.tables).toHaveLength(1);expect(selected.tables[0].rows).toHaveLength(1);
    const reexport=await exportResourceFile(result.candidate,{format:'csv',kinds:['topology_links'],context:'gis',ids:{topology_links:[row.id]}});
    expect(csvRows(reexport)[1]).toEqual(rows[1]);
    expect(()=>selectResourceExport(source,{format:'csv',kinds:['topology_links'],context:'gis',ids:{topology_links:['missing']}})).toThrow();
  });

  it('已导入的新配置及外部评估统一保存后保留，空评估导出再导入仍待评估',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage),rows=csvRows(await savedCandidate([source.candidateLinks![0].id]));
    rows[1][7]='1';rows[1][8]='0';rows[1][9]='';rows[1][10]='-80';rows[1][11]='0';rows[1][12]='false';rows[1][13]='WARNING';
    const imported=await service.previewResourceImport({file:csv('topology_links',[rows[1]]),kind:'topology_links',baseRevision:'initial',context:'gis'});
    expect(imported.issues).toEqual([]);
    const saved=await service.commitGisWorkspace({context:'gis',requestId:'candidate-import',baseResourceRevision:'initial',baseTaskRevision:'initial',changes:imported.changes,task:null});
    const current=(await service.loadPreview()).resources,record=current.candidateLinks![0];
    expect(record).toMatchObject({bandwidthKhz:1,distanceM:0,rxPowerDbm:-80,isAvailable:false,assessmentState:'REFERENCE'});
    expect(record.reference!.data.bandwidthKhz).toBe(1);expect(storage.writes).toBe(1);
    const pendingRows=csvRows(await exportResourceFile(current,{format:'csv',kinds:['topology_links'],context:'gis',ids:{topology_links:[record.id]}}));
    for(let i=8;i<=13;i++)pendingRows[1][i]='';
    const pending=await service.previewResourceImport({file:csv('topology_links',[pendingRows[1]]),kind:'topology_links',baseRevision:saved.meta.revision,context:'gis'});
    expect(pending.issues).toEqual([]);expect(pending.candidate.candidateLinks![0]).toMatchObject({assessmentState:'PENDING',reference:null,isAvailable:null});
    const exported=await exportResourceFile(pending.candidate,{format:'csv',kinds:['topology_links'],context:'gis',ids:{topology_links:[record.id]}});
    expect(csvRows(exported)[1].slice(8,14)).toEqual(['','','','','','']);
    const roundtrip=await parseCandidate(exported,pending.candidate);
    expect(roundtrip.issues).toEqual([]);expect(roundtrip.candidate.candidateLinks![0].assessmentState).toBe('PENDING');
  });

  it('候选与原三表文件不可混合，台账上下文拒绝候选',async()=>{
    const candidate=await resourceTemplate('xlsx','topology_links');
    await expect(parse(candidate,'topology_links')).rejects.toMatchObject({code:'IMPORT_FORMAT'});
    await expect(parse(candidate)).rejects.toMatchObject({code:'IMPORT_SHEET'});
    const mixed=await editWorkbook(candidate,book=>{book.addWorksheet('nodes').addRow(resourceHeaders.nodes);});
    await expect(parseCandidate(mixed)).rejects.toMatchObject({code:'IMPORT_SHEET'});
    await expect(parseCandidate(await resourceTemplate('xlsx'))).rejects.toMatchObject({code:'IMPORT_SHEET'});
    expect(()=>selectResourceExport(source,{format:'xlsx',kinds:['topology_links'],context:'ledger'})).toThrow();
    expect(()=>selectResourceExport(source,{format:'xlsx',kinds:['topology_links','nodes'],context:'gis'})).toThrow();
  });

  it.each([[1,'missing-node','nodeAId'],[3,'missing-device','deviceAId'],[5,'OTHER','deviceClass'],[6,'NaN','freqKhz'],[7,'0','bandwidthKhz'],[8,'Infinity','distanceM'],[12,'yes','isAvailable'],[13,'UNKNOWN','linkState']] as const)('第 2 行非法列 %s 明确阻断',async(column,value,field)=>{
    const rows=csvRows(await savedCandidate([source.candidateLinks![0].id]));rows[1][column]=value;
    const result=await parseCandidate(csv('topology_links',[rows[1]]));
    expect(result.issues).toContainEqual(expect.objectContaining({sheet:'topology_links',row:2,field}));
  });

  it('引用可来自已应用的同批草稿，重复编号和错误设备归属仍阻断',async()=>{
    const row=source.candidateLinks![0],node={...structuredClone(source.stations.find(item=>item.id===row.nodeAId)!),id:'DRAFT-NODE',origin:'MANUAL' as const},device={...structuredClone(source.devices.find(item=>item.id===row.deviceAId)!),id:'DRAFT-DEVICE',stationId:node.id,origin:'MANUAL' as const};
    const rows=csvRows(await savedCandidate([row.id]));rows[1][0]='DRAFT-LINK';rows[1][1]=node.id;rows[1][3]=device.id;
    for(let i=8;i<=13;i++)rows[1][i]='';
    const file=csv('topology_links',[rows[1]]);
    expect((await parseCandidate(file)).issues.some(issue=>issue.field==='nodeAId')).toBe(true);
    const draft={stations:[],devices:[],newStations:[node],newDevices:[device]},valid=await parseCandidate(file,source,draft);
    expect(valid.issues).toEqual([]);expect(valid.candidate.candidateLinks).toHaveLength(501);
    expect((await parseCandidate(csv('topology_links',[rows[1],rows[1]]),source,draft)).issues).toContainEqual(expect.objectContaining({row:3,field:'id'}));
    rows[1][3]=row.deviceAId;
    expect((await parseCandidate(csv('topology_links',[rows[1]]),source,draft)).issues).toContainEqual(expect.objectContaining({row:2,field:'deviceAId'}));
  });

  it('候选 XLSX 同样拒绝公式与隐藏数据',async()=>{
    const template=await resourceTemplate('xlsx','topology_links');
    for(const edit of [(sheet:Excel.Worksheet)=>{sheet.getCell('G2').value={formula:'1+1',result:2};},(sheet:Excel.Worksheet)=>{sheet.getRow(2).hidden=true;}]){
      const result=await parseCandidate(await editWorkbook(template,book=>edit(book.getWorksheet('topology_links')!))).catch(error=>error);
      expect(result.issues?.some((issue:{sheet:string;row:number})=>issue.sheet==='topology_links'&&issue.row===2)||result.code==='IMPORT_LIMIT').toBe(true);
    }
  });
});

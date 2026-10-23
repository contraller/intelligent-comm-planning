import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';
import { completeResources,initialResources } from '../src/mocks/resource-presets';
import { candidateAssessmentFields,candidateData,emptyCandidateAssessment,externalCandidateLink,validateCandidateLinks } from '../src/services/candidate-link';
import { applyChanges,createForm,createNewForm,diffResources,formChanges,resourceResultsChanged } from '../src/services/resource-validation';
import { createMockService } from '../src/services/mock';
import type { CandidateLinkData } from '../src/types/candidate-link';
import { TestStorage } from './helpers/storage';

const csvSource='docs/数据接口样例/04_联调数据/synthetic/topology/topology_links_v1.csv';
const fileSource={kind:'IMPORT' as const,file:'candidates.csv',row:2};
describe('候选拓扑的原资料与服务边界',()=>{
  it('500 行、15 字段及来源行号逐项保真，保留同站点不同设备及原值疑点',()=>{
    const rows=readFileSync(csvSource,'utf8').replace(/^\uFEFF/,'').trimEnd().split(/\r?\n/).slice(1).map(line=>line.split(','));
    const links=initialResources().candidateLinks!;
    expect(links).toHaveLength(500);expect(new Set(links.map(row=>row.id)).size).toBe(500);
    const fields=['id','nodeAId','nodeBId','deviceAId','deviceBId','deviceClass','freqKhz','bandwidthKhz','distanceM','pathLossDb','rxPowerDbm','linkMarginDb','isAvailable','linkState','isBackup'] as const;
    rows.forEach((cells,index)=>{
      const row=links[index];
      fields.forEach((field,column)=>expect(typeof row[field]==='number'?row[field]:String(row[field]),`${index+2}:${field}`).toBe(typeof row[field]==='number'?Number(cells[column]):cells[column]));
      expect(row.source).toEqual({kind:'SOURCE',file:csvSource,row:index+2});expect(row.reference?.data).toEqual(candidateData(row));expect(row.assessmentState).toBe('REFERENCE');
    });
    expect(new Set(links.map(row=>[row.nodeAId,row.nodeBId].sort().join(':'))).size).toBe(483);
    expect(links.filter(row=>row.linkState==='FAULT'&&row.isAvailable)).toHaveLength(9);
    expect(links.filter(row=>row.pathLossDb!<0)).toHaveLength(3);
    expect(validateCandidateLinks(links,initialResources()).issues).toEqual([]);
  });
  it('通用补充不为缺失的 HTTP 候选注入 Mock，显式空集合保持',()=>{
    const data=initialResources();delete data.candidateLinks;
    expect(completeResources(data).candidateLinks).toBeUndefined();
    expect(completeResources({...data,candidateLinks:[]}).candidateLinks).toEqual([]);
  });
  it('候选差异不依赖对象键顺序，保留未知字段、undefined 和非有限数含义',()=>{
    const base=initialResources(),draft=structuredClone(base),row=draft.candidateLinks![0];
    row.reference={source:{row:row.source.row,file:row.source.file,kind:row.source.kind},data:Object.fromEntries(Object.entries(row.reference!.data).reverse()) as unknown as CandidateLinkData};
    Object.assign(row,{unknown:undefined});expect(diffResources(base,draft).importedCandidateLinks).toBeUndefined();
    Object.assign(row,{unknown:0});expect(diffResources(base,draft).importedCandidateLinks).toHaveLength(1);
    const invalid=structuredClone(base);invalid.candidateLinks![0].distanceM=NaN;
    expect(diffResources(base,invalid).importedCandidateLinks).toHaveLength(1);
    const again=structuredClone(invalid);expect(diffResources(invalid,again).importedCandidateLinks).toBeUndefined();
    again.candidateLinks![0].distanceM=null;expect(diffResources(invalid,again).importedCandidateLinks).toHaveLength(1);
  });
  it('手工配置只进入草稿；共用 apply 保留评估值，服务保存才返回待评估并保存参考输入',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage),before=await service.loadPreview();
    const old=before.resources.candidateLinks![0],form=createForm(before.resources,'candidate',old.id);
    form.fields.bandwidthKhz='9';const changes=formChanges(form),draft=applyChanges(before.resources,changes);
    expect(draft.candidateLinks![0]).toMatchObject({assessmentState:'REFERENCE',distanceM:old.distanceM,bandwidthKhz:9});
    expect(draft.candidateLinks![0].reference).toEqual(old.reference);expect(resourceResultsChanged(changes)).toBe(false);
    const result=await service.commitResources({baseRevision:'initial',context:'gis',...changes});
    const row=result.resources.candidateLinks![0];expect(row.assessmentState).toBe('PENDING');
    for(const field of candidateAssessmentFields)expect(row[field]).toBeNull();
    expect(row.reference).toEqual(old.reference);expect(row.reference?.data.bandwidthKhz).toBe(old.bandwidthKhz);
    const back=await service.commitResources({baseRevision:result.meta.revision,stations:[],devices:[],candidateLinks:[{id:old.id,bandwidthKhz:old.bandwidthKhz}]});
    expect(back.resources.candidateLinks![0].assessmentState).toBe('PENDING');
    expect(back.resources.candidateLinks![0].reference).toEqual(old.reference);
  });
  it('新表单待评估、配置可空，不能通过表单或配置补丁伪造结果',()=>{
    const resources=initialResources(),old=resources.candidateLinks![0],form=createNewForm('candidate',resources);
    Object.assign(form.fields,{nodeAId:old.nodeAId,nodeBId:old.nodeBId,deviceAId:old.deviceAId,deviceBId:old.deviceBId,deviceClass:old.deviceClass});
    const changes=formChanges(form),row=applyChanges(resources,changes).candidateLinks!.at(-1)!;
    expect(row).toMatchObject({assessmentState:'PENDING',freqKhz:null,bandwidthKhz:null,isBackup:null,reference:null});
    expect(validateCandidateLinks([row],resources).issues).toEqual([]);
    form.fields.distanceM='1';expect(()=>formChanges(form)).toThrow('只读字段');
    expect(()=>applyChanges(resources,{stations:[],devices:[],candidateLinks:[{id:old.id,distanceM:1} as never]})).toThrow('只读');
  });
  it('修改备用标识不假装评估；只更新事务版本，既有网络及业务依赖保持',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage),before=await service.loadPreview(),old=before.resources.candidateLinks![0];
    const request={baseRevision:'initial',requestId:'candidate-save',context:'gis' as const,stations:[],devices:[],candidateLinks:[{id:old.id,isBackup:true}]};
    const saved=await service.commitResources(request),row=saved.resources.candidateLinks![0];
    expect(row.assessmentState).toBe('REFERENCE');expect(row.distanceM).toBe(old.distanceM);
    expect(saved.meta.revision).not.toBe(before.resourceMeta.revision);expect(saved.meta.savedAt).not.toBeNull();
    for(const field of ['resourceEpoch','stationVersions','deviceVersions','interferenceVersion','changedStationIds','changedDeviceIds','changedInterferenceIds','taskWorkspace'] as const)expect(saved.meta[field]).toEqual(before.resourceMeta[field]);
    const after=await service.loadPreview();expect(after.situation).toEqual(before.situation);expect(after.planning).toEqual(before.planning);
    await service.commitResources(request);expect(storage.writes).toBe(1);
    await expect(service.commitResources({...request,requestId:'other'})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  });
  it('新导入评估经过 diff 与统一保存仍保留，之后手工再改配置才待评估',async()=>{
    const storage=new TestStorage(),stable=createMockService(()=>storage),before=await stable.loadPreview(),old=before.resources.candidateLinks![0];
    const imported=externalCandidateLink({...candidateData(old),bandwidthKhz:9,distanceM:0,isAvailable:false,rxPowerDbm:null},fileSource);
    const draft=structuredClone(before.resources);draft.candidateLinks![0]=imported;
    const changes=diffResources(before.resources,draft);expect(changes.importedCandidateLinks).toEqual([imported]);
    expect(applyChanges(before.resources,changes)).toEqual(draft);
    const saved=await stable.commitResources({baseRevision:'initial',...changes});expect(saved.resources.candidateLinks![0]).toEqual(imported);
    const pending=await stable.commitResources({baseRevision:saved.meta.revision,stations:[],devices:[],candidateLinks:[{id:old.id,bandwidthKhz:7}]});
    expect(pending.resources.candidateLinks![0]).toMatchObject({assessmentState:'PENDING',distanceM:null,reference:{data:{bandwidthKhz:9,distanceM:0,isAvailable:false,rxPowerDbm:null}}});
    // 仅有空评估的文件仍待评估，不因来源改为 IMPORT 而升级。
    const empty=externalCandidateLink({...candidateData(old),...emptyCandidateAssessment()},fileSource);
    expect(empty).toMatchObject({assessmentState:'PENDING',reference:null});
  });
  it('导入后未保存的手工再次改配置不继续展示导入评估为当前值',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage),before=await service.loadPreview(),old=before.resources.candidateLinks![0];
    const imported=externalCandidateLink({...candidateData(old),bandwidthKhz:9},fileSource);imported.bandwidthKhz=7;
    const saved=await service.commitResources({baseRevision:'initial',stations:[],devices:[],importedCandidateLinks:[imported]});
    expect(saved.resources.candidateLinks![0]).toMatchObject({assessmentState:'PENDING',bandwidthKhz:7,distanceM:null,reference:{data:{bandwidthKhz:9}}});
  });
  it('导入后手工改回保存前配置仍清空新参考的当前值，新建导入同样处理',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage),before=await service.loadPreview(),old=before.resources.candidateLinks![0];
    const imported=externalCandidateLink({...candidateData(old),bandwidthKhz:9},fileSource);imported.bandwidthKhz=old.bandwidthKhz;
    const added=externalCandidateLink({...candidateData(old),id:'IMPORTED-NEW',bandwidthKhz:9},fileSource);added.bandwidthKhz=7;
    const saved=await service.commitResources({baseRevision:'initial',stations:[],devices:[],importedCandidateLinks:[imported],newCandidateLinks:[added]});
    expect(saved.resources.candidateLinks![0]).toMatchObject({assessmentState:'PENDING',distanceM:null});
    expect(saved.resources.candidateLinks!.at(-1)).toMatchObject({assessmentState:'PENDING',distanceM:null,reference:{data:{bandwidthKhz:9}}});
  });
  it.each(['nodeAId','deviceAId','deviceClass','freqKhz','bandwidthKhz','isBackup','isAvailable','linkState'] as const)('拒绝无效字段 %s 并定位候选',field=>{
    const resources=initialResources(),row=structuredClone(resources.candidateLinks![0]);
    Object.assign(row,{[field]:field==='freqKhz'||field==='bandwidthKhz'?-1:'invalid'});
    expect(validateCandidateLinks([row],resources).issues).toContainEqual(expect.objectContaining({sheet:'topology_links',objectId:row.id,field}));
  });
  it('手工候选评估不可伪造，引用归属错误和重复 ID 阻断，不按站点对合并',()=>{
    const resources=initialResources(),row=structuredClone(resources.candidateLinks![0]);
    row.deviceAId=row.deviceBId;expect(validateCandidateLinks([row],resources).issues.some(issue=>issue.field==='deviceAId')).toBe(true);
    expect(validateCandidateLinks([resources.candidateLinks![0],resources.candidateLinks![0]],resources).issues.some(issue=>issue.field==='id')).toBe(true);
    row.source={kind:'MANUAL',file:null,row:null};expect(validateCandidateLinks([row],resources).issues.some(issue=>issue.field==='source')).toBe(true);
    expect(validateCandidateLinks([],resources,[resources.candidateLinks![0]]).issues.some(issue=>issue.field==='id')).toBe(true);
  });
  it('站点设备修改由保存服务返回参考未重新评估提示；保留原结果',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage),before=await service.loadPreview(),old=before.resources.candidateLinks![0];
    const saved=await service.commitResources({baseRevision:'initial',stations:[{id:old.nodeAId,name:'关联节点新名称'}],devices:[]});
    expect(saved.resources.candidateLinks![0].notices).toContain('关联站点或设备资料已变化；外部参考未获重新评估。');
    expect(saved.resources.candidateLinks![0].reference).toEqual(old.reference);expect(saved.meta.changedStationIds).toContain(old.nodeAId);
  });
  it('台账提交候选被服务拒绝，写入失败保持原字节和重试输入',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage),before=await service.loadPreview(),old=before.resources.candidateLinks![0];
    const changes={stations:[],devices:[],candidateLinks:[{id:old.id,isBackup:true}]};
    await expect(service.commitResources({baseRevision:'initial',context:'ledger',...changes})).rejects.toMatchObject({code:'VALIDATION_ERROR'});expect(storage.writes).toBe(0);
    storage.failWrite=true;await expect(service.commitResources({baseRevision:'initial',context:'gis',...changes})).rejects.toMatchObject({code:'STORAGE_WRITE_FAILED'});expect(storage.writes).toBe(0);
    storage.failWrite=false;expect((await service.commitResources({baseRevision:'initial',context:'gis',...changes})).changed).toBe(true);
  });
});

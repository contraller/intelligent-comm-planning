import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { useResourceReadStore } from '../src/stores/resource-read';
import { savedRequest,taskMeta } from './helpers/tasks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createMockService } from '../src/services/mock';
import { createPlanningMock } from '../src/services/planning-mock';
import { initialResources } from '../src/mocks/resource-presets';
import { planningPresets } from '../src/mocks/planning-presets';
import { matchPreset, validatePlanningInput } from '../src/services/planning-validation';
import { initialMeta } from '../src/services/resource-storage';
import { TestStorage } from './helpers/storage';
import { authorizeStore } from './helpers/auth';
import { previewService } from '../src/services';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceEditStore } from '../src/stores/resource-edit';

afterEach(()=>vi.restoreAllMocks());
async function editorFixture(){
  setActivePinia(createPinia());authorizeStore();
  const storage=new TestStorage(),service=createMockService(()=>storage);
  // GIS 只预检并应用草稿，台账即时导入另由独立维护测试覆盖。
  for(const name of ['loadPreview','commitResources','previewResourceImport','getResourceTemplate','loadResourceReadContext','queryResourceMap','getResourceObject','loadGisResourceEditContext','loadGisResourceScene'] as const)
    vi.spyOn(previewService,name).mockImplementation(service[name].bind(service) as never);
  const preview=usePreviewStore();await preview.load();const editor=useResourceEditStore();
  await useResourceReadStore().activate('gis');
  editor.acceptGisContext(await service.loadGisResourceEditContext({context:'gis',revision:useResourceReadStore().workspace!.revision}));
  return {storage,service,preview,editor};
}
describe('资源导入与上下游联动',()=>{
  it('候选导入一步草稿可撤销，保存响应保留导入数据及状态且原业务依赖不变',async()=>{
    const {editor,service,preview,storage}=await editorFixture();const before=JSON.parse(JSON.stringify(preview.data!.resourceMeta)),count=editor.resources.candidateLinks!.length;
    await editor.openImport();editor.importKind='topology_links';await editor.previewImport(await service.getResourceTemplate('csv','topology_links'));
    expect(editor.importPreview!.issues).toEqual([]);expect(await editor.confirmImport(),editor.error).toBe(true);
    expect(editor.undoStack).toHaveLength(1);expect(storage.writes).toBe(0);expect(editor.resources.candidateLinks!.length).toBe(count+1);
    await editor.moveHistory('undo');expect(editor.resources.candidateLinks).toHaveLength(count);
    await editor.moveHistory('redo');const imported=JSON.parse(JSON.stringify(editor.resources.candidateLinks!.at(-1)));
    expect(await editor.save(),editor.error).toBe(true);expect(storage.writes).toBe(1);expect(preview.data!.resources.candidateLinks!.at(-1)).toEqual(imported);
    for(const field of ['resourceEpoch','stationVersions','deviceVersions','interferenceVersion','changedStationIds','changedDeviceIds'] as const)expect(preview.data!.resourceMeta[field]).toEqual(before[field]);
  });
  it('GIS XLSX 整批应用为一步撤销；统一保存后刷新与台账一致',async()=>{
    const {editor,service,preview,storage}=await editorFixture();await editor.openImport();
    await editor.previewImport(await service.getResourceTemplate('xlsx'));
    expect(editor.importPreview!.issues).toEqual([]);expect(await editor.confirmImport(),editor.error).toBe(true);
    expect(editor.undoStack).toHaveLength(1);expect(storage.writes).toBe(0);
    expect(editor.resources.stations).toHaveLength(133);
    await editor.moveHistory('undo');expect(editor.resources.stations).toHaveLength(132);
    await editor.moveHistory('redo');expect(editor.resources.stations.at(-1)?.id).toBe('NEW-STATION-01');
    expect(await editor.save(),editor.error).toBe(true);expect(storage.writes).toBe(1);
    expect((await service.loadPreview()).resources).toEqual(preview.data!.resources);
  });
  it('预检后 GIS 草稿或资源版本变化必须重新预检',async()=>{
    const {editor,service,preview}=await editorFixture();await editor.openImport();
    const file=await service.getResourceTemplate('xlsx');await editor.previewImport(file);
    editor.draft!.stations[0].name='后续草稿';expect(await editor.confirmImport()).toBe(false);expect(editor.error).toContain('重新预检');
    await editor.previewImport(file);
    preview.acceptResources(await service.commitResources({baseRevision:'initial',stations:[{id:'ND-0002',name:'另一处保存'}],devices:[]}));await useResourceReadStore().refresh();
    expect(await editor.confirmImport()).toBe(false);expect(editor.resources.stations).toHaveLength(132);
  });
  it('服务拒绝过期导入，不能靠重写预检基线覆盖新资源',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage);
    const preview=await service.previewResourceImport({file:await service.getResourceTemplate('xlsx'),kind:'nodes',context:'ledger',baseRevision:'initial'});
    await service.commitResources({baseRevision:'initial',stations:[{id:'ND-0001',name:'较新名称'}],devices:[]});
    await expect(service.commitResourceImport({baseRevision:'initial',requestId:'stale',preview})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    expect((await service.loadPreview()).resources.stations).toHaveLength(132);
  });
  it('空站点不可提交；选中节点增加设备或干扰配置变化均不套用旧预设',()=>{
    const initial=initialResources(),preset=planningPresets[0],resources=structuredClone(initial);
    const newStation={...resources.stations[0],id:'empty',origin:'MANUAL' as const};resources.stations.push(newStation);
    expect(validatePlanningInput({...preset.input,stationIds:[...preset.input.stationIds,'empty']},resources)).toContainEqual(expect.objectContaining({objectId:'empty',field:'stationIds'}));
    const device=resources.devices.find(d=>preset.input.stationIds.includes(d.stationId))!;
    resources.devices.push({...device,id:'extra',txPowerDbm:40,origin:'MANUAL'});
    expect(()=>matchPreset(preset.input,resources,planningPresets)).toThrow('暂无预生成');
    const interferenceChanged=structuredClone(initial);interferenceChanged.interferences![0].active=!interferenceChanged.interferences![0].active;
    expect(()=>matchPreset(preset.input,interferenceChanged,planningPresets)).toThrow('暂无预生成');
  });
  it('下架明确预设引用设备拒绝新规划；恢复后可新规划但不清旧依赖版本',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage),preset=planningPresets[0],device=preset.baseline.devices[0];
    const down=await service.setDeviceAvailability({baseRevision:'initial',requestId:'down',ids:[device.id],availability:'OFF_SHELF'});
    expect(()=>matchPreset(preset.input,down.resources,planningPresets)).toThrow('下架');
    const restored=await service.setDeviceAvailability({baseRevision:down.meta.revision,requestId:'restore',ids:[device.id],availability:'ACTIVE'});
    expect(matchPreset(preset.input,restored.resources,planningPresets).id).toBe(preset.id);
    expect(restored.meta.changedDeviceIds).toContain(device.id);
  });
  it('任务运行中新增关联设备仍按冻结输入完成，结果仅可保存为参考',async()=>{
    const storage=new TestStorage(),resourceService=createMockService(()=>storage);
    let current={resources:initialResources(),meta:initialMeta()},time=1000;
    const planning=createPlanningMock(()=>storage,()=>({...current,meta:{...current.meta,taskWorkspace:taskMeta(storage)}}),()=>time),preset=planningPresets[0];
    const task=await planning.submitPlanning(await savedRequest(storage,{baseRevision:'initial',requestId:'p',taskId:null,parentPlanVersionId:null,input:structuredClone(preset.input)}));
    const frozen=structuredClone(task.view.job.inputSnapshot),device=current.resources.devices.find(d=>preset.input.stationIds.includes(d.stationId))!;
    // 新增测试设备不继承原实例的端口清单，仍验证原有冻结输入行为。
    current=await resourceService.commitResources({baseRevision:'initial',stations:[],devices:[],newDevices:[{...device,ports:undefined,id:'extra',origin:'MANUAL',txPowerDbm:40}]});
    time+=10000;const view=await planning.getPlanningJob(task.view.job.id);
    expect(view.state).toBe('SUCCESS');expect(view.result!.inputSnapshot).toEqual(frozen);
    const saved=await planning.savePlanVersion({baseRevision:task.workspace.revision,requestId:'save',jobId:task.view.job.id,name:'历史参考',note:''});
    expect(saved.plan.state).toBe('REFERENCE');expect(saved.plan.sourceChanged).toBe(true);
  });
});

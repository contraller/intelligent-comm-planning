import { describe, expect, it } from 'vitest';
import { createMockService } from '../src/services/mock';
import { RESOURCE_STORAGE_KEY } from '../src/config/demo';
import { TestStorage } from './helpers/storage';
import { planningPresets } from '../src/mocks/planning-presets';

function setup() {
  const storage = new TestStorage();
  return { storage, service: createMockService(() => storage) };
}

describe('资源持久化与恢复', () => {
  // 旧格式读取和提交都拒绝，原记录保持不变。
  it.each([1,2,3,4,5])('schema %s 明确拒绝且不迁移写回',async(schemaVersion)=>{
    const {service,storage}=setup();await service.commitResources({baseRevision:'initial',stations:[{id:'ND-0001',name:'旧保存'}],devices:[]});
    const record=JSON.parse(storage.getItem(RESOURCE_STORAGE_KEY)!);record.schemaVersion=schemaVersion;delete record.candidateLinks;
    const raw=JSON.stringify(record);storage.entries.set(RESOURCE_STORAGE_KEY,raw);const writes=storage.writes;
    await expect(service.loadPreview()).rejects.toMatchObject({code:'STORAGE_INCOMPATIBLE'});
    await expect(service.commitResources({baseRevision:record.revision,stations:[],devices:[]})).rejects.toMatchObject({code:'STORAGE_INCOMPATIBLE'});
    expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(raw);expect(storage.writes).toBe(writes);
  });
  it('当前格式的任务与回执保留，资源保存不改变任务库',async()=>{
    const {service,storage}=setup();
    await service.saveTask({baseResourceRevision:'initial',baseTaskRevision:'initial',requestId:'saved-task',taskId:'T',input:structuredClone(planningPresets[0].input)});
    const original=JSON.parse(storage.getItem(RESOURCE_STORAGE_KEY)!);expect(original.schemaVersion).toBe(6);
    const current=await service.loadPreview();expect(current.resourceMeta.revision).toBe('initial');expect(current.resourceMeta.taskWorkspace?.receipts).toHaveLength(1);
    const saved=await service.commitResources({baseRevision:'initial',stations:[],devices:[],candidateLinks:[{id:'LK-0001',isBackup:true}]});
    expect(saved.meta.taskWorkspace).toEqual(original.taskWorkspace);
  });
  it('当前格式缺失候选为损坏，合法空集合保持，损坏原记录不覆盖',async()=>{
    const {service,storage}=setup();await service.resetResources(null);const base=JSON.parse(storage.getItem(RESOURCE_STORAGE_KEY)!);
    const empty={...base,candidateLinks:[]};storage.entries.set(RESOURCE_STORAGE_KEY,JSON.stringify(empty));expect((await service.loadPreview()).resources.candidateLinks).toEqual([]);
    for(const damage of [(r:any)=>{delete r.candidateLinks;},(r:any)=>{r.candidateLinks[0].distanceM='invalid';},(r:any)=>{r.candidateLinks[0].reference=null;},(r:any)=>{r.candidateLinks[0].source=null;}]){
      const record=structuredClone(base);damage(record);const raw=JSON.stringify(record);storage.entries.set(RESOURCE_STORAGE_KEY,raw);
      await expect(service.loadPreview()).rejects.toMatchObject({code:'STORAGE_CORRUPT'});expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(raw);
    }
    expect(storage.writes).toBe(1);
  });
  it('候选重置恢复 500 来源，保留独立任务及失败时原字节',async()=>{
    const {service,storage}=setup();const tasks=await service.saveTask({baseResourceRevision:'initial',baseTaskRevision:'initial',requestId:'t',taskId:'T',input:structuredClone(planningPresets[0].input)});
    const saved=await service.commitResources({baseRevision:'initial',stations:[],devices:[],candidateLinks:[{id:'LK-0001',bandwidthKhz:9}]});
    const raw=storage.getItem(RESOURCE_STORAGE_KEY);storage.failWrite=true;await expect(service.resetResources(saved.meta.revision)).rejects.toMatchObject({code:'STORAGE_WRITE_FAILED'});expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(raw);
    storage.failWrite=false;const reset=await service.resetResources(saved.meta.revision);
    expect(reset.resources.candidateLinks).toHaveLength(500);expect(reset.resources.candidateLinks![0]).toMatchObject({assessmentState:'REFERENCE',bandwidthKhz:3,source:{kind:'SOURCE'}});expect(reset.meta.taskWorkspace).toEqual(tasks.tasks);
  });
  it('当前格式缺少对象版本时拒绝，不从保存版本推导', async () => {
    const {service,storage}=setup();
    await service.commitResources({baseRevision:'initial',stations:[{id:'ND-0001',name:'保存名称'}],devices:[]});
    const record=JSON.parse(storage.getItem(RESOURCE_STORAGE_KEY)!);delete record.stationVersions;
    const bytes=JSON.stringify(record);storage.entries.set(RESOURCE_STORAGE_KEY,bytes);const writes=storage.writes;
    await expect(service.loadPreview()).rejects.toMatchObject({code:'STORAGE_CORRUPT'});
    expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(bytes);expect(storage.writes).toBe(writes);
  });
  it('逐对象版本仅变化对象更新；无变化不升版，重置更换资源基线', async () => {
    const { service } = setup();
    const a = await service.commitResources({
      baseRevision: 'initial',
      stations: [{ id: 'ND-0001', name: 'A' }],
      devices: [],
    });
    const b = await service.commitResources({
      baseRevision: a.meta.revision,
      stations: [{ id: 'ND-0003', name: 'B' }],
      devices: [],
    });
    expect(b.meta.stationVersions['ND-0001']).toBe(a.meta.revision);
    expect(b.meta.stationVersions['ND-0003']).toBe(b.meta.revision);
    const noChange = await service.commitResources({
      baseRevision: b.meta.revision,
      stations: [],
      devices: [],
    });
    expect(noChange.meta).toEqual(b.meta);
    const reset = await service.resetResources(b.meta.revision);
    expect(reset.meta.resourceEpoch).not.toBe(b.meta.resourceEpoch);
    expect(reset.meta.stationVersions).toEqual({});
  });
  it('加载初始资源不写入；单记录提交后新服务实例恢复相同状态', async () => {
    const { service, storage } = setup();
    const before = await service.loadPreview();
    expect(storage.writes).toBe(0);
    const saved = await service.commitResources({
      baseRevision: before.resourceMeta.revision,
      stations: [{ id: 'ND-0001', name: ' 已保存名称 ' }],
      devices: [],
    });
    expect(storage.writes).toBe(1);
    const loaded = await createMockService(() => storage).loadPreview();
    expect(loaded.resources).toEqual(saved.resources);
    expect(loaded.resourceMeta).toEqual(saved.meta);
    expect(loaded.resources.stations[0].name).toBe('已保存名称');
    const record = JSON.parse(storage.getItem(RESOURCE_STORAGE_KEY)!);
    expect(Object.keys(record).sort()).toEqual(
      [
        'deviceHistory','taskWorkspace','interferenceVersion','changedInterferenceIds','receipts','interferences','candidateLinks',
        'revision',
        'resourceEpoch',
        'stationVersions',
        'deviceVersions',
        'savedAt',
        'changedStationIds',
        'changedDeviceIds',
        'schemaVersion',
        'sourceVersion',
        'stations',
        'devices',
      ].sort(),
    );
    expect(record.models).toBeUndefined();
    expect(record.planning).toBeUndefined();
  });
  it('无变化不写入，也不提升版本', async () => {
    const { service, storage } = setup();
    const before = await service.loadPreview();
    const result = await service.commitResources({
      baseRevision: 'initial',
      stations: [{ id: 'ND-0001', name: before.resources.stations[0].name }],
      devices: [],
    });
    expect(result.changed).toBe(false);
    expect(result.meta).toEqual(before.resourceMeta);
    expect(storage.writes).toBe(0);
  });
  it('存储拒绝/配额耗尽保持上次成功记录和版本', async () => {
    const { service, storage } = setup();
    const saved = await service.commitResources({
      baseRevision: 'initial',
      stations: [{ id: 'ND-0001', name: '第一次' }],
      devices: [],
    });
    const text = storage.getItem(RESOURCE_STORAGE_KEY);
    storage.failWrite = true;
    await expect(
      service.commitResources({
        baseRevision: saved.meta.revision,
        stations: [{ id: 'ND-0001', name: '第二次' }],
        devices: [],
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_WRITE_FAILED' });
    expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(text);
    expect((await service.loadPreview()).resourceMeta.revision).toBe(saved.meta.revision);
  });
  it('拒绝读取不回退初始数据', async () => {
    const { service, storage } = setup();
    storage.failRead = true;
    await expect(service.loadPreview()).rejects.toMatchObject({ code: 'STORAGE_READ_FAILED' });
    expect(storage.writes).toBe(0);
  });
  it.each(['not json', 'null', '{"schemaVersion":1,"sourceVersion":"preview-v0.1"}'])(
    '损坏记录不会静默覆盖：%s',
    async (text) => {
      const { service, storage } = setup();
      storage.entries.set(RESOURCE_STORAGE_KEY, text);
      await expect(service.loadPreview()).rejects.toBeInstanceOf(Error);
      expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(text);
      expect(storage.writes).toBe(0);
    },
  );
  it.each(['schemaVersion', 'sourceVersion'])('版本不兼容拒绝加载：%s', async (field) => {
    const { service, storage } = setup();
    await service.resetResources(null);
    const record = JSON.parse(storage.getItem(RESOURCE_STORAGE_KEY)!);
    record[field] = 'unsupported';
    storage.entries.set(RESOURCE_STORAGE_KEY, JSON.stringify(record));
    await expect(service.loadPreview()).rejects.toMatchObject({ code: 'STORAGE_INCOMPATIBLE' });
    expect(storage.writes).toBe(1);
  });
  it.each(['association', 'markers', 'missing-resource', 'nan', 'extra-power'])(
    '拒绝结构/关联/数值损坏：%s',
    async (corruption) => {
      const { service, storage } = setup();
      await service.resetResources(null);
      const record = JSON.parse(storage.getItem(RESOURCE_STORAGE_KEY)!);
      if (corruption === 'association') record.devices[0].stationId = 'ND-NONE';
      if (corruption === 'markers') record.stations[0].name = '缺少变更标记';
      if (corruption === 'missing-resource') record.devices.pop();
      if (corruption === 'nan') record.stations[0].coordinate[0] = 'NaN';
      if (corruption === 'extra-power') record.devices[0].txPowerDbm = 51.79;
      storage.entries.set(RESOURCE_STORAGE_KEY, JSON.stringify(record));
      await expect(service.loadPreview()).rejects.toMatchObject({ code: 'STORAGE_CORRUPT' });
      expect(storage.writes).toBe(1);
    },
  );
  it('旧基线提交和重置都拒绝覆盖其他保存', async () => {
    const { service, storage } = setup();
    const result = await service.commitResources({
      baseRevision: 'initial',
      stations: [],
      devices: [{ id: 'DV-0001', antennaHeightM: 12 }],
    });
    const other = createMockService(() => storage);
    await expect(
      other.commitResources({
        baseRevision: 'initial',
        stations: [{ id: 'ND-0001', name: '旧表单' }],
        devices: [],
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(other.resetResources('initial')).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    expect((await other.loadPreview()).resourceMeta).toEqual(result.meta);
    expect(storage.writes).toBe(1);
  });
  it('共享记录损坏时拒绝重置，保留原记录和其他工作区',async()=>{
    const {service,storage}=setup();storage.entries.set('another-app','keep');storage.entries.set(RESOURCE_STORAGE_KEY,'corrupt');
    await expect(service.resetResources(null)).rejects.toMatchObject({code:'STORAGE_CORRUPT'});
    expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe('corrupt');expect(storage.getItem('another-app')).toBe('keep');expect(storage.writes).toBe(0);
  });
  it('重置写入失败保留旧记录', async () => {
    const { service, storage } = setup();
    await service.commitResources({baseRevision:'initial',stations:[{id:'ND-0001',name:'保留资源'}],devices:[]});
    const raw=storage.getItem(RESOURCE_STORAGE_KEY);
    storage.failWrite = true;
    await expect(service.resetResources(null)).rejects.toMatchObject({
      code: 'STORAGE_WRITE_FAILED',
    });
    expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(raw);
  });
  it('已加载页面拒绝重置后来损坏的共享记录；读权限拒绝仍失败', async () => {
    const { service, storage } = setup();
    await service.loadPreview();
    storage.entries.set(RESOURCE_STORAGE_KEY, 'corrupt');
    await expect(service.resetResources('initial')).rejects.toMatchObject({code:'STORAGE_CORRUPT'});
    storage.failRead = true;
    await expect(service.resetResources('initial')).rejects.toMatchObject({
      code: 'STORAGE_READ_FAILED',
    });
  });
});

// 当前缺字段也不能从初始资料补齐。
describe('资源当前结构边界',()=>{
  it('当前记录缺资源来源字段时明确失败，原字节保留',async()=>{
    const {storage,service}=setup();
    await service.commitResources({baseRevision:'initial',stations:[{id:'ND-0001',name:'保存名称'}],devices:[]});
    const record=JSON.parse(storage.getItem(RESOURCE_STORAGE_KEY)!);delete record.stations[0].origin;delete record.devices[0].availability;
    const raw=JSON.stringify(record);storage.entries.set(RESOURCE_STORAGE_KEY,raw);const writes=storage.writes;
    await expect(service.loadPreview()).rejects.toMatchObject({code:'STORAGE_CORRUPT'});
    expect(storage.writes).toBe(writes);expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(raw);
  });
  it('当前记录缺生命周期字段、干扰标记或请求回执损坏被拒绝',async()=>{
    const {storage,service}=setup();
    await service.commitResources({baseRevision:'initial',requestId:'save',stations:[{id:'ND-0001',name:'保存'}],devices:[]});
    const raw=storage.getItem(RESOURCE_STORAGE_KEY)!;
    for(const damage of [(r:any)=>{delete r.devices[0].availability;},(r:any)=>{r.interferenceVersion='';},(r:any)=>{r.receipts.push(r.receipts[0]);}]){
      const record=JSON.parse(raw);damage(record);const damaged=JSON.stringify(record);storage.entries.set(RESOURCE_STORAGE_KEY,damaged);
      await expect(service.loadPreview()).rejects.toMatchObject({code:'STORAGE_CORRUPT'});expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(damaged);
    }
  });
});

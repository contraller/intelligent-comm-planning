import {describe,it,expect} from 'vitest';
import {createMockService} from '../src/services/mock';
import {RESOURCE_STORAGE_KEY} from '../src/config/demo';
import {TestStorage} from './helpers/storage';

describe('设备历史原子保存与恢复',()=>{
  async function setup(){const storage=new TestStorage(),api=createMockService(()=>storage);const first=await api.saveResourceChanges({baseRevision:'initial',stations:[],devices:[{id:'DV-0001',currentWorkMode:'MOCK_FIXED'}],context:'ledger',requestId:'first'});return {storage,api,first,query:{context:'ledger' as const,deviceId:'DV-0001',revision:first.readRevision}};}
  it('首次保存保留变更前快照，幂等不重复审计，正文按需读取',async()=>{
    const {api,storage,query}=await setup(),page=await api.queryDeviceHistory({...query,pageNum:1,pageSize:20});expect(page.total).toBe(2);expect(page.items[0].fields).toContain('currentWorkMode');expect(Object.hasOwn(page.items[0],'after')).toBe(false);
    const record=await api.getDeviceHistory({...query,historyId:page.items[0].id});expect(record.before?.currentWorkMode).toBeUndefined();expect(record.after.currentWorkMode).toBe('MOCK_FIXED');expect(record.actor).toBeNull();
    await api.saveResourceChanges({baseRevision:'initial',stations:[],devices:[{id:'DV-0001',currentWorkMode:'MOCK_FIXED'}],context:'ledger',requestId:'first'});expect((await api.queryDeviceHistory({...query,pageNum:1,pageSize:20})).total).toBe(2);
    const bytes=storage.getItem(RESOURCE_STORAGE_KEY);storage.failWrite=true;
    await expect(api.saveResourceChanges({baseRevision:record.revision,stations:[],devices:[{id:'DV-0001',currentWorkMode:'MOCK_HOPPING'}],requestId:'failed'})).rejects.toMatchObject({code:'STORAGE_WRITE_FAILED'});expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(bytes);
  });
  it('恢复产生新版本并保留后续历史，不修改身份和冻结业务快照',async()=>{
    const {api,first,query}=await setup(),original=await api.loadPreview(),page=await api.queryDeviceHistory({...query,pageNum:1,pageSize:20}),target=page.items[0].id;
    const second=await api.saveResourceChanges({baseRevision:first.revision,stations:[],devices:[{id:'DV-0001',currentWorkMode:'MOCK_HOPPING'}],requestId:'second'}),current={...query,revision:second.readRevision};
    const restore=await api.previewDeviceRestore({...current,historyId:target});expect(restore.compatible).toBe(true);expect(Object.keys(restore.values)).not.toContain('modelId');
    const saved=await api.saveResourceChanges({baseRevision:second.revision,stations:[],devices:[{id:query.deviceId,...restore.values}],restoreFrom:{[query.deviceId]:target},requestId:'restore',context:'ledger'});
    expect(saved.revision).not.toBe(first.revision);const history=await api.queryDeviceHistory({...query,revision:saved.readRevision,pageNum:1,pageSize:20});expect(history.total).toBe(4);expect(history.items[0].restoredFrom).toBe(target);
    const after=await api.loadPreview();expect(after.resources.devices[0].currentWorkMode).toBe('MOCK_FIXED');expect(after.resources.devices[0].modelId).toBe(original.resources.devices[0].modelId);expect(after.planning.plans.map(p=>p.inputSnapshot)).toEqual(original.planning.plans.map(p=>p.inputSnapshot));
  });
  it('拒绝旧存储且保留原字节，不补造端口和历史',async()=>{
    const {storage,api}=await setup(),record=JSON.parse(storage.getItem(RESOURCE_STORAGE_KEY)!);record.schemaVersion=5;delete record.deviceHistory;for(const device of record.devices){delete device.ports;delete device.currentWorkMode;}
    // 旧记录只报错，不读取为当前记录，也不触发写回。
    const bytes=JSON.stringify(record);storage.entries.set(RESOURCE_STORAGE_KEY,bytes);const writes=storage.writes;
    await expect(api.loadResourceReadContext({context:'ledger'})).rejects.toMatchObject({code:'STORAGE_INCOMPATIBLE'});
    expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(bytes);expect(storage.writes).toBe(writes);
  });
  it('明确的空频点能够恢复，缺失模式不能夹带成恢复值',async()=>{
    const {api,query,first}=await setup(),page=await api.queryDeviceHistory({...query,pageNum:1,pageSize:20});
    const baseline=page.items.find(h=>h.source==='首次留存的变更前快照')!;
    const second=await api.saveResourceChanges({baseRevision:first.revision,stations:[],devices:[{id:'DV-0001',workFreqKhz:8000}],requestId:'frequency'});
    const value=await api.previewDeviceRestore({...query,revision:second.readRevision,historyId:baseline.id});
    expect(value.values.workFreqKhz).toBeNull();expect(Object.hasOwn(value.values,'currentWorkMode')).toBe(false);
    await expect(api.saveResourceChanges({baseRevision:second.revision,stations:[],devices:[{id:'DV-0001',...value.values,currentWorkMode:'MOCK_HOPPING'}],restoreFrom:{'DV-0001':baseline.id}})).rejects.toMatchObject({code:'RESTORE_INVALID'});
    const saved=await api.saveResourceChanges({baseRevision:second.revision,stations:[],devices:[{id:'DV-0001',...value.values}],restoreFrom:{'DV-0001':baseline.id}});
    expect(saved.device?.workFreqKhz).toBeNull();expect(saved.device?.currentWorkMode).toBe('MOCK_FIXED');
  });
  it('历史不能串设备，伪造恢复或损坏历史不会覆盖存储',async()=>{
    const {api,storage,query,first}=await setup(),page=await api.queryDeviceHistory({...query,pageNum:1,pageSize:20}),id=page.items[0].id;
    await expect(api.getDeviceHistory({...query,deviceId:'DV-0002',historyId:id})).rejects.toMatchObject({code:'HISTORY_NOT_FOUND'});
    await expect(api.saveResourceChanges({baseRevision:first.revision,stations:[],devices:[{id:'DV-0001',currentWorkMode:'MOCK_HOPPING'}],restoreFrom:{'DV-0001':id}})).rejects.toMatchObject({code:'RESTORE_INVALID'});
    const record=JSON.parse(storage.getItem(RESOURCE_STORAGE_KEY)!);record.deviceHistory[0].changes=[];const bytes=JSON.stringify(record);storage.entries.set(RESOURCE_STORAGE_KEY,bytes);await expect(api.loadPreview()).rejects.toMatchObject({code:'STORAGE_CORRUPT'});expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(bytes);
  });
});

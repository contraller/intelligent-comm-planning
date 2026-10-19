import { describe, expect, it } from 'vitest';
import { createMockService } from '../src/services/mock';
import { TestStorage } from './helpers/storage';
import { RESOURCE_STORAGE_KEY, SPECTRUM_STORAGE_KEY } from '../src/config/demo';
describe('频谱独立存储边界',()=>{
  it('重读恢复；频谱与资源各自重置互不影响',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage),first=await service.loadSpectrumWorkspace();
    const saved=await service.saveSpectrumSource({baseRevision:first.revision,requestId:'save',source:{...first.sources[0],minKhz:2,maxKhz:20}});
    expect((await createMockService(()=>storage).loadSpectrumWorkspace())).toEqual(saved.workspace);
    const spectrum=storage.getItem(SPECTRUM_STORAGE_KEY);
    const resources=await service.resetResources('initial');
    expect(storage.getItem(SPECTRUM_STORAGE_KEY)).toBe(spectrum);
    const resourceText=storage.getItem(RESOURCE_STORAGE_KEY);
    await service.resetSpectrumWorkspace(saved.workspace.revision);
    expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(resourceText);
    expect(resources.meta.resourceEpoch).not.toBe('initial');
  });
  it('配额失败、读取拒绝、版本冲突保留原数据',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage),first=await service.loadSpectrumWorkspace();
    const request={baseRevision:first.revision,requestId:'save',source:{...first.sources[0],minKhz:2,maxKhz:20}};
    storage.failWrite=true;
    await expect(service.saveSpectrumSource(request)).rejects.toMatchObject({code:'SPECTRUM_WRITE_FAILED'});
    expect(storage.entries.size).toBe(0);storage.failWrite=false;
    await service.saveSpectrumSource(request);const original=storage.getItem(SPECTRUM_STORAGE_KEY);
    await expect(service.saveSpectrumSource({...request,requestId:'stale'})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    expect(storage.getItem(SPECTRUM_STORAGE_KEY)).toBe(original);
    storage.failRead=true;await expect(service.loadSpectrumWorkspace()).rejects.toMatchObject({code:'SPECTRUM_READ_FAILED'});
  });
  it.each(['{bad','{}','{"schemaVersion":99}'])('损坏 %s 不静默重置，明确重置才能恢复',async text=>{
    const storage=new TestStorage(),service=createMockService(()=>storage);storage.entries.set(SPECTRUM_STORAGE_KEY,text);
    await expect(service.loadSpectrumWorkspace()).rejects.toMatchObject({code:'SPECTRUM_CORRUPT'});
    expect(storage.getItem(SPECTRUM_STORAGE_KEY)).toBe(text);expect(storage.writes).toBe(0);
    await service.resetSpectrumWorkspace(null);expect((await service.loadSpectrumWorkspace()).sources).toHaveLength(2);
  });
});

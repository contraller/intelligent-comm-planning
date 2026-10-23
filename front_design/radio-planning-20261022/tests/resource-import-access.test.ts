import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createAccessService } from '../src/services/access';
import { createMockService } from '../src/services/mock';
import { initialResources } from '../src/mocks/resource-presets';
import type { Permission } from '../src/config/permissions';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';

let pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { if (pinia) disposePinia(pinia); vi.restoreAllMocks(); });
function fixture(permissions: Permission[]) {
  pinia = createPinia(); setActivePinia(pinia);
  const auth = authorizeStore(), identity = { ...auth.identity!, permissions }, storage = new TestStorage();
  const raw = createMockService(() => storage);
  vi.spyOn(raw, 'getSession').mockResolvedValue(identity);
  const load = vi.spyOn(raw, 'loadResourceMaintenanceContext').mockResolvedValue({ revision: 'initial', baseRevision: 'initial',
    device: null, stations: [], models: [], antennas: [], impact: { planIds: [], linkIds: [], description: '构造测试' } });
  const save = vi.spyOn(raw, 'saveResourceChanges').mockResolvedValue({ objectId: 'test-device', changed: false,
    revision: 'initial', readRevision: 'initial', affectedIds: [], warnings: [] });
  return { load, save, service: createAccessService(() => raw, null, () => {}) };
}
const narrow = () => ({ context: 'ledger' as const, baseRevision: 'initial', requestId: 'save-1', stations: [],
  devices: [{ id: 'DV-0001', antennaHeightM: 12 }] });

describe('经过公共访问包装的资源权限', () => {
  it.each(['resources.import', 'resources.create', 'resources.workspace.edit'] as const)('%s 可读取未选设备的完整编辑选项', async permission => {
    const f = fixture(['resources.view', permission]);
    await f.service.loadResourceMaintenanceContext({ context: 'ledger', revision: 'initial' });
    expect(f.load).toHaveBeenCalledTimes(1);
  });
  it('导入或新增权限不能单独变成已有设备参数维护权限', async () => {
    for (const permission of ['resources.import', 'resources.create'] as const) {
      const f = fixture(['resources.view', permission]);
      await expect(f.service.saveResourceChanges(narrow())).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.save).not.toHaveBeenCalled();
    }
  });
  it('新增允许新增设备，但不能夹带既有设备修改', async () => {
    const f = fixture(['resources.view', 'resources.create']);
    const device = { ...initialResources().devices[0]!, id: 'test-device', status: null, alert: null, origin: 'MANUAL' as const };
    await f.service.saveResourceChanges({ ...narrow(), devices: [], newDevices: [device] });
    expect(f.save).toHaveBeenCalledTimes(1);
    await expect(f.service.saveResourceChanges({ ...narrow(), newDevices: [device] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.save).toHaveBeenCalledTimes(1);
  });
  it('GIS 工作区维护同时要求 GIS 页面权限，单设备窄权限不能绕过', async () => {
    const allowed = fixture(['resources.view', 'situation.view', 'resources.workspace.edit']);
    await allowed.service.saveResourceChanges({ ...narrow(), context: 'gis' });
    expect(allowed.save).toHaveBeenCalledTimes(1);
    const denied = fixture(['resources.view', 'resources.device.edit']);
    await expect(denied.service.saveResourceChanges({ ...narrow(), context: 'gis' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(denied.save).not.toHaveBeenCalled();
  });
});

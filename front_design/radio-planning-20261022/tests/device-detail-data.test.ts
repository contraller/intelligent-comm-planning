import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Papa from 'papaparse';
import catalog from '../src/mocks/device-details.json';
import { createMockService } from '../src/services/mock';
import { TestStorage } from './helpers/storage';
import { interferenceFixture } from './helpers/interference';

// 直接对照保留的来源 CSV，防止详情目录误补空值、错配 ID 或截断多值。
function csv(path: string) {
  const parsed = Papa.parse<Record<string, string>>(readFileSync(path, 'utf8'), { header: true, skipEmptyLines: true });
  expect(parsed.errors).toEqual([]); return parsed.data;
}
const numbers = (text: string) => text === '' ? null : text.split(';').map(Number);
describe('设备详情资料边界', () => {
  it('16 个型号和 78 副天线逐字段对应原 CSV，哈希、空值和多值保持一致', () => {
    expect(catalog.version).toBe('device-details-v1'); expect(catalog.sources).toHaveLength(2);
    for (const source of catalog.sources) expect(createHash('sha256').update(readFileSync(source.path)).digest('hex')).toBe(source.sha256);
    const models = csv(catalog.sources[0].path), antennas = csv(catalog.sources[1].path);
    expect(models).toHaveLength(16); expect(antennas).toHaveLength(78);
    expect(catalog.models).toEqual(models.map(row => ({
      modelId: row.model_id, category: row.category || null, txPowerLevelsDbm: numbers(row.tx_power_levels_dbm),
      rxSensitivityDbm: row.rx_sensitivity_dbm === '' ? null : Number(row.rx_sensitivity_dbm), bandwidthKhz: numbers(row.bandwidth_khz),
      serviceTypes: row.service_type === '' ? null : row.service_type.split(';'), dataRatesKbps: numbers(row.data_rate_kbps),
      constraintNote: row.constraint_note || null, sourceDoc: row.source_doc || null,
    })));
    expect(catalog.antennas).toEqual(antennas.map(row => ({ antennaId: row.antenna_id, gainDbi: row.gain_dbi === '' ? null : Number(row.gain_dbi) })));
    expect(catalog.models.filter(row => row.rxSensitivityDbm === null)).toHaveLength(1);
    expect(catalog.models.filter(row => row.bandwidthKhz === null)).toHaveLength(5);
    expect(catalog.models.filter(row => row.dataRatesKbps === null)).toHaveLength(12);
    expect(catalog.antennas.some(row => row.gainDbi === 0)).toBe(true); expect(catalog.antennas.some(row => row.gainDbi < 0)).toBe(true);
  });
  it('补充资料与资源 ID 唯一关联，返回副本隔离且不写入配置或历史预览快照', async () => {
    const storage = new TestStorage(), service = createMockService(() => storage), first = await service.loadPreview();
    expect(new Set(catalog.models.map(row => row.modelId)).size).toBe(16); expect(new Set(catalog.antennas.map(row => row.antennaId)).size).toBe(78);
    expect(catalog.models.map(row => row.modelId).sort()).toEqual(first.resources.models.map(row => row.id).sort());
    expect(catalog.antennas.map(row => row.antennaId).sort()).toEqual(first.resources.antennas.map(row => row.id).sort());
    const resources = structuredClone(first.resources), plans = structuredClone(first.planning);
    first.deviceDetails!.models[0].txPowerLevelsDbm!.push(999);
    first.deviceDetails!.antennas[0].gainDbi = 999;
    const next = await service.loadPreview();
    expect(next.deviceDetails).toEqual(catalog); expect(next.resources).toEqual(resources); expect(next.planning).toEqual(plans);
    expect(first.resources).toEqual(resources); expect(first.planning).toEqual(plans); expect(storage.writes).toBe(0);
    expect(first.resources).not.toHaveProperty('deviceDetails');
  });
  it('读取新增目录不迁移旧资源记录，不改变已保存确认方案及冻结快照', async () => {
    const s = await interferenceFixture(), service = createMockService(() => s.storage);
    const before = [...s.storage.entries], writes = s.storage.writes;
    const workspace = await service.loadPlanningWorkspace(), preview = await service.loadPreview();
    expect(workspace.workspace.plans.find(row => row.id === s.plan.id)).toEqual(s.plan);
    preview.deviceDetails!.models[0].category = '仅修改返回副本';
    expect((await service.loadPlanningWorkspace()).workspace).toEqual(workspace.workspace);
    expect([...s.storage.entries]).toEqual(before); expect(s.storage.writes).toBe(writes);
  });
});

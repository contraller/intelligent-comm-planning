import { describe, expect, it } from 'vitest';
import { authFixture } from './helpers/auth';
import { projectLedgerRows, projectReadLedgerRows, readLedgerCounts } from '../src/services/resource-ledger-workspace';
import { matchesLedgerClassification } from '../src/services/resource-ledger-filter';

// 用真实附件转换数据验证关联口径，不把型号形态当成站点部署方式。
describe('台账分类投影', () => {
  it('按所属站点投影部署方式，角色和中继能力不改变其归属', async () => {
    const data = await authFixture().raw.loadPreview(), rows = projectLedgerRows(data.resources, () => undefined);
    expect(rows.find(row => row.id === 'DV-0009')?.mobility).toBe('VEHICLE');
    const fixed = rows.find(row => row.mobility === 'FIXED')!;
    expect(matchesLedgerClassification(fixed, { mobility: 'FIXED', role: '', relay: 'YES' })).toBe(true);
    expect(matchesLedgerClassification(fixed, { mobility: 'FIXED', role: 'RELAY', relay: '' })).toBe(false);
  });
  it('分页使用相同行模型及全库统计；缺失的来源字段明确为未知', async () => {
    const raw = authFixture().raw, workspace = await raw.loadResourceReadContext({ context: 'ledger' });
    const page = await raw.queryResourceDevices({ context: 'ledger', revision: workspace.revision, pageNum: 1, pageSize: 5 });
    expect(page.items).toHaveLength(5); expect(page.total).toBe(414);
    expect(projectReadLedgerRows(page.items)[0]).toMatchObject({ mobility: 'FIXED', freqMinKhz: 1500 });
    expect(readLedgerCounts(workspace.stats).deployments?.HF.FIXED).toBe(32);
    const { mobility: _, nodeRole: __, freqMinKhz: ___, ...missing } = page.items[0];
    expect(projectReadLedgerRows([missing])[0]).toMatchObject({ mobility: null, nodeRole: null, freqMinKhz: null });
  });
  it('全库观测先参与筛选与统计再分页，按筛选导出不退成当前页', async () => {
    const raw = authFixture().raw, workspace = await raw.loadResourceReadContext({ context: 'ledger' });
    const batch = await raw.queryDeviceStatuses({ context: 'ledger', resourceRevision: workspace.revision, scope: 'ALL', deviceIds: [], exampleId: 'abnormal' });
    const filter = { statusMode: 'observed' as const, observationSnapshotId: batch.snapshotId, status: 'UNKNOWN' as const };
    const page = await raw.queryResourceDevices({ ...filter, context: 'ledger', revision: workspace.revision, pageNum: 1, pageSize: 5 });
    expect(page.items.map(d => d.id)).toEqual(['DV-0004']); expect(page.items[0].status).toBe('NORMAL'); expect(page.stats!.devices).toBe(414);
    const request = { context: 'ledger' as const, format: 'csv' as const, kinds: ['devices' as const], ledger: { revision: workspace.revision, range: 'filtered' as const, filter: { deviceClass: 'HF' as const, mobility: 'FIXED' } } };
    const preview = await raw.previewResourceExport(request); expect(preview.tables).toEqual([{ kind: 'devices', count: 32 }]);
    const output = await raw.exportResources(request); expect(new TextDecoder().decode(output.bytes).trim().split('\n')).toHaveLength(33);
  });
});

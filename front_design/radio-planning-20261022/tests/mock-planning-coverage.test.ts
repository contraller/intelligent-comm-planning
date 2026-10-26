import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import Polygon from 'ol/geom/Polygon';
import Excel from 'exceljs';
import catalogV2 from '../src/mocks/planning-coverage-v2.json';
import { planningPresets } from '../src/mocks/planning-presets';
import { initialResources } from '../src/mocks/resource-presets';
import { PLANNING_STORAGE_KEY } from '../src/config/demo';
import { createPlanningMock } from '../src/services/planning-mock';
import { readResources } from '../src/services/resource-storage';
import { getPresetCoverage, matchesPresetCoverage } from '../src/services/planning-validation';
import type { PlanningCoverage } from '../src/types/coverage';
import { createMockCoverageLayers, mockCoverageVisibility } from '../src/maps/mock-coverage-layers';
// 显示边界直接使用现行常量，不另设旧名称别名。
import { COVERAGE_VECTOR_ZOOM } from '../src/maps/coverage-layers';
import { TestStorage } from './helpers/storage';
import { savedRequest } from './helpers/tasks';
import { interferenceFixture } from './helpers/interference';
import { pngPixels } from './helpers/coverage-png';

// 使用真实 Mock 提交、保存与持久化链路，仅注入时间和内存存储。
function fixture() {
  const storage = new TestStorage();
  let time = Date.parse('2026-10-06T00:00:00Z');
  const reload = () => createPlanningMock(() => storage, () => readResources(storage, initialResources()), () => time);
  const service = reload();
  async function submit(id = 'balanced', complete = true, taskId: string | null = null, parentPlanVersionId: string | null = null) {
    const loaded = await service.loadPlanningWorkspace();
    const submitted = await service.submitPlanning(await savedRequest(storage, {
      baseRevision: loaded.workspace.revision, requestId: crypto.randomUUID(), taskId, parentPlanVersionId,
      input: structuredClone(planningPresets.find(p => p.id === id)!.input),
    }));
    if (complete) time += 10000;
    return submitted;
  }
  async function save(jobId: string) {
    return service.savePlanVersion({ baseRevision: (await service.loadPlanningWorkspace()).workspace.revision,
      jobId, requestId: crypto.randomUUID(), name: '场强快照', note: '' });
  }
  return { storage, service, reload, submit, save, advance: () => { time += 10000; } };
}

// 只修改当前样本的版本标识以验证拒读，不保留整套旧资产。
function unsupportedCoverage(id: string) {
  const coverage = getPresetCoverage(id)!;
  coverage.rasterPng!.url = coverage.rasterPng!.url.replace('demo-v2-', 'demo-v1-');
  coverage.contour!.features[0].id = String(coverage.contour!.features[0].id).replace('demo-v2-', 'demo-v1-');
  return coverage;
}

describe('Mock 教学场强资产', () => {
  it.each(['balanced', 'economical', 'constrained'] as const)('%s 图片尺寸、图例、孔洞和原覆盖边界一致', id => {
    const metadata = getPresetCoverage(id)!;
    const raster = metadata.rasterPng!;
    const contour = metadata.contour!.features[0].geometry;
    const region = planningPresets.find(p => p.id === id)!.result!.regions.find(r => r.kind === 'coverage')!;
    expect(contour).toEqual({ type: 'Polygon', coordinates: region.rings });
    expect(raster.crs).toBe('EPSG:4326');
    const png = readFileSync(`public${raster.url}`);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]]).toEqual([raster.width, raster.height, 8, 6]);
    const pixels = pngPixels(png), stride = 1 + raster.width * 4;
    expect(pixels.length).toBe(raster.height * stride);
    const geometry = new Polygon(region.rings), colors = new Set<string>();
    const unknown = new Polygon(planningPresets.find(p => p.id === id)!.result!.regions.find(r => r.kind === 'uncalculated')!.rings);
    let mismatched = 0, coloredUnknown = 0;
    // 用 OpenLayers 几何逐像素核对，不复用生成脚本的点在多边形内算法。
    for (let y = 0; y < raster.height; y++) {
      expect(pixels[y * stride]).toBe(0);
      for (let x = 0; x < raster.width; x++) {
        const point = [raster.bbox[0] + (x + 0.5) / raster.width * (raster.bbox[2] - raster.bbox[0]), raster.bbox[3] - (y + 0.5) / raster.height * (raster.bbox[3] - raster.bbox[1])];
        const rgba = pixels.subarray(y * stride + 1 + x * 4, y * stride + 5 + x * 4);
        if ((rgba[3] > 0) !== geometry.intersectsCoordinate(point)) {
          // 恰落在线段上的像素两种边界判定可能不同；仅容许浮点精度内的边线点。
          const closest = geometry.getClosestPoint(point);
          if (Math.hypot(point[0] - closest[0], point[1] - closest[1]) > 1e-10) mismatched++;
        }
        if (rgba[3] > 0) { colors.add([...rgba].join(',')); if (unknown.intersectsCoordinate(point)) coloredUnknown++; }
      }
    }
    expect(mismatched).toBe(0); expect(coloredUnknown).toBe(0);
    expect(colors).toEqual(new Set(raster.colormap.map(entry => entry.rgba.join(','))));
  });
  it('设备级均衡明确共享均衡资产，每次读取为独立副本', () => {
    expect(catalogV2.presetAssets['device-balanced']).toBe('balanced');
    const copy = getPresetCoverage('balanced')!;
    expect(getPresetCoverage('device-balanced')).toEqual(copy);
    copy.rasterPng!.url = '/changed.png';
    expect(getPresetCoverage('balanced')!.rasterPng!.url).toBe('/maps/coverage/demo-v2-balanced.png');
    expect(getPresetCoverage('shortage')).toBeUndefined(); expect(getPresetCoverage('execution-failed')).toBeUndefined();
  });
  it.each(['balanced', 'economical', 'constrained', 'device-balanced'])('%s 只接受当前档位版本，拒绝旧版且不改写传入快照', id => {
    for (const [coverage, accepted] of [[unsupportedCoverage(id), false], [getPresetCoverage(id)!, true]] as const) {
      const before = JSON.stringify(coverage);expect(matchesPresetCoverage(id, coverage)).toBe(accepted);expect(JSON.stringify(coverage)).toBe(before);
      expect(matchesPresetCoverage('shortage', coverage)).toBe(false);expect(matchesPresetCoverage('unknown', coverage)).toBe(false);
    }
  });
});

describe('任务和方案冻结场强元数据', () => {
  it.each(['balanced', 'economical', 'constrained', 'device-balanced'])('%s 拒绝旧覆盖任务的查询和保存，原字节不变', async id => {
    const s = fixture(), submitted = await s.submit(id, false);
    const legacy = JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!);legacy.jobs[0].coverage = unsupportedCoverage(id);
    const bytes = JSON.stringify(legacy);s.storage.entries.set(PLANNING_STORAGE_KEY, bytes);const writes = s.storage.writes;
    await expect(s.reload().getPlanningJob(submitted.view.job.id)).rejects.toMatchObject({ code: 'PLANNING_CORRUPT' });
    s.advance();
    await expect(s.reload().getPlanningJob(submitted.view.job.id)).rejects.toMatchObject({ code: 'PLANNING_CORRUPT' });
    await expect(s.save(submitted.view.job.id)).rejects.toMatchObject({ code: 'PLANNING_CORRUPT' });
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes);expect(s.storage.writes).toBe(writes);
  });
  it.each(['balanced', 'economical', 'constrained', 'device-balanced'])('%s 提交、完成、保存、刷新均读取同一覆盖快照', async id => {
    const s = fixture(), submitted = await s.submit(id), job = submitted.view.job;
    const expected = getPresetCoverage(id)!;
    expect(job.coverage).toEqual(expected);
    job.coverage!.rasterPng!.url = '/modified-return-value.png';
    const result = (await s.reload().getPlanningJob(job.id)).result!;
    expect(result.coverage).toEqual(expected);
    expect(result.metrics).toEqual(planningPresets.find(p => p.id === id)!.result!.metrics);
    const saved = await s.save(job.id);
    expect(saved.plan.coverage).toEqual(expected);
    saved.plan.coverage!.rasterPng!.url = '/modified-plan.png';
    const restored = (await s.reload().loadPlanningWorkspace()).workspace.plans[0];
    expect(restored.coverage).toEqual(expected); expect(restored.snapshotId).toBe(result.snapshotId);
    expect(restored.state).toBe(id === 'constrained' ? 'REFERENCE' : 'SAVED');
  });
  it('切换档位后新旧方案图片分别保留', async () => {
    const s = fixture(), first = await s.submit('balanced');
    const a = await s.save(first.view.job.id), second = await s.submit('economical');
    const b = await s.save(second.view.job.id), restored = (await s.reload().loadPlanningWorkspace()).workspace.plans;
    expect(restored.find(p => p.id === a.plan.id)!.coverage).toEqual(getPresetCoverage('balanced'));
    expect(restored.find(p => p.id === b.plan.id)!.coverage).toEqual(getPresetCoverage('economical'));
    expect(a.plan.snapshotId).not.toBe(b.plan.snapshotId);
  });
  it('拒绝旧覆盖方案的读取、确认和比较，原记录保留', async () => {
    const s = fixture(), submitted = await s.submit(), saved = await s.save(submitted.view.job.id);
    const legacy = JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!), coverage = unsupportedCoverage('balanced');
    legacy.jobs[0].coverage = coverage;legacy.plans[0].coverage = coverage;
    const bytes = JSON.stringify(legacy);s.storage.entries.set(PLANNING_STORAGE_KEY, bytes);const writes = s.storage.writes;
    await expect(s.reload().loadPlanningWorkspace()).rejects.toMatchObject({ code: 'PLANNING_CORRUPT' });
    await expect(s.service.confirmPlanVersion({ baseRevision: saved.workspace.revision, requestId: crypto.randomUUID(), planId: saved.plan.id })).rejects.toMatchObject({ code: 'PLANNING_CORRUPT' });
    await expect(s.reload().comparePlanVersions([saved.plan.id])).rejects.toMatchObject({ code: 'PLANNING_CORRUPT' });
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes);expect(s.storage.writes).toBe(writes);
  });
  it('当前任务允许未提供覆盖元数据，不回填、不改写读取字节', async () => {
    const s = fixture(), submitted = await s.submit();
    const legacy = JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!);
    delete legacy.jobs[0].coverage;
    const bytes = JSON.stringify(legacy); s.storage.entries.set(PLANNING_STORAGE_KEY, bytes);
    expect((await s.reload().getPlanningJob(submitted.view.job.id)).result!.coverage).toBeUndefined();
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes);
    const saved = await s.save(submitted.view.job.id);
    expect(saved.plan.coverage).toBeUndefined();
    const savedBytes = s.storage.getItem(PLANNING_STORAGE_KEY);
    expect((await s.reload().loadPlanningWorkspace()).workspace.plans[0].coverage).toBeUndefined();
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(savedBytes);
  });
  it.each(['job', 'plan', 'missing-plan', 'v1-job-v2-plan', 'v2-job-v1-plan'] as const)('%s 元数据串图、同档混版或遗失时拒绝读取，保留损坏记录', async target => {
    const s = fixture(), submitted = await s.submit(); await s.save(submitted.view.job.id);
    const broken = JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!);
    if (target === 'job') broken.jobs[0].coverage = getPresetCoverage('economical');
    else if (target === 'plan') broken.plans[0].coverage = getPresetCoverage('economical');
    else if (target === 'v1-job-v2-plan') broken.jobs[0].coverage = unsupportedCoverage('balanced');
    else if (target === 'v2-job-v1-plan') broken.plans[0].coverage = unsupportedCoverage('balanced');
    else delete broken.plans[0].coverage;
    const bytes = JSON.stringify(broken); s.storage.entries.set(PLANNING_STORAGE_KEY, bytes);
    await expect(s.reload().loadPlanningWorkspace()).rejects.toMatchObject({ code: 'PLANNING_CORRUPT' });
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes);
  });
  it.each([
    ['修改色表', (c: PlanningCoverage) => { c.rasterPng!.colormap[0].rgba[0] ^= 1; }],
    ['v2 色表配旧 URL', (c: PlanningCoverage) => { c.rasterPng!.url = unsupportedCoverage('balanced').rasterPng!.url; }],
    ['跨档位串图', (c: PlanningCoverage) => { c.rasterPng!.url = getPresetCoverage('economical')!.rasterPng!.url; }],
    ['异档完整资产', (c: PlanningCoverage) => Object.assign(c, getPresetCoverage('economical'))],
    ['修改几何', (c: PlanningCoverage) => { const geometry = c.contour!.features[0].geometry;if (geometry.type === 'Polygon') geometry.coordinates[0][1][0] += 0.001; }],
    ['修改尺寸', (c: PlanningCoverage) => { c.rasterPng!.width++; }],
    ['修改覆盖身份', (c: PlanningCoverage) => { c.contour!.features[0].id = 'demo-v2-other'; }],
    ['未知版本', (c: PlanningCoverage) => { c.rasterPng!.url = '/maps/coverage/demo-v99-balanced.png'; c.contour!.features[0].id = 'demo-v99-balanced'; }],
  ] as const)('%s 不满足完整版本匹配，拒读且保留损坏数据', async (_name, mutate) => {
    const s = fixture(), submitted = await s.submit(), coverage = getPresetCoverage('balanced')!;mutate(coverage);
    expect(matchesPresetCoverage('balanced', coverage)).toBe(false);
    const broken = JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!);broken.jobs[0].coverage = coverage;
    const bytes = JSON.stringify(broken);s.storage.entries.set(PLANNING_STORAGE_KEY, bytes);
    await expect(s.reload().getPlanningJob(submitted.view.job.id)).rejects.toMatchObject({ code: 'PLANNING_CORRUPT' });
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes);
  });
  it('干扰采纳结果不继承父方案场强图，父方案仍可恢复', async () => {
    const s = await interferenceFixture(), submitted = await s.submit(); s.advance();
    const adopted = await s.adopt(submitted.view.run.analysisId, 'NODE_REDEPLOY');
    expect(s.plan.coverage).toEqual(getPresetCoverage('balanced'));
    expect(adopted.plan.coverage).toBeUndefined();
    const restored = (await s.planning.loadPlanningWorkspace()).workspace.plans;
    expect(restored.find(p => p.id === s.plan.id)!.coverage).toEqual(s.plan.coverage);
    expect(restored.find(p => p.id === adopted.plan.id)!.coverage).toBeUndefined();
  });
  it('当前 JSON 和 XLSX 快照包含覆盖路径及色表，不打包 PNG 或改写存储', async () => {
    const s = fixture(), submitted = await s.submit(), saved = await s.save(submitted.view.job.id);
    const coverage = getPresetCoverage('balanced'), before = s.storage.getItem(PLANNING_STORAGE_KEY);
    const json = await s.service.exportPlanVersion({ planId: saved.plan.id, format: 'json' });
    const parsed = JSON.parse(new TextDecoder().decode(json.bytes));
    expect(parsed.plan.coverage).toEqual(coverage);
    const xlsx = await s.service.exportPlanVersion({ planId: saved.plan.id, format: 'xlsx' });
    const book = new Excel.Workbook(); await book.xlsx.load(new Uint8Array(xlsx.bytes).buffer);
    const parts: string[] = [];
    book.getWorksheet('完整快照')!.eachRow((row, i) => { if (i > 1) parts.push(String(row.getCell(2).value)); });
    expect(JSON.parse(parts.join('')).plan.coverage).toEqual(parsed.plan.coverage);
    expect(book.model.media ?? []).toHaveLength(0);
    expect(new TextDecoder().decode(json.bytes)).not.toContain('data:image');
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(before);
  });
});

describe('仅切换已有 Mock 覆盖图层', () => {
  it('自动缩放与手工选择独立，轮廓在图片成功前始终保留', () => {
    const c = getPresetCoverage('balanced')!;
    expect(mockCoverageVisibility(c, 'auto', COVERAGE_VECTOR_ZOOM - 1, 'ready')).toMatchObject({ raster: true, vector: false });
    expect(mockCoverageVisibility(c, 'auto', COVERAGE_VECTOR_ZOOM, 'ready')).toMatchObject({ raster: true, vector: true, outlineOnly: true });
    expect(mockCoverageVisibility(c, 'raster', 6, 'ready')).toMatchObject({ raster: true, vector: false });
    expect(mockCoverageVisibility(c, 'raster', 17, 'ready')).toMatchObject({ raster: true, vector: false });
    expect(mockCoverageVisibility(c, 'contour', 17, 'ready')).toMatchObject({ raster: false, vector: true });
    expect(mockCoverageVisibility(c, 'raster', 6, 'loading')).toMatchObject({ raster: true, vector: true });
    expect(mockCoverageVisibility(c, 'raster', 6, 'error')).toMatchObject({ raster: false, vector: true });
    expect(mockCoverageVisibility(c, 'raster', 6, 'ready', false)).toMatchObject({ raster: false, vector: false });
  });
  it('失败重试不重建轮廓，旧图片回调与卸载后回调不影响新图片', () => {
    const status = vi.fn(), layers = createMockCoverageLayers(getPresetCoverage('balanced')!, status, '/demo/');
    const vector = layers.vector, oldSource = layers.raster!.getSource()!;
    expect(oldSource.getUrl()).toBe('/demo/maps/coverage/demo-v2-balanced.png');
    layers.setDisplay('raster', 6, true, 0.5);
    oldSource.dispatchEvent('imageloaderror');
    expect(layers.vector.getVisible()).toBe(true); expect(layers.raster!.getVisible()).toBe(false);
    expect(status).toHaveBeenLastCalledWith('error');
    layers.setDisplay('contour', 17, true, 0.5); expect(status).toHaveBeenLastCalledWith('idle');
    layers.setDisplay('raster', 6, true, 0.5); layers.retry();
    const source = layers.raster!.getSource()!;
    expect(source).not.toBe(oldSource); expect(layers.vector).toBe(vector);
    oldSource.dispatchEvent('imageloadend'); expect(status).toHaveBeenLastCalledWith('loading');
    source.dispatchEvent('imageloadend');
    expect(layers.vector.getVisible()).toBe(false); expect(layers.raster!.getVisible()).toBe(true);
    layers.setDisplay('auto', 9, true, 0.2);
    expect(layers.raster!.getSource()).toBe(source); expect(layers.vector.getOpacity()).toBe(0.2);
    layers.setDisplay('auto', COVERAGE_VECTOR_ZOOM, true, 0.2);
    expect(layers.vector.getVisible()).toBe(true); expect(layers.raster!.getVisible()).toBe(true);
    layers.setDisplay('contour', 6, true, 0.2);
    expect(layers.vector.getVisible()).toBe(true); expect(layers.raster!.getVisible()).toBe(false);
    expect(layers.raster!.getSource()).toBe(source);
    layers.dispose(); status.mockClear(); source.dispatchEvent('imageloaderror'); layers.retry();
    expect(status).not.toHaveBeenCalled();
  });
});

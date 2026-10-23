import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import Polygon from 'ol/geom/Polygon';
import Excel from 'exceljs';
import catalog from '../src/mocks/planning-coverage.json';
import catalogV2 from '../src/mocks/planning-coverage-v2.json';
import { planningPresets } from '../src/mocks/planning-presets';
import { initialResources } from '../src/mocks/resource-presets';
import { PLANNING_STORAGE_KEY } from '../src/config/demo';
import { createPlanningMock } from '../src/services/planning-mock';
import { readResources } from '../src/services/resource-storage';
import { getPresetCoverage, matchesPresetCoverage } from '../src/services/planning-validation';
import { readCoverage } from '../src/services/coverage-validation';
import type { PlanningCoverage } from '../src/types/coverage';
import { createMockCoverageLayers, mockCoverageVisibility, MOCK_RASTER_ZOOM } from '../src/maps/mock-coverage-layers';
import { TestStorage } from './helpers/storage';
import { savedRequest } from './helpers/tasks';
import { interferenceFixture } from './helpers/interference';

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

// v1 从保留的目录独立读取，不能借“当前默认资产”伪造历史快照。
function legacyCoverage(id: string) {
  const asset = catalog.presetAssets[id as keyof typeof catalog.presetAssets] as keyof typeof catalog.assets;
  return readCoverage(structuredClone(catalog.assets[asset].coverage));
}
function pngPixels(png: Buffer) {
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  return inflateSync(Buffer.concat(chunks));
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
    expect(catalog.presetAssets['device-balanced']).toBe('balanced');
    const copy = getPresetCoverage('balanced')!;
    expect(getPresetCoverage('device-balanced')).toEqual(copy);
    copy.rasterPng!.url = '/changed.png';
    expect(getPresetCoverage('balanced')!.rasterPng!.url).toBe('/maps/coverage/demo-v2-balanced.png');
    expect(getPresetCoverage('shortage')).toBeUndefined(); expect(getPresetCoverage('execution-failed')).toBeUndefined();
  });
  it.each(['balanced', 'economical', 'constrained'] as const)('%s v2 仅替换既有像素 RGB，逐像素 alpha、透明区、孔洞及色阶位置不变', id => {
    const oldAsset = catalog.assets[id], newAsset = catalogV2.assets[id];
    const old = legacyCoverage(id), current = getPresetCoverage(id)!;
    expect(current.contour!.features[0]).toEqual({ ...old.contour!.features[0], id: `demo-v2-${id}` });
    expect(current.rasterPng).toEqual({ ...old.rasterPng, url: `/maps/coverage/demo-v2-${id}.png`, colormap: [
      { value_dbuvm: 20, rgba: [253,216,53,190] }, { value_dbuvm: 30, rgba: [156,204,101,190] }, { value_dbuvm: 40, rgba: [46,125,50,190] },
    ] });
    expect(newAsset.patches).toEqual(oldAsset.patches);
    const a = pngPixels(readFileSync(`public${old.rasterPng!.url}`)), b = pngPixels(readFileSync(`public${current.rasterPng!.url}`));
    expect(b.length).toBe(a.length);
    const stride = 1 + current.rasterPng!.width * 4, expected = Buffer.from(a);
    // 直接按旧图色阶逐像素替色作为独立预期，不复用生成模块或重新栅格化几何。
    const replacement = new Map(old.rasterPng!.colormap.map((entry, index) => [entry.rgba.join(','), current.rasterPng!.colormap[index].rgba]));
    let transparent = 0, colored = 0;
    for (let y = 0; y < current.rasterPng!.height; y++) {
      expect(a[y * stride]).toBe(0);expect(b[y * stride]).toBe(0);
      for (let x = 0; x < current.rasterPng!.width; x++) {
        const offset = y * stride + 1 + x * 4;
        if (a[offset + 3] === 0) { transparent++;continue; }
        const color = replacement.get([...a.subarray(offset, offset + 4)].join(','));
        if (!color) throw new Error('旧 PNG 出现未声明色阶');
        expected.set(color, offset);colored++;
      }
    }
    expect(colored).toBeGreaterThan(0);expect(transparent).toBeGreaterThan(0);expect(b.equals(expected)).toBe(true);
  });
  it('既有 v1 目录和三张规划图片字节摘要保持', () => {
    const hashes = {
      'src/mocks/planning-coverage.json': 'f2fe2e75d05e011116aaf03a9489e4accecc079c28eea2efce0a6b423ca3dea3',
      'public/maps/coverage/demo-v1-balanced.png': '5f0d3f9fd95f4dc3fee40c1a99a583bf7f0c54b4e7227d75644460cf1a801fef',
      'public/maps/coverage/demo-v1-economical.png': '91312782108ddb6b86dbe15adad793f1562b896631604f873faa084cdf4b599c',
      'public/maps/coverage/demo-v1-constrained.png': '85ea942bbb5866f4cb8712d53ef7546e6779630bebfc7245b2a7a89469f7ba43',
    };
    for (const [file, hash] of Object.entries(hashes)) expect(createHash('sha256').update(readFileSync(file)).digest('hex'), file).toBe(hash);
  });
  it.each(['balanced', 'economical', 'constrained', 'device-balanced'])('%s 接受完整同档位双版本，校验不改写传入快照', id => {
    for (const coverage of [legacyCoverage(id), getPresetCoverage(id)!]) {
      const before = JSON.stringify(coverage);expect(matchesPresetCoverage(id, coverage)).toBe(true);expect(JSON.stringify(coverage)).toBe(before);
      expect(matchesPresetCoverage('shortage', coverage)).toBe(false);expect(matchesPresetCoverage('unknown', coverage)).toBe(false);
    }
  });
});

describe('任务和方案冻结场强元数据', () => {
  it.each(['balanced', 'economical', 'constrained', 'device-balanced'])('%s 未完成的 v1 任务查询、完成及保存沿用提交快照', async id => {
    const s = fixture(), submitted = await s.submit(id, false), coverage = legacyCoverage(id);
    const legacy = JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!);legacy.jobs[0].coverage = coverage;
    const bytes = JSON.stringify(legacy);s.storage.entries.set(PLANNING_STORAGE_KEY, bytes);
    const pending = await s.reload().getPlanningJob(submitted.view.job.id);
    expect(['PENDING','RUNNING']).toContain(pending.state);expect(pending.job.coverage).toEqual(coverage);expect(pending.result).toBeNull();
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes);
    s.advance();const completed = await s.reload().getPlanningJob(submitted.view.job.id);
    expect(completed.result!.coverage).toEqual(coverage);expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes);
    const saved = await s.save(submitted.view.job.id);expect(saved.plan.coverage).toEqual(coverage);
    expect(saved.plan.metrics).toEqual(completed.result!.metrics);expect(saved.plan.sourceChanged).toBe(false);
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
  it('已保存的 v1 方案仍可确认并与同任务 v2 调整版比较，读取不迁移原记录', async () => {
    const s = fixture(), submitted = await s.submit(), saved = await s.save(submitted.view.job.id);
    const legacy = JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!), coverage = legacyCoverage('balanced');
    legacy.jobs[0].coverage = coverage;legacy.plans[0].coverage = coverage;
    const bytes = JSON.stringify(legacy);s.storage.entries.set(PLANNING_STORAGE_KEY, bytes);
    const loaded = await s.reload().loadPlanningWorkspace(), old = loaded.workspace.plans[0];
    expect(old).toEqual({ ...saved.plan, coverage });expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes);
    const confirmed = await s.service.confirmPlanVersion({ baseRevision: loaded.workspace.revision, requestId: crypto.randomUUID(), planId: old.id });
    expect(confirmed.plan.coverage).toEqual(coverage);expect(confirmed.plan.state).toBe('CONFIRMED');
    expect(confirmed.workspace.currentConfirmedByTask[old.taskId]).toBe(old.id);expect(confirmed.plan.sourceChanged).toBe(false);
    const adjustment = await s.submit('balanced', true, old.taskId, old.id), next = await s.save(adjustment.view.job.id);
    expect(next.plan.coverage).toEqual(getPresetCoverage('balanced'));expect(next.plan.workflow!.parentPlanVersionId).toBe(old.id);
    const frozenBytes = s.storage.getItem(PLANNING_STORAGE_KEY), compared = await s.reload().comparePlanVersions([old.id, next.plan.id]);
    expect(compared.map(plan => plan.coverage)).toEqual([coverage, getPresetCoverage('balanced')]);
    expect(compared[0].state).toBe('CONFIRMED');expect(compared.every(plan => !plan.sourceChanged)).toBe(true);
    expect((await s.reload().loadPlanningWorkspace()).workspace.currentConfirmedByTask[old.taskId]).toBe(old.id);
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(frozenBytes);
  });
  it('旧任务和旧保存记录缺失覆盖元数据时不回填、不改写读取字节', async () => {
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
    else if (target === 'v1-job-v2-plan') broken.jobs[0].coverage = legacyCoverage('balanced');
    else if (target === 'v2-job-v1-plan') broken.plans[0].coverage = legacyCoverage('balanced');
    else delete broken.plans[0].coverage;
    const bytes = JSON.stringify(broken); s.storage.entries.set(PLANNING_STORAGE_KEY, bytes);
    await expect(s.reload().loadPlanningWorkspace()).rejects.toMatchObject({ code: 'PLANNING_CORRUPT' });
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes);
  });
  it.each([
    ['v2 URL 配旧色表', (c: PlanningCoverage) => { c.rasterPng!.colormap = legacyCoverage('balanced').rasterPng!.colormap; }],
    ['v2 色表配旧 URL', (c: PlanningCoverage) => { c.rasterPng!.url = legacyCoverage('balanced').rasterPng!.url; }],
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
  it.each(['v1', 'v2'] as const)('%s JSON 和 XLSX 完整快照包含所属版本路径及色表，不打包 PNG 或改写存储', async version => {
    const s = fixture(), submitted = await s.submit(), saved = await s.save(submitted.view.job.id);
    if (version === 'v1') {
      const legacy = JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!);
      legacy.jobs[0].coverage = legacyCoverage('balanced');legacy.plans[0].coverage = legacyCoverage('balanced');
      s.storage.entries.set(PLANNING_STORAGE_KEY, JSON.stringify(legacy));
    }
    const coverage = version === 'v1' ? legacyCoverage('balanced') : getPresetCoverage('balanced'), before = s.storage.getItem(PLANNING_STORAGE_KEY);
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
    expect(mockCoverageVisibility(c, 'auto', MOCK_RASTER_ZOOM - 1, 'ready')).toMatchObject({ raster: true, vector: false });
    expect(mockCoverageVisibility(c, 'auto', MOCK_RASTER_ZOOM, 'ready')).toMatchObject({ raster: true, vector: true, outlineOnly: true });
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
    layers.setDisplay('auto', MOCK_RASTER_ZOOM, true, 0.2);
    expect(layers.vector.getVisible()).toBe(true); expect(layers.raster!.getVisible()).toBe(true);
    layers.setDisplay('contour', 6, true, 0.2);
    expect(layers.vector.getVisible()).toBe(true); expect(layers.raster!.getVisible()).toBe(false);
    expect(layers.raster!.getSource()).toBe(source);
    layers.dispose(); status.mockClear(); source.dispatchEvent('imageloaderror'); layers.retry();
    expect(status).not.toHaveBeenCalled();
  });
});

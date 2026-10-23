import { afterEach, describe, expect, it, vi } from 'vitest';
import { Style } from 'ol/style';
import { createFaultPulse, shouldDisplayLink, type LinkDisplayState } from '../src/maps/link-display';
import { linkLayer } from '../src/maps/layers';
import { monitoringMap } from '../src/maps/monitoring-view';
import { createMockService } from '../src/services/mock';
import { planningPresets } from '../src/mocks/planning-presets';
import { monitoringPresets } from '../src/mocks/monitoring-presets';
import type { NetworkLink } from '../src/types/domain';
import { TestStorage } from './helpers/storage';
import { monitoringFixture } from './helpers/monitoring';

const base = planningPresets[0];
const sample = (changes: Partial<NetworkLink> = {}): NetworkLink => ({ ...base.result!.links[0], ...changes });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('主干教学标记与历史兼容', () => {
  it('GIS 七条链路明确标记，新增备用链路不回填历史，经服务读取不写存储', async () => {
    const storage = new TestStorage(), service = createMockService(() => storage);
    const data = await service.loadPreview();
    expect(data.situation.links.map(link => [link.id, link.isBackbone])).toEqual([
      ['PL-001', true], ['PL-002', true], ['PL-003', true], ['PL-004', false], ['PL-005', false], ['PL-006', false], ['PL-007', false],
    ]);
    expect(data.situation.candidateLinks.every(link => link.isBackbone === undefined)).toBe(true);
    // 新备用线复用既有缩放及高亮例外，不改原历史方案。
    const backup = data.situation.links.find(link => link.id === 'PL-007')!;
    expect(backup.backup).toBe(true); expect(shouldDisplayLink(backup, 9)).toBe(false); expect(shouldDisplayLink(backup, 9, true)).toBe(true);
    expect(data.planning.plans.every(plan => plan.links.every(link => link.isBackbone === undefined))).toBe(true);
    data.situation.links[0].isBackbone = false;
    expect((await service.loadPreview()).situation.links[0].isBackbone).toBe(true);
    expect(storage.writes).toBe(0);
  });
  it('仅内置均衡监控网络带标记，观测换帧保留身份且不改规划预设', async () => {
    const original = JSON.stringify(planningPresets), storage = new TestStorage();
    const context = await createMockService(() => storage).loadMonitoringContext(null);
    expect(context.errorCode).toBeNull();
    expect(context.network?.kind).toBe('DEMO');
    expect(context.network?.links.map(link => [link.id, link.isBackbone])).toEqual([
      ['LINK-A', true], ['LINK-B', true], ['LINK-C', false],
    ]);
    const demo = monitoringPresets[0];
    for (const frame of demo.frames) {
      expect(monitoringMap(demo.network, frame).links.map(link => link.isBackbone)).toEqual([true, true, false]);
    }
    expect(monitoringPresets.filter(row => row.id !== 'balanced').every(row => row.network.links.every(link => link.isBackbone === undefined))).toBe(true);
    expect(JSON.stringify(planningPresets)).toBe(original);
    expect(storage.writes).toBe(0);
  });
  it('实际保存确认的旧格式方案仍可恢复和监控，不从演示网络回填标记', async () => {
    const fixture = await monitoringFixture();
    const saved = [...fixture.storage.entries], writes = fixture.storage.writes;
    const service = createMockService(() => fixture.storage);
    const { workspace } = await service.loadPlanningWorkspace();
    const plan = workspace.plans.find(row => row.state === 'CONFIRMED')!;
    expect(plan).toBeDefined();
    const context = await service.loadMonitoringContext(plan.taskId);
    expect(context.errorCode).toBeNull(); expect(context.network?.kind).toBe('PLAN');
    expect(context.network?.links).toEqual(plan.links);
    expect(context.network?.links.every(link => link.isBackbone === undefined && shouldDisplayLink(link, 6))).toBe(true);
    expect([...fixture.storage.entries]).toEqual(saved); expect(fixture.storage.writes).toBe(writes);
  });
});

describe('链路显示规则', () => {
  it.each([
    ['主干', { isBackbone: true }, false, true],
    ['普通', { isBackbone: false }, false, false],
    ['故障非主干', { isBackbone: false, state: 'FAULT' }, false, true],
    ['预警非主干', { isBackbone: false, state: 'WARNING' }, false, false],
    ['选中或高亮非主干', { isBackbone: false }, true, true],
    ['未知', { isBackbone: null }, false, true],
    ['历史缺失', {}, false, true],
    ['备用主干', { isBackbone: true, backup: true }, false, true],
  ] as const)('%s 在小比例尺按明确身份展示', (_name, changes, retained, visible) => {
    expect(shouldDisplayLink(sample(changes), 9.99, retained)).toBe(visible);
    expect(shouldDisplayLink(sample(changes), 10, retained)).toBe(true);
  });
  it('实际图层随缩放隐藏样式并恢复同一要素，选中与高亮均可保留', () => {
    const links = [sample({ isBackbone: false }), sample({ id: 'FOCUS', isBackbone: false, backup: true })];
    const before = JSON.stringify(links), display: LinkDisplayState = { zoom: 9, faultDimmed: false };
    const layer = linkLayer(links, base.baseline.stations, false, ['FOCUS'], display);
    const [normal, focused] = layer.getSource()!.getFeatures(), style = layer.getStyleFunction()!;
    expect(style(normal, 1)).toBeUndefined(); expect(style(focused, 1)).toHaveLength(2);
    display.zoom = 10; expect(style(normal, 1)).toBeInstanceOf(Style);
    display.zoom = 9; display.selectedLinkId = normal.get('objectId');
    expect(style(normal, 1)).toBeInstanceOf(Style);
    display.selectedLinkId = undefined; expect(style(normal, 1)).toBeUndefined();
    expect(layer.getSource()!.getFeatures()).toEqual([normal, focused]);
    expect(JSON.stringify(links)).toBe(before);
  });
  it('故障明暗始终保留 4 px 红线、备用虚线和选中外框；候选线不参与', () => {
    const fault = sample({ state: 'FAULT', backup: true, isBackbone: false });
    const display: LinkDisplayState = { zoom: 6, faultDimmed: false };
    const layer = linkLayer([fault], base.baseline.stations, false, [fault.id], display);
    const feature = layer.getSource()!.getFeatures()[0], style = () => layer.getStyleFunction()!(feature, 1) as Style[];
    expect(style()[1].getStroke()!.getColor()).toBe('#ef5f64');
    display.faultDimmed = true;
    expect(style()[1].getStroke()!.getColor()).toBe('#ef5f6466');
    expect(style()[1].getStroke()!.getWidth()).toBe(4);
    for (const item of style()) expect(item.getStroke()!.getLineDash()).toEqual([6, 6]);
    expect(style()[0].getStroke()!.getColor()).toBe('#c2edff');
    const candidate = linkLayer([fault], base.baseline.stations, true, [fault.id], display);
    const candidateStyle = candidate.getStyleFunction()!(candidate.getSource()!.getFeatures()[0], 1) as Style;
    expect(candidateStyle.getStroke()!.getColor()).toBe('#8291ab'); expect(candidateStyle.getStroke()!.getWidth()).toBe(1);
  });
});

function pulseFixture(hidden = false, reduced = false) {
  vi.useFakeTimers();
  const page = Object.assign(new EventTarget(), { hidden });
  const motion = Object.assign(new EventTarget(), { matches: reduced });
  const update = vi.fn(), pulse = createFaultPulse(update, page, motion);
  return { page, motion, update, pulse };
}
describe('故障动画生命周期', () => {
  it('1.2 秒完成明暗周期，重复启用不增加定时器，停止恢复明相', () => {
    const { pulse, update } = pulseFixture();
    expect(vi.getTimerCount()).toBe(0);
    pulse.setActive(true); pulse.setActive(true); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(599); expect(update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(update).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(600); expect(update).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(600); pulse.setActive(false);
    expect(update).toHaveBeenLastCalledWith(false); expect(vi.getTimerCount()).toBe(0);
    pulse.dispose();
  });
  it('后台和减少动态效果均暂停；恢复时只有一个定时器', () => {
    const { page, motion, update, pulse } = pulseFixture(); pulse.setActive(true);
    vi.advanceTimersByTime(600); page.hidden = true; page.dispatchEvent(new Event('visibilitychange'));
    expect(update).toHaveBeenLastCalledWith(false); expect(vi.getTimerCount()).toBe(0);
    motion.matches = true; page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);
    motion.matches = false; motion.dispatchEvent(new Event('change')); expect(vi.getTimerCount()).toBe(1);
    pulse.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('初始减少动态效果时保持静态，释放后事件和重复启用均不能重启动画', () => {
    const { page, motion, update, pulse } = pulseFixture(false, true);
    const removePage = vi.spyOn(page, 'removeEventListener'), removeMotion = vi.spyOn(motion, 'removeEventListener');
    pulse.setActive(true); vi.advanceTimersByTime(5000); expect(update).not.toHaveBeenCalled();
    pulse.dispose(); motion.matches = false; motion.dispatchEvent(new Event('change'));
    page.dispatchEvent(new Event('visibilitychange')); pulse.setActive(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(removePage).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(removeMotion).toHaveBeenCalledWith('change', expect.any(Function));
  });
});

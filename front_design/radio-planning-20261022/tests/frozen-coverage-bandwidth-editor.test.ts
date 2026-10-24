import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { h, nextTick, reactive, ssrContextKey, type App } from 'vue';
import FrozenCoverageBandwidthEditor, { bandwidthConfirmation, bandwidthOptionsValid, bandwidthRowState, type CoverageBandwidthRow } from '../src/components/FrozenCoverageBandwidthEditor.vue';
import { all, clientTemplate, node, renderer, textOf, type HostNode } from './helpers/vue-client';

beforeAll(() => clientTemplate(FrozenCoverageBandwidthEditor, 'src/components/FrozenCoverageBandwidthEditor.vue', 'coverage-bandwidth-render.ts'));
const apps: App[] = [];
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); vi.unstubAllGlobals(); });
const row = (deviceId = 'D1', values: Partial<CoverageBandwidthRow> = {}): CoverageBandwidthRow => ({ deviceId, modelId: 'M1', modelName: '型号一', optionsKhz: [0.5, 2.4], frozenKhz: null, frozenSource: '', editable: true, unavailableReason: '', ...values });
const draft = (value = 2.4) => ({ before: null, value, modelId: 'M1', options: '[0.5,2.4]' });
async function flush() { await nextTick(); await Promise.resolve(); }
async function fixture(rows: CoverageBandwidthRow[] = [row(), row('D2'), row('D3', { modelId: 'M2', modelName: '型号二', optionsKhz: [3] }), row('D4', { optionsKhz: null, unavailableReason: '型号带宽未提供' })]) {
  vi.stubGlobal('document', { activeElement: null }); vi.stubGlobal('Document', class {}); vi.stubGlobal('ShadowRoot', class {});
  const props = reactive({ rows, sourceKey: 'frozen-source-1', writable: true, busy: false, loading: false, error: '' });
  const root = node('root'), confirm = vi.fn(), dirty = vi.fn();
  const app = renderer.createApp({ render: () => h(FrozenCoverageBandwidthEditor, { ...props, onConfirm: confirm, onDirtyChange: dirty }) });
  apps.push(app); app.provide(ssrContextKey, {}); app.mount(root); await flush();
  return { root, props, confirm, dirty };
}
function control(root: HostNode, label: string) {
  const value = all(root, item => item.props['aria-label'] === label)[0]; expect(value).toBeDefined(); return value;
}
async function model(root: HostNode, label: string, value: string) {
  (control(root, label).props['onUpdate:modelValue'] as (value: string) => void)(value); await flush();
}
async function choose(root: HostNode, id: string, value: string) {
  (control(root, `设备 ${id} 带宽`).props.onChange as (event: unknown) => void)({ target: { value } }); await flush();
}
async function click(root: HostNode, text: string) {
  const button = all(root, item => item.tag === 'button' && textOf(item).trim() === text)[0]; expect(button).toBeDefined();
  (button.props.onClick as () => void)(); await flush();
}

describe('覆盖带宽组件纯选择规则', () => {
  it('合法单项或多项都不替未选设备选择第一值，已冻结来源值独立保留', () => {
    expect(bandwidthRowState(row())).toBe('未选'); expect(bandwidthRowState(row('D1', { optionsKhz: [0.5] }))).toBe('未选');
    expect(bandwidthRowState(row('D1', { frozenKhz: 2.4, frozenSource: '服务端已冻结' }))).toBe('合法');
    expect(bandwidthConfirmation([row()], {})).toEqual([]);
  });
  it.each([null, [], [0], [-1], [NaN], [Infinity], [1, 1]])('未知或损坏选项不能作为合法选择：%j', optionsKhz => {
    const value = row('D1', { optionsKhz }); expect(bandwidthOptionsValid(value)).toBe(false);
    expect(bandwidthRowState(value)).toBe(optionsKhz?.length ? '资料待核验' : '无资料');
  });
  it('确认按设备ID稳定排序，不改原数据、不把选择提升为已冻结值', () => {
    const rows = [row('D2'), row('D1')], before = structuredClone(rows);
    expect(bandwidthConfirmation(rows, { D2: draft(), D1: draft(0.5) })).toEqual([
      { deviceId: 'D1', before: null, bandwidthKhz: 0.5 }, { deviceId: 'D2', before: null, bandwidthKhz: 2.4 },
    ]); expect(rows).toEqual(before);
  });
  it.each(['missing', 'duplicate', 'model', 'options', 'before', 'permission', 'invalid'] as const)('确认时拒绝变化或无效来源：%s', kind => {
    const rows = [row()], changes = { D1: draft() };
    if (kind === 'missing') rows.length = 0;
    if (kind === 'duplicate') rows.push(row());
    if (kind === 'model') rows[0]!.modelId = 'M2';
    if (kind === 'options') rows[0]!.optionsKhz = [2.4, 3];
    if (kind === 'before') rows[0]!.frozenKhz = 0.5;
    if (kind === 'permission') rows[0]!.editable = false;
    if (kind === 'invalid') changes.D1.value = NaN;
    expect(() => bandwidthConfirmation(rows, changes)).toThrow();
  });
});

describe('覆盖带宽编辑器真实模板（服务未接线）', () => {
  it('初始无勾选/无默认值，展示未选与无资料；没有确认意图或自动计算', async () => {
    const f = await fixture();
    expect(all(f.root, item => String(item.props['aria-label'] ?? '').startsWith('勾选设备 ')).every(item => item.props.checked === false)).toBe(true);
    expect(control(f.root, '设备 D1 带宽').props.value).toBe(''); expect(control(f.root, '设备 D3 带宽').props.value).toBe('');
    expect(control(f.root, '设备 D4 带宽').props.disabled).toBe(true); expect(textOf(f.root)).toContain('无资料');
    expect(f.confirm).not.toHaveBeenCalled(); expect(f.props.rows.every(value => value.frozenKhz === null)).toBe(true);
  });
  it('按型号显式批量应用只形成草稿，预览后确认才发意图，其他型号和原数据不变', async () => {
    const f = await fixture(), before = JSON.stringify(f.props.rows);
    await model(f.root, '筛选带宽型号', 'M1'); await click(f.root, '勾选该型号（2）');
    expect(control(f.root, '批量带宽').props['onUpdate:modelValue']).toBeTypeOf('function');
    await model(f.root, '批量带宽', '2.4'); await click(f.root, '应用到勾选项（2）');
    expect(f.dirty).toHaveBeenLastCalledWith(true); expect(f.confirm).not.toHaveBeenCalled();
    await click(f.root, '确认并提交选择'); expect(f.confirm).not.toHaveBeenCalled();
    await click(f.root, '预览选择'); expect(textOf(f.root)).toContain('D1：未选 → 2.4 kHz'); expect(f.confirm).not.toHaveBeenCalled();
    await click(f.root, '确认并提交选择'); expect(f.confirm).toHaveBeenCalledExactlyOnceWith({ sourceKey: 'frozen-source-1', changes: [
      { deviceId: 'D1', before: null, bandwidthKhz: 2.4 }, { deviceId: 'D2', before: null, bandwidthKhz: 2.4 },
    ] }); expect(JSON.stringify(f.props.rows)).toBe(before); expect(f.dirty).toHaveBeenLastCalledWith(true);
  });
  it('没有显式批量选值不能应用，非法值也不部分应用', async () => {
    const f = await fixture(); await model(f.root, '筛选带宽型号', 'M1'); await click(f.root, '勾选该型号（2）');
    await click(f.root, '应用到勾选项（2）'); expect(textOf(f.root)).toContain('请选择设备对应的合法带宽');
    await model(f.root, '批量带宽', '99'); await click(f.root, '应用到勾选项（2）');
    expect(control(f.root, '设备 D1 带宽').props.value).toBe(''); expect(control(f.root, '设备 D2 带宽').props.value).toBe('');
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it('换筛选不自动应用或丢弃草稿，来源切换清理旧意图且不回放确认', async () => {
    const f = await fixture(); await choose(f.root, 'D1', '0.5');
    await model(f.root, '筛选带宽型号', 'M2'); expect(f.dirty).toHaveBeenLastCalledWith(true);
    await model(f.root, '筛选带宽型号', 'M1'); expect(control(f.root, '设备 D1 带宽').props.value).toBe('0.5');
    await click(f.root, '预览选择'); f.props.sourceKey = 'frozen-source-2'; await flush();
    expect(f.dirty).toHaveBeenLastCalledWith(false); expect(control(f.root, '设备 D1 带宽').props.value).toBe('');
    await click(f.root, '确认并提交选择'); expect(f.confirm).not.toHaveBeenCalled();
  });
  it('已冻结前态变化不能批准旧预览；错误后仍保留本地选择', async () => {
    const f = await fixture(); await choose(f.root, 'D1', '2.4'); await click(f.root, '预览选择');
    f.props.rows[0]!.frozenKhz = 0.5; await flush(); await click(f.root, '确认并提交选择');
    expect(f.confirm).not.toHaveBeenCalled(); expect(textOf(f.root)).toContain('资料或已冻结选择已变化');
    expect(control(f.root, '设备 D1 带宽').props.value).toBe('2.4'); expect(f.dirty).toHaveBeenLastCalledWith(true);
  });
  it.each(['busy', 'loading', 'readonly'] as const)('%s 时即使直接触发旧回调也不能修改或确认', async kind => {
    const f = await fixture(); await choose(f.root, 'D1', '0.5'); await click(f.root, '预览选择');
    if (kind === 'readonly') f.props.writable = false; else f.props[kind] = true;
    await flush(); await choose(f.root, 'D1', '2.4'); await click(f.root, '确认并提交选择');
    expect(f.confirm).not.toHaveBeenCalled(); expect(control(f.root, '设备 D1 带宽').props.value).toBe('0.5');
  });
  it('分页固定20项，翻页仍保留按ID的未确认选择，不生成选择或计算写入', async () => {
    const f = await fixture(Array.from({ length: 25 }, (_, index) => row(`D${index + 1}`)));
    expect(all(f.root, item => item.tag === 'select' && String(item.props['aria-label'] ?? '').startsWith('设备 '))).toHaveLength(20);
    await choose(f.root, 'D1', '2.4'); await click(f.root, '下一页');
    expect(all(f.root, item => item.tag === 'select' && String(item.props['aria-label'] ?? '').startsWith('设备 '))).toHaveLength(5);
    await click(f.root, '上一页'); expect(control(f.root, '设备 D1 带宽').props.value).toBe('2.4'); expect(f.confirm).not.toHaveBeenCalled();
  });
  it('刷新回读的新冻结版本仅展示已保存值和来源，不复用旧草稿为已冻结', async () => {
    const f = await fixture(); await choose(f.root, 'D1', '2.4');
    f.props.rows = [row('D1', { frozenKhz: 0.5, frozenSource: '服务端选择版本 S2' })]; f.props.sourceKey = 'selection-S2'; await flush();
    expect(control(f.root, '设备 D1 带宽').props.value).toBe('0.5'); expect(textOf(f.root)).toContain('服务端选择版本 S2');
    expect(f.dirty).toHaveBeenLastCalledWith(false); expect(f.confirm).not.toHaveBeenCalled();
  });
  it('来源A-B-A后旧设备回调不能在新代次写入意图', async () => {
    const f = await fixture(), old = control(f.root, '设备 D1 带宽').props.onChange as (event: unknown) => void;
    f.props.sourceKey = 'source-B'; await flush(); f.props.sourceKey = 'frozen-source-1'; await flush();
    old({ target: { value: '2.4' } }); await flush();
    expect(control(f.root, '设备 D1 带宽').props.value).toBe(''); expect(f.confirm).not.toHaveBeenCalled();
    expect(f.dirty).toHaveBeenLastCalledWith(false);
  });
  it.each(['__proto__', 'constructor', 'toString'])('设备ID %s 不变成对象原型或默认草稿', async id => {
    const f = await fixture([row(id)]);
    expect(textOf(f.root)).toContain('待确认 0 台'); expect(control(f.root, `设备 ${id} 带宽`).props.value).toBe('');
    await choose(f.root, id, '2.4'); await click(f.root, '预览选择'); await click(f.root, '确认并提交选择');
    expect(f.confirm).toHaveBeenCalledExactlyOnceWith({ sourceKey: 'frozen-source-1', changes: [{ deviceId: id, before: null, bandwidthKhz: 2.4 }] });
  });
  it('尺寸/滚动为稳定声明且不引入服务或覆盖计算依赖', () => {
    const source = readFileSync(new URL('../src/components/FrozenCoverageBandwidthEditor.vue', import.meta.url), 'utf8');
    expect(source).toContain('height: 356px; overflow: auto'); expect(source).toContain('table-layout: fixed');
    expect(source).toContain('height: 144px; overflow: auto'); expect(source).toContain('overflow-anchor: none');
    expect(source).not.toContain('useFrozenCoverage'); expect(source).not.toContain('sessionStorage'); expect(source).not.toContain('fetch(');
  });
});

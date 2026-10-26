import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import FrequencyResourceEditDrawer from '../src/components/FrequencyResourceEditDrawer.vue';
import { all, clientTemplate, node, renderer, textOf, type HostNode } from './helpers/vue-client';
import type { FrequencyResourceItem } from '../src/types/frequency-resource';

vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], setup: (props, { slots }) => () => props.visible ? h('aside', slots.default?.()) : null }) };
});
beforeAll(() => clientTemplate(FrequencyResourceEditDrawer, 'src/components/FrequencyResourceEditDrawer.vue', 'frequency-edit-render.ts'));
let app: App<HostNode> | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.unstubAllGlobals(); });
async function flush() { await nextTick(); await Promise.resolve(); }
async function fixture(mode: 'ADD' | 'PATCH' = 'ADD', busy = false, editable = true) {
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('Document', class {});
  vi.stubGlobal('ShadowRoot', class {});
  const item: FrequencyResourceItem = { freqId: 'FQ-existing', deviceClass: 'HF', centerFreqKhz: 3000, bandwidthKhz: 10,
    channelNo: null, isAvailable: true, occupiedBy: null, reuseMinDistanceM: null, adjacentGuardKhz: null, note: null };
  const preview = vi.fn(), close = vi.fn(), dirty = vi.fn(), root = node('root');
  app = renderer.createApp({ render: () => h(FrequencyResourceEditDrawer, { visible: true, mode, item: mode === 'PATCH' ? item : null,
    busy, editable, error: '', onPreview: preview, onClose: close, onDirtyChange: dirty }) });
  app.provide(ssrContextKey, {}); app.mount(root); await flush();
  return { root, item, preview, close, dirty };
}
async function set(root: HostNode, label: string, value: string) {
  const input = all(root, n => n.props['aria-label'] === label)[0]; expect(input).toBeTruthy();
  (input.props['onUpdate:modelValue'] as (value: string) => void)(value); await flush();
}
async function submit(root: HostNode) {
  const form = all(root, n => n.tag === 'form')[0];
  await (form.props.onSubmit as (event: unknown) => unknown)({ preventDefault() {} }); await flush();
}
describe('构造频点专用维护抽屉', () => {
  it('新增仅提交构造字段，空可选值保留null，不编造占用', async () => {
    const f = await fixture(); await set(f.root, '构造频点编号', 'FQ-new'); await set(f.root, '中心频率 / kHz', '4500'); await submit(f.root);
    expect(f.preview).toHaveBeenCalledWith({ kind: 'ADD', freqId: 'FQ-new', item: { deviceClass: 'HF', centerFreqKhz: 4500,
      bandwidthKhz: null, channelNo: null, reuseMinDistanceM: null, adjacentGuardKhz: null, note: null } });
    expect(textOf(f.root)).toContain('非正式频率授权'); expect(f.dirty).toHaveBeenLastCalledWith(true);
  });
  it('编辑只发净差异，清空可选数值为null，不更改原对象', async () => {
    const f = await fixture('PATCH'); await set(f.root, '带宽 / kHz', ''); await submit(f.root);
    expect(f.preview).toHaveBeenCalledWith({ kind: 'PATCH', freqId: 'FQ-existing', fields: { bandwidthKhz: null } });
    expect(f.item.bandwidthKhz).toBe(10); expect(f.item.occupiedBy).toBeNull();
  });
  it('无修改不提交；编号和类别不可在编辑时变更', async () => {
    const f = await fixture('PATCH'); await submit(f.root); expect(f.preview).not.toHaveBeenCalled();
    expect(textOf(f.root)).toContain('没有需要修改的字段');
    expect(all(f.root, n => n.props['aria-label'] === '构造频点编号')[0].props.disabled).toBe(true);
    expect(all(f.root, n => n.tag === 'select')[0].props.disabled).toBe(true);
  });
  it.each([['中心频率 / kHz', ''], ['中心频率 / kHz', '0'], ['带宽 / kHz', '-1'], ['信道号', '1.5'], ['中心频率 / kHz', 'NaN']])('拒绝无效字段 %s=%s', async (label, value) => {
    const f = await fixture('PATCH'); await set(f.root, label, value); await submit(f.root);
    expect(f.preview).not.toHaveBeenCalled(); expect(all(f.root, n => n.props.role === 'alert')).toHaveLength(1);
  });
  it.each([[true, true], [false, false]])('保存中或无专项权限不发预检：busy=%s editable=%s', async (busy, editable) => {
    const f = await fixture('PATCH', busy, editable); await set(f.root, '中心频率 / kHz', '4500'); await submit(f.root);
    expect(f.preview).not.toHaveBeenCalled(); expect(all(f.root, n => n.tag === 'fieldset')[0].props.disabled).toBe(true);
  });
  it('取消仅发关闭请求，由工作区确认脏草稿，不执行保存', async () => {
    const f = await fixture(); await set(f.root, '构造频点编号', 'draft');
    const cancel = all(f.root, n => n.tag === 'button' && textOf(n) === '取消')[0];
    (cancel.props.onClick as () => void)(); await flush();
    expect(f.close).toHaveBeenCalledOnce(); expect(f.preview).not.toHaveBeenCalled();
  });
});

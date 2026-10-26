import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, reactive, ssrContextKey, type App } from 'vue';
import GisResultLayerPanel from '../src/components/GisResultLayerPanel.vue';
import { defaultGisResultLayers, gisResultLayerRows } from '../src/maps/gis-result-layers';
// 仅复用模板编译，原有宿主、替身和业务交互保持本地。
import { clientTemplate } from './helpers/vue-client';

// 编译实际客户端模板，验证控件绑定和禁用守卫，不以字符串匹配代替事件测试。
const filename = 'src/components/GisResultLayerPanel.vue';
await clientTemplate(GisResultLayerPanel, filename, 'result-layer-render.ts');

interface HostNode { tag: string; text: string; parent: HostNode | null; children: HostNode[]; props: Record<string, unknown> }
const node = (tag: string, text = ''): HostNode => ({ tag, text, parent: null, children: [], props: {} });
function remove(child: HostNode) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; }
function insert(child: HostNode, parent: HostNode, anchor?: HostNode | null) {
  remove(child); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1;
  parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
}
const renderer = createRenderer<HostNode, HostNode>({
  insert, remove, createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (el, text) => { el.text = text; }, setElementText: (el, text) => { el.text = text; el.children = []; },
  parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp: (el, key, _old, value) => { el.props[key] = value; },
  insertStaticContent: (text, parent, anchor) => { const el = node('#static', text); insert(el, parent, anchor); return [el, el]; },
});
const textOf = (root: HostNode): string => (root.tag === '#comment' ? '' : root.text.replace(/<[^>]+>/g, '')) + root.children.map(textOf).join('');

function find(root: HostNode, label: string): HostNode | undefined {
  if (root.props['aria-label'] === label) return root;
  for (const child of root.children) { const result = find(child, label); if (result) return result; }
}
let app: App<HostNode> | undefined;
afterEach(() => { app?.unmount(); app = undefined; });
function mountPanel(mode: 'analysis' | 'diagnosis' = 'analysis') {
  const rows = reactive(gisResultLayerRows({ mode, readable: true, paused: false, deviceMode: false,
    deviceCoverageAvailable: false, interferenceAvailable: true, interferenceFilteredOut: false,
    diagnosisAvailable: true, diagnosisFilteredOut: false,
    regions: [{ id: 'coverage', kind: 'coverage', label: '覆盖', rings: [] }, { id: 'impact', kind: 'impact', label: '示意', rings: [] }],
  }, defaultGisResultLayers()));
  const changed = vi.fn(), root = node('root');
  app = renderer.createApp({ render: () => h(GisResultLayerPanel, { rows, onChange: changed }) });
  app.provide(ssrContextKey, {}); app.mount(root);
  return { rows, changed, root, control: (label: string) => find(root, label)! };
}
describe('GIS 结果图层控制面板', () => {
  it('显示四组平级控件，分析模式只开放原三组且不直接修改传入配置', async () => {
    const s = mountPanel(), before = JSON.stringify(s.rows);
    expect(s.rows).toHaveLength(4);
    for (const row of s.rows.filter(row => row.available)) {
      expect(s.control('显示' + row.label).props.checked).toBe(true);
      (s.control('显示' + row.label).props.onChange as Function)({ target: { checked: false } });
      expect(s.changed).toHaveBeenLastCalledWith(row.id, { visible: false });
      (s.control(row.label + '透明度').props.onInput as Function)({ target: { value: '0.3' } });
      expect(s.changed).toHaveBeenLastCalledWith(row.id, { opacity: 0.3 });
    }
    await nextTick(); expect(JSON.stringify(s.rows)).toBe(before); expect(s.changed).toHaveBeenCalledTimes(6);
    expect(s.control('显示诊断影响区域').props.disabled).toBe(true); expect(s.control('诊断影响区域透明度').props.disabled).toBe(true);
    expect(textOf(s.root)).toContain('进入诊断快照');
    expect(s.control('显示干扰分析影响区域').parent!.props.title).toContain('受扰对象高亮和统计保留');
  });
  it('不可用组禁用两个控件并解释原因，直接触发陈旧事件也不发送变更', async () => {
    const s = mountPanel(); s.rows[0].available = false; s.rows[0].reason = '所选设备暂无可显示的覆盖结果。'; await nextTick();
    const checkbox = s.control('显示信号覆盖'), slider = s.control('信号覆盖透明度');
    expect(checkbox.props.disabled).toBe(true); expect(slider.props.disabled).toBe(true);
    (checkbox.props.onChange as Function)({ target: { checked: false } }); (slider.props.onInput as Function)({ target: { value: '0.1' } });
    expect(s.changed).not.toHaveBeenCalled(); expect(textOf(s.root)).toContain(s.rows[0].reason);
    expect(s.control('显示原有影响示意区域').props.disabled).toBe(false);
  });
  it('隐藏与恢复面板数据保留每组值，零透明度仍可调回', async () => {
    const s = mountPanel(); s.rows[1].visible = false; s.rows[1].opacity = 0; await nextTick();
    expect(s.control('显示干扰分析影响区域').props.checked).toBe(false);
    expect(s.control('干扰分析影响区域透明度').props.value).toBe(0);
    expect(s.control('干扰分析影响区域透明度').props.disabled).toBe(false);
    expect(s.control('信号覆盖透明度').props.value).toBe(0.8);
  });
  it('诊断模式只允许影响区域控件发事件，旧三组禁用且说明独立快照', () => {
    const s = mountPanel('diagnosis');
    for (const row of s.rows) {
      const checkbox = s.control('显示' + row.label), slider = s.control(row.label + '透明度');
      expect(checkbox.props.disabled).toBe(row.id !== 'diagnosis'); expect(slider.props.disabled).toBe(row.id !== 'diagnosis');
      (checkbox.props.onChange as Function)({ target: { checked: false } });
      (slider.props.onInput as Function)({ target: { value: '0' } });
    }
    expect(s.changed.mock.calls).toEqual([['diagnosis', { visible: false }], ['diagnosis', { opacity: 0 }]]);
    expect(s.control('显示诊断影响区域').parent!.props.title).toContain('场景注入、对象高亮和统计保留');
    expect(textOf(s.root)).toContain('诊断快照仅显示该报告');
  });
});


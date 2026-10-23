import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, reactive, ssrContextKey, type App } from 'vue';
import PlanningApiVersionsPanel from '../src/components/PlanningApiVersionsPanel.vue';
import PlanComparisonPanel from '../src/components/PlanComparisonPanel.vue';
import {
  planningComparisonCostSortIssue,
  planningComparisonDefaultDirection,
  sortPlanningComparisonRows,
  type PlanningComparisonSort,
  type PlanningComparisonDirection,
  type PlanningComparisonValues,
} from '../src/services/planning-result-display';
import type { ApiPlan } from '../src/types/planning-api';
import type { PlanVersion } from '../src/types/domain';
// 仅复用模板编译，排序事件与特殊宿主仍在本文件验证。
import { clientTemplate } from './helpers/vue-client';

const models = vi.hoisted(() => ({ planning: null as any, task: null as any, auth: null as any }));
vi.mock('../src/stores/planning-api', () => ({ usePlanningApiStore: () => models.planning }));
vi.mock('../src/stores/task-input', () => ({ useTaskInputStore: () => models.task }));
vi.mock('../src/stores/auth', () => ({ useAuthStore: () => models.auth }));
// 表格只替换渲染宿主；真实组件接收表头事件，差值和比较规则仍执行。
vi.mock('../src/components/AppTable.vue', () => ({ default: { inheritAttrs: false, props: {rows:null,columns:null,sortable:null,controlledSort:Boolean,sortField:null,sortOrder:null}, emits: ['sort'], setup: (props: any, {emit}:any) => () => h('table-probe', { ...props, sort: (field:string)=>emit('sort',{sortField:field}) }) } }));
vi.mock('../src/components/PlanExportDrawer.vue', () => ({ default: { render: () => null } }));

type Row = PlanningComparisonValues & { id: string };
const sample = (): Row[] => [
  { id: 'A', connectivityPercent: 90, totalRadiatedPowerW: 50, survivabilityPercent: 95, deploymentCost: 8, costUnit: '万元' },
  { id: 'B', connectivityPercent: 100, totalRadiatedPowerW: 0, survivabilityPercent: 92, deploymentCost: 12, costUnit: '万元' },
  { id: 'C', connectivityPercent: 100, totalRadiatedPowerW: 20, survivabilityPercent: 99, deploymentCost: null, costUnit: null },
];
const ids = (rows: { id: string }[]) => rows.map(row => row.id);

describe('方案对比仅重排展示行', () => {
  it.each<[PlanningComparisonSort, PlanningComparisonDirection, string[]]>([
    ['connectivityPercent', 'desc', ['B', 'C', 'A']], ['connectivityPercent', 'asc', ['A', 'B', 'C']],
    ['totalRadiatedPowerW', 'asc', ['B', 'C', 'A']], ['totalRadiatedPowerW', 'desc', ['A', 'C', 'B']],
    ['survivabilityPercent', 'desc', ['C', 'A', 'B']], ['survivabilityPercent', 'asc', ['B', 'A', 'C']],
    ['deploymentCost', 'asc', ['A', 'B', 'C']], ['deploymentCost', 'desc', ['B', 'A', 'C']],
  ])('%s / %s 保留零值、同值顺序与成本缺值', (key, direction, expected) => {
    const rows = sample(), before = structuredClone(rows);
    expect(ids(sortPlanningComparisonRows(rows, key, direction))).toEqual(expected);
    expect(rows).toEqual(before);
  });
  it('原顺序返回副本，推荐方向区分百分比与功率成本', () => {
    const rows = sample(), result = sortPlanningComparisonRows(rows, 'original', 'desc');
    expect(result).toEqual(rows); expect(result).not.toBe(rows);
    expect(['connectivityPercent', 'survivabilityPercent'].map(key => planningComparisonDefaultDirection(key as PlanningComparisonSort))).toEqual(['desc', 'desc']);
    expect(['totalRadiatedPowerW', 'deploymentCost'].map(key => planningComparisonDefaultDirection(key as PlanningComparisonSort))).toEqual(['asc', 'asc']);
  });
  it.each<PlanningComparisonDirection>(['asc', 'desc'])('指标缺值与非有限值在 %s 时仍置后', direction => {
    const rows = sample(); rows[0].totalRadiatedPowerW = null; rows[2].totalRadiatedPowerW = NaN;
    expect(ids(sortPlanningComparisonRows(rows, 'totalRadiatedPowerW', direction))).toEqual(['B', 'A', 'C']);
  });
  it('不同成本单位或缺单位不比较数值，全部缺成本有明确原因', () => {
    const rows = sample(); rows[1].costUnit = '元';
    expect(planningComparisonCostSortIssue(rows)).toContain('单位不一致');
    expect(ids(sortPlanningComparisonRows(rows, 'deploymentCost', 'desc'))).toEqual(['A', 'B', 'C']);
    rows[1].costUnit = '';
    expect(planningComparisonCostSortIssue(rows)).toContain('单位未提供');
    expect(planningComparisonCostSortIssue(rows.map(row => ({ ...row, deploymentCost: null })))).toContain('未提供可比较');
  });
});

interface Host { tag: string; tagName: string; text: string; children: Host[]; parent: Host | null; props: Record<string, any>; style: Record<string, string>; value?: unknown; options: Host[]; addEventListener: () => void; removeEventListener: () => void; getRootNode: () => Document }
const node = (tag: string, text = ''): Host => ({ tag, tagName: tag.toUpperCase(), text, children: [], parent: null, props: {}, style: {}, get options() { return this.children.filter(row => row.tag === 'option'); }, addEventListener() {}, removeEventListener() {}, getRootNode: () => document });
function remove(el: Host) { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null; }
const renderer = createRenderer<Host, Host>({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text), remove,
  insert(el, parent, anchor) { remove(el); el.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, el); },
  setText(el, text) { el.text = text; }, setElementText(el, text) { el.text = text; el.children = []; },
  parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp(el, key, _, value) { el.props[key] = value; if (key === 'value') el.value = value; },
  insertStaticContent(text, parent) { const el = node('#static', text); el.parent = parent; parent.children.push(el); return [el, el]; },
});
const all = (root: Host, predicate: (row: Host) => boolean): Host[] => [...(predicate(root) ? [root] : []), ...root.children.flatMap(row => all(row, predicate))];
const textOf = (root: Host): string => root.text + root.children.map(textOf).join('');
const control = (root: Host, label: string) => all(root, row => row.props['aria-label'] === label)[0];
const table = (root: Host) => all(root, row => row.tag === 'table-probe' && row.props.columns.some((column: any) => column.field === 'totalRadiatedPowerW'))[0];
async function sortColumn(root: Host, field: string) { table(root).props.sort(field); await nextTick(); }
const apiPlan = (row: Row): ApiPlan => ({ id: row.id, name: row.id, result: { metrics: { ...row }, deploymentCost: row.deploymentCost, costUnit: row.costUnit ?? '未提供' } } as unknown as ApiPlan);
const legacyPlan = (row: Row): PlanVersion => ({ id: row.id, name: row.id, version: 'V1', taskId: 'T1', metrics: { ...row }, workflow: { deploymentCost: row.deploymentCost, costUnit: row.costUnit ?? '未提供', configuration: { deployment: [] }, checks: [] } } as unknown as PlanVersion);
let app: App | undefined;
beforeAll(async () => {
  for (const [component, name] of [[PlanningApiVersionsPanel, 'PlanningApiVersionsPanel'], [PlanComparisonPanel, 'PlanComparisonPanel']] as const) {
    const filename = `src/components/${name}.vue`;
    await clientTemplate(component, filename, 'comparison-render.ts');
  }
});
afterEach(() => { app?.unmount(); app = undefined; vi.unstubAllGlobals(); });

describe.each(['current', 'history'] as const)('%s 对比入口', kind => {
  async function mount() {
    vi.stubGlobal('document', new EventTarget()); vi.stubGlobal('Document', class {}); vi.stubGlobal('ShadowRoot', class {});
    models.planning = reactive({ comparison: [] as ApiPlan[], plans: null, selectedPlan: null, job: null, notice: '', busy: false, pending: null });
    models.task = reactive({ taskId: 'T1', auxiliary: {} }); models.auth = { can: () => false, generation: 1 };
    const props = reactive({ plans: sample().map(legacyPlan), comparison: [] as PlanVersion[], error: '', disabled: false, onSelect: vi.fn(), onCompare: vi.fn() });
    const root = node('root');
    app = renderer.createApp({ render: () => kind === 'current' ? h(PlanningApiVersionsPanel) : h(PlanComparisonPanel, props) });
    app.provide(ssrContextKey, { modules: new Set() }); app.mount(root);
    const replace = async (values = sample()) => { if (kind === 'current') models.planning.comparison = values.map(apiPlan); else props.comparison = values.map(legacyPlan); await nextTick(); };
    await replace(); return { root, props, replace };
  }
  it('默认原顺序，四指标推荐方向和反向均生效，差值始终基于首选版本', async () => {
    const { root, props, replace } = await mount();
    expect(ids(table(root).props.rows)).toEqual(['A', 'B', 'C']);expect(table(root).props.sortField).toBeUndefined();
    for (const [key, expected] of [
      ['connectivityPercent', ['B', 'C', 'A']], ['totalRadiatedPowerW', ['B', 'C', 'A']],
      ['survivabilityPercent', ['C', 'A', 'B']], ['deploymentCost', ['A', 'B', 'C']],
    ] as const) {
      await sortColumn(root, key);
      expect(ids(table(root).props.rows)).toEqual(expected);expect(table(root).props.sortField).toBe(key);
    }
    await sortColumn(root, 'deploymentCost');expect(ids(table(root).props.rows)).toEqual(['B', 'A', 'C']);
    expect(table(root).props.rows.find((row: any) => row.id === 'B').deltaPower).toBe(-50);
    expect(table(root).props.controlledSort).toBe(true);expect(table(root).props.columns.filter((column:any)=>column.sortable).map((column:any)=>column.field)).toEqual(['connectivityPercent','totalRadiatedPowerW','survivabilityPercent','deploymentCost']);expect(props.onSelect).not.toHaveBeenCalled();expect(props.onCompare).not.toHaveBeenCalled();
    await sortColumn(root, 'deploymentCost');expect(ids(table(root).props.rows)).toEqual(['A','B','C']);expect(table(root).props.sortField).toBeUndefined();
    const source = kind === 'current' ? models.planning.comparison : props.comparison;
    expect(ids(source)).toEqual(['A', 'B', 'C']);
    // 在排序生效时更换比较对象，验证恢复原序但保留当前方向。
    await sortColumn(root, 'survivabilityPercent');
    expect(table(root).props.sortField).toBe('survivabilityPercent');expect(table(root).props.sortOrder).toBe(-1);
    await replace([sample()[2], sample()[0]]);
    expect(table(root).props.sortField).toBeUndefined();expect(ids(table(root).props.rows)).toEqual(['C', 'A']);expect(control(root, '方案对比排序依据')).toBeUndefined();
    expect(table(root).props.sortOrder).toBe(-1);
  });
  it('成本单位不一致会关闭该列表头排序并提示，其他指标仍可排序', async () => {
    const { root, replace } = await mount();await sortColumn(root, 'deploymentCost');
    const values = sample(); values[1].costUnit = '元'; await replace(values);
    expect(table(root).props.sortField).toBeUndefined();expect(table(root).props.columns.find((column:any)=>column.field==='deploymentCost').sortable).toBe(false);
    expect(textOf(root)).toContain('部署成本单位不一致');
    await sortColumn(root,'deploymentCost');expect(table(root).props.sortField).toBeUndefined();
    await sortColumn(root,'totalRadiatedPowerW');expect(ids(table(root).props.rows)).toEqual(['B', 'C', 'A']);
  });
});

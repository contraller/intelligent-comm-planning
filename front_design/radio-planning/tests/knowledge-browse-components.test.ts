import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ssrContextKey, type App, type Component, type ComponentOptions } from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
import KnowledgeView from '../src/views/KnowledgeView.vue';
import KnowledgeGraphPanel from '../src/components/KnowledgeGraphPanel.vue';
import RequestState from '../src/components/RequestState.vue';
import { useKnowledgeStore } from '../src/stores/knowledge';
import { previewService } from '../src/services';
import { createKnowledgeMock } from '../src/services/knowledge-mock';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';

// 只替换 ECharts 画布宿主；实际页面、图谱组件、模型、store 与 Mock 查询共同运行。
const probes=vi.hoisted(()=>({charts:[] as {setOption:ReturnType<typeof vi.fn>;on:ReturnType<typeof vi.fn>;resize:ReturnType<typeof vi.fn>;dispose:ReturnType<typeof vi.fn>}[],disconnect:vi.fn()}));
vi.mock('echarts/core',()=>({use:vi.fn(),init:vi.fn(()=>{
  const chart={setOption:vi.fn(),on:vi.fn(),resize:vi.fn(),dispose:vi.fn()};probes.charts.push(chart);return chart;
})}));
vi.mock('../src/components/KnowledgeChangeDrawer.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/KnowledgeVersionDrawer.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/KnowledgePrincipleFlow.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
// 在内存宿主执行真实客户端模板；不把宿主事件验证当作浏览器视觉验收。
async function clientTemplate(component: Component, filename: string) {
  const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor;
  const bindings = compileScript(descriptor, { id: filename }).bindings;
  const result = compileTemplate({ source: descriptor.template!.content, filename, id: filename, compilerOptions: { mode: 'function', bindingMetadata: bindings } });
  if (result.errors.length) throw new Error(result.errors.map(String).join('\n'));
  const { code } = await transformWithEsbuild(`function createRender(Vue) { ${result.code} }`, 'knowledge-render.ts', { loader: 'ts' });
  (component as ComponentOptions).render = new Function('Vue', code + ';return createRender(Vue);')(Vue);
}
interface HostNode {
  tag: string; tagName: string; text: string; parent: HostNode | null; children: HostNode[];
  props: Record<string, unknown>; style: Record<string, string>; value?: unknown; readonly options: HostNode[];
  addEventListener: () => void; removeEventListener: () => void; getRootNode: () => Document;
}
const node = (tag: string, text = ''): HostNode => ({ tag, tagName: tag.toUpperCase(), text, parent: null, children: [], props: {}, style: {},
  get options() { return this.children.filter(child => child.tag === 'option'); },
  addEventListener() {}, removeEventListener() {}, getRootNode: () => document });
function remove(child: HostNode) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; }
function insert(child: HostNode, parent: HostNode, anchor?: HostNode | null) {
  remove(child); child.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1;
  parent.children.splice(i < 0 ? parent.children.length : i, 0, child);
}
const renderer = createRenderer<HostNode, HostNode>({
  insert, remove, createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (el, text) => { el.text = text; }, setElementText: (el, text) => { el.text = text; el.children = []; },
  parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp: (el, key, _old, value) => { el.props[key] = value; },
  insertStaticContent: (text, parent, anchor) => { const el = node('#static', text); insert(el, parent, anchor); return [el, el]; },
});
function find(root: HostNode, predicate: (n: HostNode) => boolean): HostNode | undefined {
  if (predicate(root)) return root;
  for (const child of root.children) { const hit = find(child, predicate); if (hit) return hit; }
}
function all(root: HostNode, predicate: (n: HostNode) => boolean): HostNode[] {
  return [...(predicate(root) ? [root] : []),...root.children.flatMap(child => all(child,predicate))];
}
const textOf = (root: HostNode): string => root.text.replace(/<[^>]+>/g, '') + root.children.map(textOf).join('');
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}

async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }


await Promise.all([
  clientTemplate(KnowledgeView,'src/views/KnowledgeView.vue'),
  clientTemplate(KnowledgeGraphPanel,'src/components/KnowledgeGraphPanel.vue'),
  clientTemplate(RequestState,'src/components/RequestState.vue'),
]);
let app:App<HostNode>|undefined,pinia:ReturnType<typeof createPinia>|undefined;
afterEach(()=>{app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();probes.charts.length=0;probes.disconnect.mockClear();});
async function mountPage(path='/') {
  class TestDocument extends EventTarget { activeElement=null; }
  vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());vi.stubGlobal('window',new EventTarget());
  vi.stubGlobal('ResizeObserver',class { observe() {} disconnect(){probes.disconnect();} });
  pinia=createPinia();setActivePinia(pinia);authorizeStore('kg_editor');
  const storage=new TestStorage(),service=createKnowledgeMock(()=>storage);
  for(const key of Object.keys(service) as (keyof typeof service)[])vi.spyOn(previewService,key).mockImplementation(service[key] as never);
  const store=useKnowledgeStore(),router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:KnowledgeView}]});
  await router.push(path);await router.isReady();
  const root=node('root');app=renderer.createApp({render:()=>h(RouterView)});app.use(pinia);app.use(router);app.provide(ssrContextKey,{});
  app.mount(root);await settle();return {root,store,storage,service,router};
}
const latestChart=()=>probes.charts.at(-1)!;
const graphNodes=()=>latestChart().setOption.mock.calls.at(-1)![0].series[0].data as {id:string;symbolSize:number;itemStyle:{borderWidth:number;borderColor:string;opacity:number}}[];
const detail=(root:HostNode)=>find(root,n=>n.props.class==='kg-detail')!;
async function typeKeyword(root:HostNode,value:string) {
  const input=find(root,n=>n.tag==='input'&&n.props.placeholder==='名称、编号、关键词、描述或步骤')!;
  (input.props['onUpdate:modelValue'] as (value:string)=>void)(value);await settle();
}
// 检索按钮与回车均提交同一原生 form；这里只验证真实提交处理器，不冒充浏览器默认行为。
async function submit(root:HostNode) {
  const form=find(root,n=>n.tag==='form')!,preventDefault=vi.fn();
  await (form.props.onSubmit as (event:unknown)=>Promise<void>)({preventDefault});await settle();
  expect(preventDefault).toHaveBeenCalled();
}
async function chooseType(root:HostNode,value:string) {
  const select=find(root,n=>n.tag==='select')!;
  (select.props['onUpdate:modelValue'] as (value:string)=>void)(value);
  await (select.props.onChange as ()=>Promise<void>)();await settle();
}
async function category(root:HostNode,name:string,checked:boolean) {
  const label=find(root,n=>n.tag==='label'&&n.props.class==='kg-category'&&textOf(n).includes(name))!;
  const input=find(label,n=>n.tag==='input')!;
  await (input.props.onChange as (event:unknown)=>Promise<void>)({target:{checked}});await settle();
}
async function selectList(root:HostNode,id:string) {
  const button=find(root,n=>n.tag==='button'&&textOf(n).includes(id))!;
  await (button.props.onClick as ()=>Promise<void>)();await settle();
}
async function graphClick(id:string,dataType='node') {
  const onClick=latestChart().on.mock.calls.find(call=>call[0]==='click')![1];
  onClick({data:{id},dataType});await settle();
}

describe('知识图谱实际页面检索联动',()=>{
  it('输入不查询，提交后唯一命中自动居中并显示同一实体详情',async()=>{
    const {root,store,storage}=await mountPage();
    expect(store.selectedId).toBe('');expect(graphNodes().every(n=>n.itemStyle.borderWidth===1)).toBe(true);
    const search=vi.mocked(previewService.searchKnowledge);search.mockClear();
    await typeKeyword(root,'  KGE-POWER  ');
    expect(search).not.toHaveBeenCalled();expect(store.query).toBe('');expect(textOf(root)).toContain('输入尚未检索');
    await submit(root);
    expect(store.selectedId).toBe('KGE-POWER');expect(textOf(detail(root))).toContain('功率放大模块');
    expect(graphNodes().find(n=>n.id==='KGE-POWER')).toMatchObject({symbolSize:76,itemStyle:{borderColor:'#eef9ff',opacity:1}});
    expect(search.mock.calls[0][0].query).toBe('KGE-POWER');expect(storage.writes).toBe(0);
    await typeKeyword(root,' KGE-POWER ');await submit(root);
    expect(textOf(root)).not.toContain('输入尚未检索');
  });
  it('多命中高亮概览，点选列表后才显示具体详情',async()=>{
    const {root,store}=await mountPage();await typeKeyword(root,'KGE-STATE-');await submit(root);
    expect(store.search!.total).toBe(4);expect(store.selectedId).toBe('');expect(textOf(detail(root))).toContain('选择实体或关系');
    expect(graphNodes()).toHaveLength(4);expect(graphNodes().every(n=>n.itemStyle.borderColor==='#f0ce79')).toBe(true);
    expect(textOf(root)).toContain('已高亮当前显示的命中节点');
    await selectList(root,'KGE-STATE-GOOD');
    expect(store.selectedId).toBe('KGE-STATE-GOOD');expect(textOf(detail(root))).toContain('良好状态');
    expect(graphNodes().find(n=>n.id==='KGE-RULE')!.itemStyle.opacity).toBe(0.55);
  });
  it('图上实体、关系使用原 ID 联动详情，重置清理详情并恢复命中概览',async()=>{
    const {root,store}=await mountPage();await typeKeyword(root,'KGE-STATE-');await submit(root);
    await graphClick('KGE-STATE-GOOD');expect(store.detail!.entity.id).toBe('KGE-STATE-GOOD');
    const edge=store.graph!.relations[0];await graphClick(edge.id,'edge');
    expect(textOf(detail(root))).toContain(edge.id);expect(store.relationId).toBe(edge.id);
    await click(root,'返回概览 / 重置视图');await settle();
    expect(store.selectedId).toBe('');expect(store.relationId).toBe('');expect(store.detail).toBeNull();
    expect(store.query).toBe('KGE-STATE-');expect(graphNodes().every(n=>n.itemStyle.borderColor==='#f0ce79')).toBe(true);
    expect(latestChart().setOption.mock.calls.at(-1)![1]).toBe(true);
  });
  it('分类/类型变化沿用已提交词，未提交的文字不会随筛选生效',async()=>{
    const {root,store}=await mountPage();await typeKeyword(root,'KGE-POWER');await submit(root);
    await typeKeyword(root,'KGE-LINK');await chooseType(root,'Component');
    expect(store.query).toBe('KGE-POWER');expect(store.selectedId).toBe('KGE-POWER');
    await category(root,'设备知识',false);
    expect(store.type).toBe('');expect(store.query).toBe('KGE-POWER');expect(store.search!.total).toBe(0);
    expect(store.detail).toBeNull();expect(textOf(detail(root))).not.toContain('功率放大模块');
    await submit(root);expect(store.query).toBe('KGE-LINK');expect(store.selectedId).toBe('KGE-LINK');
  });
  it('翻页不提交输入中关键词，末页一项不自动选中，重置也不提交',async()=>{
    const {root,store}=await mountPage();await submit(root);await typeKeyword(root,'KGE-POWER');
    await click(root,'下一页');await settle();
    expect(store.page).toBe(2);expect(store.search!.items).toHaveLength(1);expect(store.selectedId).toBe('');
    expect(store.query).toBe('');expect(graphNodes()).toHaveLength(21);
    await click(root,'返回概览 / 重置视图');await settle();
    expect(store.query).toBe('');expect(store.selectedId).toBe('');expect(textOf(root)).toContain('输入尚未检索');
  });
  it('无结果展示推荐，推荐仍需点击；检索异常不显示成零命中，重试恢复聚焦',async()=>{
    const {root,store}=await mountPage();await typeKeyword(root,'发烫');await submit(root);
    expect(textOf(root)).toContain('未找到匹配实体');expect(textOf(root)).toContain('相似知识推荐');
    expect(store.selectedId).toBe('');await click(root,'功放过温现象');await settle();
    expect(store.detail!.entity.id).toBe('KGE-SYMPTOM');
    vi.mocked(previewService.searchKnowledge).mockRejectedValueOnce(new Error('搜索读取失败'));
    await typeKeyword(root,'KGE-POWER');await submit(root);
    expect(textOf(root)).toContain('搜索读取失败');expect(textOf(root)).toContain('检索结果未就绪');
    expect(textOf(root)).not.toContain('匹配 0 个实体');expect(textOf(detail(root))).not.toContain('功放过温现象');
    await click(root,'重试');await settle();expect(store.detail!.entity.id).toBe('KGE-POWER');
  });
  it('单命中重置返回命中概览，展开/收起不提交草拟检索词',async()=>{
    const {root,store}=await mountPage();await typeKeyword(root,'KGE-POWER');await submit(root);
    await typeKeyword(root,'KGE-LINK');await click(root,'收起上次展开');await click(root,'展开选中实体一跳');await settle();
    expect(store.query).toBe('KGE-POWER');expect(store.selectedId).toBe('KGE-POWER');
    await click(root,'返回概览 / 重置视图');await settle();
    expect(store.selectedId).toBe('');expect(store.detail).toBeNull();
    expect(graphNodes()).toHaveLength(1);expect(graphNodes()[0].itemStyle.borderColor).toBe('#f0ce79');
  });
  it('路由入口明确定位实体；失效入口不会自动替换为首个实体',async()=>{
    const {root,store,router}=await mountPage('/?entityId=KGE-LINK');
    expect(store.selectedId).toBe('KGE-LINK');expect(textOf(detail(root))).toContain('通信链路');
    await router.push('/?entityId=missing');await settle();
    expect(store.selectedId).toBe('missing');expect(store.queryError).toBeTruthy();expect(store.detail).toBeNull();
  });
  it('离开组件释放图谱与观察器，浏览不会写入知识版本',async()=>{
    const {storage}=await mountPage(),chart=latestChart();
    app!.unmount();app=undefined;
    expect(chart.dispose).toHaveBeenCalledTimes(1);expect(probes.disconnect).toHaveBeenCalled();expect(storage.writes).toBe(0);
  });
});

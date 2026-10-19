import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, reactive, ssrContextKey, type App, type Component, type ComponentOptions } from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
import KnowledgeNetworkRulePanel from '../src/components/KnowledgeNetworkRulePanel.vue';
import KnowledgeNetworkRuleEditor from '../src/components/KnowledgeNetworkRuleEditor.vue';
import KnowledgeChangeDrawer from '../src/components/KnowledgeChangeDrawer.vue';
import KnowledgeVersionDrawer from '../src/components/KnowledgeVersionDrawer.vue';
import KnowledgeView from '../src/views/KnowledgeView.vue';
import { networkRuleSeed, networkRuleTeaching } from '../src/mocks/knowledge-network-rules';
import { useKnowledgeStore } from '../src/stores/knowledge';
import { createKnowledgeMock } from '../src/services/knowledge-mock';
import { previewService } from '../src/services';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
import type { KnowledgeEntity, KnowledgeNetworkRule } from '../src/types/knowledge';

vi.mock('../src/components/AppDrawer.vue', async()=>{const {h}=await import('vue');return {default:{props:['visible'],setup:(p:any,{slots}:any)=>()=>p.visible?h('drawer-probe',[slots.default?.(),slots.footer?.()]):null}};});
vi.mock('../src/components/KnowledgeGraphPanel.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/KnowledgePrincipleFlow.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/KnowledgePrincipleEditor.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/KnowledgeStateBadge.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/AppTable.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{render:()=>null}}));
// 页面及规则编辑器使用真实模板，图表和抽屉外壳不依赖浏览器 DOM。
async function clientTemplate(component: Component, filename: string) {
  const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor;
  const bindings = compileScript(descriptor, { id: filename }).bindings;
  const result = compileTemplate({ source: descriptor.template!.content, filename, id: filename, compilerOptions: { mode: 'function', bindingMetadata: bindings } });
  if (result.errors.length) throw new Error(result.errors.map(String).join('\n'));
  const { code } = await transformWithEsbuild(`function createRender(Vue) { ${result.code} }`, 'knowledge-rule-render.ts', { loader: 'ts' });
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
  clientTemplate(KnowledgeNetworkRulePanel,'src/components/KnowledgeNetworkRulePanel.vue'),
  clientTemplate(KnowledgeNetworkRuleEditor,'src/components/KnowledgeNetworkRuleEditor.vue'),
  clientTemplate(KnowledgeChangeDrawer,'src/components/KnowledgeChangeDrawer.vue'),
  clientTemplate(KnowledgeVersionDrawer,'src/components/KnowledgeVersionDrawer.vue'),
  clientTemplate(KnowledgeView,'src/views/KnowledgeView.vue'),
]);
let app:App<HostNode>|undefined,pinia:ReturnType<typeof createPinia>|undefined;
afterEach(()=>{app?.unmount();app=undefined;if(pinia)disposePinia(pinia);vi.restoreAllMocks();vi.unstubAllGlobals();});
async function setup(){
  class TestDocument extends EventTarget { activeElement=null; }
  vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());vi.stubGlobal('window',new EventTarget());
  pinia=createPinia();setActivePinia(pinia);const auth=authorizeStore('kg_editor'),storage=new TestStorage(),service=createKnowledgeMock(()=>storage);
  for(const name of Object.keys(service) as (keyof typeof service)[])vi.spyOn(previewService,name).mockImplementation(service[name] as never);
  const store=useKnowledgeStore();await store.load();
  async function mount(component:Component){
    app=renderer.createApp(component);app.use(pinia!);app.provide(ssrContextKey,{});
    const root=node('root');app.mount(root);await settle();return root;
  }
  return {auth,storage,store,service,mount};
}
async function field(root:HostNode,label:string,value:string){
  const input=find(root,n=>n.props['aria-label']===label)!;expect(input,label).toBeDefined();
  (input.props.onInput as (e:any)=>void)({target:{value}});await settle();
}
describe('网络规则实际模板与维护入口',()=>{
  it('同草稿删除行或整个规则后，旧事件不能污染后续行或重建规则',async()=>{
    const s=await setup(),props=reactive({entity:structuredClone(networkRuleSeed) as KnowledgeEntity,readonly:false,context:'同一草稿'});
    const root=await s.mount({render:()=>h(KnowledgeNetworkRuleEditor,{...props,'onUpdate:rule':(v:KnowledgeNetworkRule|null)=>{props.entity.networkRule=v;}})});
    const enable=find(root,n=>n.tag==='button'&&textOf(n)==='采用教学内容')!.props.onClick as ()=>void;
    enable();await settle();
    const oldRow=find(root,n=>n.props['aria-label']==='变化 1 说明')!.props.onInput as (e:any)=>void;
    await click(root,'移除此变化说明');const preserved=props.entity.networkRule!.transitions[0].description;
    oldRow({target:{value:'被删除行的迟到输入'}});expect(props.entity.networkRule!.transitions[0].description).toBe(preserved);
    await click(root,'移除规则说明');enable();expect(props.entity.networkRule).toBeNull();
  });
  it('查看不改草稿，明确采用后维护，移除不会重新出现教学附件',async()=>{
    const s=await setup(),props=reactive({entity:structuredClone(networkRuleSeed),readonly:false,context:'草稿 A'});
    const root=await s.mount({render:()=>h(KnowledgeNetworkRuleEditor,{...props,'onUpdate:rule':(v:KnowledgeNetworkRule|null)=>{props.entity.networkRule=v;}})});
    expect(textOf(root)).toContain('不是该历史版本内保存的规则');expect(props.entity.networkRule).toBeUndefined();
    await click(root,'采用教学内容');expect(props.entity.networkRule?.criteria).toHaveLength(4);
    await field(root,'规则适用范围','页面新范围');expect(props.entity.networkRule!.scope).toBe('页面新范围');
    await click(root,'添加状态变化说明');expect(props.entity.networkRule!.transitions).toHaveLength(3);
    await click(root,'移除规则说明');expect(props.entity.networkRule).toBeNull();expect(textOf(root)).toContain('已明确移除');
    expect(textOf(root)).not.toContain('采用教学内容');expect(s.storage.writes).toBe(0);
  });
  it('旧对象、旧修订和失权事件不可写入新草稿；无效内容保留提示',async()=>{
    const s=await setup(),props=reactive({entity:{...structuredClone(networkRuleSeed),networkRule:structuredClone(networkRuleTeaching)} as KnowledgeEntity,readonly:false,context:'修订 1'});
    const root=await s.mount({render:()=>h(KnowledgeNetworkRuleEditor,{...props,'onUpdate:rule':(v:KnowledgeNetworkRule|null)=>{props.entity.networkRule=v;}})});
    const old=find(root,n=>n.props['aria-label']==='规则适用范围')!.props.onInput as (e:any)=>void;
    props.context='修订 2';await settle();old({target:{value:'旧修订污染'}});expect(props.entity.networkRule!.scope).not.toBe('旧修订污染');
    await field(root,'规则适用范围','');expect(props.entity.networkRule!.scope).toBe('');expect(textOf(root)).toContain('适用范围须为');
    const event=find(root,n=>n.props['aria-label']==='规则来源')!.props.onInput as (e:any)=>void;
    s.auth.accept({...s.auth.identity!,permissions:s.auth.identity!.permissions.filter(p=>p!=='knowledge.edit')});await settle();
    event({target:{value:'失权污染'}});expect(props.entity.networkRule!.source).not.toBe('失权污染');
    authorizeStore('kg_editor');props.entity.type='Metric';await settle();expect(textOf(root)).toContain('先移除不适用内容');
    expect(props.entity.networkRule).not.toBeNull();await click(root,'移除规则说明');expect(props.entity.networkRule).toBeNull();
  });
  it('变更抽屉预览和未保存保护包含新字段，历史抽屉固定显示旧版',async()=>{
    const s=await setup();await s.store.newChange(s.store.current!.entities.find(e=>e.id==='KGE-RULE'));
    const root=await s.mount({render:()=>h('div',[h(KnowledgeChangeDrawer),h(KnowledgeVersionDrawer)])});
    expect(s.store.dirtyDraft).toBe(false);await click(root,'采用教学内容');expect(s.store.dirtyDraft).toBe(true);
    await field(root,'规则适用范围','草稿特有说明');expect(textOf(root)).toContain('版本内内容');expect(textOf(root)).toContain('草稿特有说明');
    const closing=s.store.closeDrawer();await settle();expect(s.store.decision?.title).toContain('未保存');
    s.store.answer('cancel');await closing;expect(s.store.draft!.entities[0].networkRule!.scope).toBe('草稿特有说明');
    s.store.draft!.summary='补充规则说明';await click(root,'保存草稿');expect(s.store.error).toBe('');expect(s.store.dirtyDraft).toBe(false);
    const saved=s.store.change!.content.entities[0];expect(saved.networkRule!.scope).toBe('草稿特有说明');
    await s.store.closeDrawer();s.store.historyVersionId=s.store.current!.id;await settle();
    expect(textOf(root)).not.toContain('草稿特有说明');expect(textOf(root)).toContain('独立教学补充');
  });
  it('当前知识页检索补充说明并显示来源，切实体不会借用旧说明',async()=>{
    const s=await setup(),router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:KnowledgeView}]});
    await router.push('/');await router.isReady();
    app=renderer.createApp({render:()=>h(RouterView)});app.use(pinia!);app.use(router);app.provide(ssrContextKey,{});
    const root=node('root');app.mount(root);await settle();await s.store.applyFilters('深衰落');await settle();
    expect(s.store.selectedId).toBe('KGE-RULE');expect(textOf(root)).toContain('网络状态规则说明');expect(textOf(root)).toContain('L629–649');
    await s.store.selectEntity('KGE-METRIC',true);await settle();expect(find(root,n=>n.props['aria-label']==='网络状态规则说明')).toBeUndefined();
    expect(s.storage.writes).toBe(0);
  });
  it('仅查看权限时不能维护，规则文本中的脚本不会执行',async()=>{
    const s=await setup(),props=reactive({entity:{...structuredClone(networkRuleSeed),networkRule:structuredClone(networkRuleTeaching)},readonly:true,context:'审核预览'});
    props.entity.networkRule.criteria[0].condition='globalThis.__knowledgeRuleExecuted = true';
    const root=await s.mount({render:()=>h(KnowledgeNetworkRuleEditor,props)});
    expect(textOf(root)).toContain('globalThis.__knowledgeRuleExecuted');expect(find(root,n=>n.tag==='button'&&textOf(n)==='移除规则说明')).toBeUndefined();
    expect((globalThis as Record<string,unknown>).__knowledgeRuleExecuted).toBeUndefined();
    s.auth.accept({...s.auth.identity!,permissions:[]});await settle();
    expect(find(root,n=>n.props['aria-label']==='网络状态规则说明')).toBeUndefined();
  });
});

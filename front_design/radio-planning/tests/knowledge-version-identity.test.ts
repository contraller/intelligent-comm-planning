import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ssrContextKey, type App, type Component, type ComponentOptions } from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import { createMockService } from '../src/services/mock';
import { TestStorage } from './helpers/storage';
import { previewService } from '../src/services';

import KnowledgeVersionDrawer from '../src/components/KnowledgeVersionDrawer.vue';
import { useKnowledgeStore } from '../src/stores/knowledge';
// 保留实际版本模板，第三方抽屉只替换 DOM 外壳。
vi.mock('../src/components/AppDrawer.vue',()=>({default:Vue.defineComponent({props:['visible'],setup:(p,{slots})=>()=>p.visible?Vue.h('aside',slots.default?.()):null})}));
vi.mock('../src/components/KnowledgePrincipleFlow.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/KnowledgeNetworkRulePanel.vue',()=>({default:{render:()=>null}}));
async function clientTemplate(component: Component, filename: string) {
  const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor;
  const bindings = compileScript(descriptor, { id: filename }).bindings;
  const result = compileTemplate({ source: descriptor.template!.content, filename, id: filename, compilerOptions: { mode: 'function', bindingMetadata: bindings } });
  if (result.errors.length) throw new Error(result.errors.map(String).join('\n'));
  const { code } = await transformWithEsbuild(`function createRender(Vue) { ${result.code} }`, 'resource-ledger-render.ts', { loader: 'ts' });
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


let app:App|undefined,pinia:ReturnType<typeof createPinia>;
beforeAll(()=>clientTemplate(KnowledgeVersionDrawer,'src/components/KnowledgeVersionDrawer.vue'));
afterEach(()=>{app?.unmount();if(pinia)disposePinia(pinia);vi.restoreAllMocks();});
async function setup(){pinia=createPinia();setActivePinia(pinia);authorizeStore();const raw=createMockService(()=>new TestStorage()),seed=await raw.loadKnowledgeWorkspace();const store=useKnowledgeStore();store.workspace=seed.workspace;const {workspace: _workspace,error: _error,...catalog}=seed;store.catalog=catalog;const v=store.workspace!.versions[0]!;v.changeId='rename';store.historyVersionId=v.id;
 store.catalog.actors=[{id:'same',name:'当前目录姓名',role:'EDITOR'}] as any;
 store.workspace!.changes=[{id:'rename',submissions:[{number:1,revision:1,actorId:'same',time:'第一次提交',outcome:'REJECTED',review:{actorId:'same',opinion:'第一次驳回'}},{number:2,revision:2,actorId:'same',time:'第二次提交',outcome:'APPROVED',review:{actorId:'same',opinion:'第二次通过'}},{number:3,revision:3,actorId:'same',time:'待审核',outcome:'PENDING'}]}] as any;
 store.workspace!.identitySnapshots=[{id:'same',key:'submit:rename:1',name:'首次提交姓名'},{id:'same',key:'review:rename:1',name:'首次审核姓名'},{id:'same',key:'submit:rename:2',name:'二次提交姓名'},{id:'same',key:'review:rename:2',name:'二次审核姓名'}] as any;
 const root=node('root');app=renderer.createApp({render:()=>h(KnowledgeVersionDrawer)});app.provide(ssrContextKey,{modules:new Set()});app.mount(root);await settle();return {store,root};}
describe('知识历史版本身份显示',()=>{
 it('同一账号多轮提交审核使用各事件姓名，后续改名不覆盖',async()=>{const s=await setup(),before=JSON.stringify(s.store.workspace);const text=textOf(s.root);for(const name of ['首次提交姓名','首次审核姓名','二次提交姓名','二次审核姓名'])expect(text).toContain(name);s.store.catalog.actors[0]!.name='又一次改名';await settle();expect(textOf(s.root)).toContain('首次提交姓名');expect(textOf(s.root)).toContain('二次审核姓名');expect(JSON.stringify(s.store.workspace)).toBe(before);});
 it('没有审核显示未审核；旧事件无快照沿目录回退',async()=>{const s=await setup();expect(textOf(s.root)).toContain('未审核');expect(textOf(s.root)).toContain('当前目录姓名');s.store.workspace!.identitySnapshots=[];await settle();expect(textOf(s.root)).not.toContain('首次提交姓名');expect(textOf(s.root)).toContain('当前目录姓名');});
});


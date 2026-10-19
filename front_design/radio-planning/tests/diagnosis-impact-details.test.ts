import { afterEach,beforeAll,describe,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer,h,nextTick,ref,ssrContextKey,type App,type Component,type ComponentOptions } from 'vue';
import { parse,compileScript,compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia,setActivePinia,disposePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import DiagnosisResultPanel from '../src/components/DiagnosisResultPanel.vue';
import { diagnosisPresets } from '../src/mocks/diagnosis-presets';
vi.mock('../src/components/DiagnosisRootCausePanel.vue',()=>({default:{render:()=>null}}));
// 编译实际模板并执行事件；渲染宿主不模拟业务判断。
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


const apps:App[]=[],sessions:ReturnType<typeof createPinia>[]=[];
function mount(ready=true){const pinia=createPinia();setActivePinia(pinia);sessions.push(pinia);authorizeStore();
 const result=ref(structuredClone(diagnosisPresets[0].result)),impactReady=ref(ready),locate=vi.fn(),root=node('root');
 const app=renderer.createApp({render:()=>h(DiagnosisResultPanel,{result:result.value,impactReady:impactReady.value,reportReady:true,exporting:false,onLocate:locate})});
 app.provide(ssrContextKey,{modules:new Set()});app.mount(root);apps.push(app);return{result,impactReady,locate,root};
}
beforeAll(()=>clientTemplate(DiagnosisResultPanel,'src/components/DiagnosisResultPanel.vue'));
afterEach(()=>{apps.splice(0).forEach(app=>app.unmount());sessions.splice(0).forEach(disposePinia);vi.restoreAllMocks();});
describe('诊断影响页实际展示',()=>{
 it('直接显示服务统计，节点数组长度不替代返回值',async()=>{const s=mount();s.result.value.summary!.interruptedNodeCount=99;s.result.value.summary!.degradedNodeCount=47;s.result.value.summary!.affectedDemandIds=['REQ-A','REQ-B'];await click(s.root,'影响');expect(textOf(s.root)).toContain('中断节点 99 / 性能降级节点 47');expect(textOf(s.root)).toContain('受影响必要通联需求：REQ-A、REQ-B');});
 it('0、空需求、false和缺失主干属性分别显示',async()=>{const s=mount();Object.assign(s.result.value.summary!,{interruptedNodeCount:0,degradedNodeCount:0,affectedDemandIds:[]});s.result.value.links[0].isBackbone=false;await click(s.root,'影响');expect(textOf(s.root)).toContain('中断节点 0 / 性能降级节点 0');expect(textOf(s.root)).toContain('受影响必要通联需求：无');expect(textOf(s.root)).toContain('非主干链路');s.result.value.links[0].isBackbone=null;await settle();expect(textOf(s.root)).toContain('主干属性未提供');s.result.value.links[0].isBackbone=true;await settle();expect(textOf(s.root)).toContain('主干链路');expect(textOf(s.root)).not.toContain('主干属性未提供');});
 it('未就绪隐藏统计和影响对象，就绪后可见，失败再次隐藏',async()=>{const s=mount(false);await click(s.root,'影响');expect(textOf(s.root)).toContain('影响分析尚未完成');expect(textOf(s.root)).not.toContain('中断节点');expect(all(s.root,n=>n.props.class==='impact-row')).toHaveLength(0);s.impactReady.value=true;await settle();expect(textOf(s.root)).toContain('中断节点');s.impactReady.value=false;await settle();expect(textOf(s.root)).not.toContain('中断节点');});
 it('历史统计缺失不自行汇总，原节点与链路定位仍按原ID发出',async()=>{const s=mount();s.result.value.summary=null;await click(s.root,'影响');expect(textOf(s.root)).toContain('历史资料未提供结构化统计');expect(textOf(s.root)).not.toContain('性能降级节点');const rows=all(s.root,n=>n.tag==='button'&&n.props.class==='impact-row');await (rows[0].props.onClick as Function)();await (rows[s.result.value.nodes.length].props.onClick as Function)();expect(s.locate.mock.calls).toEqual([['NODE',s.result.value.nodes[0].nodeId],['LINK',s.result.value.links[0].linkId]]);});
});


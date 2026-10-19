import { afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer,h,nextTick,ssrContextKey,type App,type Component,type ComponentOptions } from 'vue';
import { parse,compileScript,compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import { renderToString } from '@vue/server-renderer';
import PrimeVue from 'primevue/config';
import Paginator from 'primevue/paginator';
import Select from 'primevue/select';
import AppDrawer from '../src/components/AppDrawer.vue';
import RequestState from '../src/components/RequestState.vue';
const capture=vi.hoisted(()=>({options:null as any}));
// 执行真实 main.ts 配置，仅截住挂载；SSR 使用 Vue 原有 createSSRApp。
vi.mock('vue',async importOriginal=>{
 const actual=await importOriginal<typeof import('vue')>();
 return{...actual,createApp:()=>{const chain={use(_plugin:unknown,options?:any){if(options?.locale)capture.options=options;return chain;},mount(){}};return chain;}};
});
vi.mock('../src/router',()=>({router:{}}));
vi.mock('../src/App.vue',()=>({default:{}}));
// 宿主测试只替换第三方抽屉，原 AppDrawer 插槽及事件实际执行。
vi.mock('primevue/drawer',()=>({default:Vue.defineComponent({props:['visible'],emits:['update:visible','after-show'],setup:(p,{slots,emit})=>()=>p.visible?Vue.h('aside',[slots.default?.(),slots.footer?Vue.h('footer',slots.footer()):null,Vue.h('button',{onClick:()=>emit('update:visible',false)},'关闭测试'),Vue.h('button',{onClick:()=>emit('after-show')},'动画完成')]):null})}));
vi.mock('primevue/portal',()=>({default:Vue.defineComponent({setup:(_p,{slots})=>()=>slots.default?.()})}));
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



const apps:App[]=[];
beforeAll(async()=>{await import('../src/main');await clientTemplate(AppDrawer,'src/components/AppDrawer.vue');await clientTemplate(RequestState,'src/components/RequestState.vue');});
afterEach(()=>{apps.splice(0).forEach(a=>a.unmount());vi.restoreAllMocks();});
function mount(component:Component,props:Record<string,unknown>,slots:Record<string,()=>unknown>={}){
 const root=node('root'),app=renderer.createApp({render:()=>h(component,props,slots)});app.provide(ssrContextKey,{modules:new Set()});app.mount(root);apps.push(app);return root;
}
describe('共用反馈与中文控件配置',()=>{
 it('未传 footer 不显示历史只读声明，也不生成空底栏',()=>{
  const root=mount(AppDrawer,{visible:true,title:'可操作抽屉'},{default:()=>h('button','保存')});
  expect(textOf(root)).toContain('保存');expect(textOf(root)).not.toContain('只读界面预览');expect(find(root,n=>n.tag==='footer')).toBeUndefined();
 });
 it('业务 footer 与原关闭、动画完成事件完整透传',async()=>{
  const closed=vi.fn(),shown=vi.fn(),root=mount(AppDrawer,{visible:true,title:'保存','onUpdate:visible':closed,'onAfter-show':shown},{footer:()=>h('button','业务保存')});
  expect(textOf(find(root,n=>n.tag==='footer')!)).toBe('业务保存');await click(root,'关闭测试');expect(closed).toHaveBeenCalledWith(false);await click(root,'动画完成');expect(shown).toHaveBeenCalledTimes(1);
 });
 it('加载不预判演示来源，错误重试、空和无权限状态保持',async()=>{
  const loading=mount(RequestState,{state:'loading'});expect(textOf(loading)).toContain('正在加载数据');expect(textOf(loading)).not.toContain('演示');
  const retry=vi.fn(),error=mount(RequestState,{state:'error',message:'服务不可用',onRetry:retry});expect(textOf(error)).toContain('服务不可用');await click(error,'重新加载');expect(retry).toHaveBeenCalledTimes(1);
  expect(textOf(mount(RequestState,{state:'empty'}))).toContain('暂无符合条件的数据');expect(textOf(mount(RequestState,{state:'forbidden'}))).toContain('暂无访问权限');
 });
 it('main.ts 的配置使真实 PrimeVue SSR 分页、关闭及选择播报为中文',async()=>{
  const ActualDrawer=(await vi.importActual<typeof import('primevue/drawer')>('primevue/drawer')).default;
  // SSR 没有浏览器挂载：仅内联 Portal 并展开下拉，标签仍由真实控件生成。
  const InlinePortal=Vue.defineComponent({inheritAttrs:false,setup:(_p,{slots})=>()=>slots.default?.()});
  const drawer={...ActualDrawer,components:{...(ActualDrawer as any).components,Portal:InlinePortal}};
  const select={...Select,components:{...(Select as any).components,Portal:InlinePortal},data(this:any){return{...(Select as any).data.call(this),overlayVisible:true};}};
  const app=Vue.createSSRApp({render:()=>h('div',[
   h(Paginator,{rows:10,totalRecords:30,rowsPerPageOptions:[10,20]}),h(drawer,{visible:true,header:'中文关闭'}),
   h(select,{modelValue:'a',options:[{label:'样本',value:'a'}],optionLabel:'label',optionValue:'value'}),h(select,{options:[]}),
  ])});app.use(PrimeVue,capture.options);
  const html=await renderToString(app);
  for(const label of ['首页','上一页','第 1 页','下一页','末页','每页条数','关闭'])expect(html).toContain('aria-label="'+label+'"');
  expect(html).toContain('已选择 1 项');expect(html).toContain('未选择任何项');
  expect(html).not.toContain('aria-label="First Page"');expect(html).not.toContain('1 items selected');
 });
});


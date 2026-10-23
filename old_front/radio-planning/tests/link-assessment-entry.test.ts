import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, reactive, ssrContextKey, type App, type Component, type ComponentOptions } from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import LinkAssessmentPanel from '../src/components/LinkAssessmentPanel.vue';
import LinkDetailPanel from '../src/components/LinkDetailPanel.vue';
import LinkMonitoringPanel from '../src/components/LinkMonitoringPanel.vue';
import MonitoringObjectPanel from '../src/components/MonitoringObjectPanel.vue';
import { createMockService } from '../src/services/mock';
import { createLinkDetailContext, selectHistoryAssessment } from '../src/services/link-detail';
import { useMonitoringStore } from '../src/stores/monitoring';
import { selectMonitoringAssessment } from '../src/services/monitoring-validation';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';

vi.mock('../src/components/ChartCanvas.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/LinkHistoryChart.vue', () => ({ default: { render: () => null } }));
// 用实际客户端模板和生命周期验证，只替换绘图库外壳。
async function clientTemplate(component: Component, filename: string) {
  const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor;
  const bindings = compileScript(descriptor, { id: filename }).bindings;
  const result = compileTemplate({ source: descriptor.template!.content, filename, id: filename, compilerOptions: { mode: 'function', bindingMetadata: bindings } });
  if (result.errors.length) throw new Error(result.errors.map(String).join('\n'));
  const { code } = await transformWithEsbuild(`function createRender(Vue) { ${result.code} }`, 'link-assessment-render.ts', { loader: 'ts' });
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
  clientTemplate(LinkAssessmentPanel, 'src/components/LinkAssessmentPanel.vue'),
  clientTemplate(LinkDetailPanel, 'src/components/LinkDetailPanel.vue'),
  clientTemplate(LinkMonitoringPanel, 'src/components/LinkMonitoringPanel.vue'),
  clientTemplate(MonitoringObjectPanel, 'src/components/MonitoringObjectPanel.vue'),
]);
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app=undefined; if(pinia) disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function setup() {
  pinia=createPinia(); setActivePinia(pinia); const auth=authorizeStore();
  const storage=new TestStorage(), service=createMockService(()=>storage), data=reactive(await service.loadPreview());
  async function mount(component: Component) {
    app=renderer.createApp(component); app.use(pinia!); app.provide(ssrContextKey,{});
    const root=node('root'); app.mount(root); await settle(); return root;
  }
  return {auth,service,storage,data,mount};
}
describe('三个链路判定依据入口',()=>{
  it('普通 GIS 使用当前采样，坏解释与脏态不能残留旧规则',async()=>{
    const s=await setup(), state=reactive({id:'PL-002',dirty:false});
    const root=await s.mount({render:()=>h(LinkDetailPanel,{link:s.data.situation.links.find(l=>l.id===state.id)!,resources:s.data.resources,
      context:createLinkDetailContext(s.data.situation,s.data.resources,s.data.resourceMeta,state.dirty)})});
    expect(textOf(root)).toContain('88.0%'); expect(textOf(root)).toContain('NET-DEMO-03');
    await click(root,'DEMO-LR-WARNING · 预警记录说明'); expect(textOf(root)).toContain('服务已给定此采样');
    state.id='PL-001'; await settle(); expect(textOf(root)).not.toContain('服务已给定此采样'); expect(textOf(root)).toContain('96.0%');
    s.data.situation.linkDetails!.records[0].samples.at(-1)!.assessment!.owner.deviceA='OTHER'; await settle();
    expect(textOf(root)).toContain('不匹配'); expect(textOf(root)).toContain('18.2'); expect(textOf(root)).not.toContain('96.0%');
    state.dirty=true; await settle(); expect(textOf(root)).toContain('未保存修改'); expect(find(root,n=>n.props['aria-label']==='链路判定依据')).toBeUndefined();
    expect(s.storage.writes).toBe(0);
  });
  it('底部和右侧使用同帧，刷新切换时清除展开，服务帧未被改写',async()=>{
    const s=await setup(), store=useMonitoringStore(), c=await s.service.loadMonitoringContext(null);
    const first=await s.service.getMonitoringFrame({taskId:null,networkKey:c.network!.key,index:1});
    store.context=first.context; store.networkResult=first; store.selectedLinkId='LINK-B';
    const root=await s.mount({render:()=>h('div',[
      h(LinkMonitoringPanel,{network:store.network!,frame:store.networkResult!.frame,selectedId:store.selectedLinkId,onSelect:store.selectLink}),
      h(MonitoringObjectPanel),
    ])});
    expect(all(root,n=>n.props['aria-label']==='链路判定依据')).toHaveLength(2);
    const panels=all(root,n=>n.props['aria-label']==='链路判定依据');
    panels.forEach(panel=>expect(textOf(panel)).toContain('88.0%'));
    await click(panels[0],'DEMO-LR-WARNING · 预警记录说明'); expect(textOf(panels[0])).toContain('服务已给定此采样');
    const next=await s.service.getMonitoringFrame({taskId:null,networkKey:c.network!.key,index:2}); store.networkResult=next; await settle();
    expect(textOf(root)).not.toContain('服务已给定此采样');
    all(root,n=>n.props['aria-label']==='链路判定依据').forEach(panel=>{expect(textOf(panel)).toContain('100.0%');expect(textOf(panel)).toContain('DEMO-LR-INTERRUPTED · 未提供规则内容');});
    expect(first.frame.links[1].state).toBe('WARNING'); expect(next.frame.links[1].state).toBe('FAULT');
    const old=selectMonitoringAssessment(c.network,first.frame,'LINK-B'); expect(old.display.assessment?.state).toBe('WARNING');
  });
  it('权限、解释缺失、空规则及等级不一致均如实显示，旧展开事件不能跨身份',async()=>{
    const s=await setup(), context=createLinkDetailContext(s.data.situation,s.data.resources,s.data.resourceMeta);
    const p=reactive({...selectHistoryAssessment(context,'PL-002'),observedState:'WARNING' as const});
    const root=await s.mount({render:()=>h(LinkAssessmentPanel,p)});
    const button=find(root,n=>n.tag==='button')!, old=button.props.onClick as ()=>void;
    s.auth.accept({...s.auth.identity!,permissions:[]}); await settle(); old(); await settle(); expect(textOf(root)).not.toContain('88.0%');
    authorizeStore(); await settle(); expect(textOf(root)).not.toContain('服务已给定此采样');
    p.display.assessment!.confidence=0; p.display.assessment!.state='GOOD'; p.display.assessment!.matchedRuleIds=[]; p.display.assessment!.rules=[]; await settle();
    expect(textOf(root)).toContain('0.0%'); expect(textOf(root)).toContain('不一致'); expect(textOf(root)).toContain('明确没有命中规则');
    p.display={state:'missing',message:'未提供此采样的判定依据。',assessment:null}; await settle();
    expect(textOf(root)).toContain('未提供此采样'); expect(textOf(root)).not.toContain('0.0%');
  });
  it('返回的表达式只显示文本，不执行代码',async()=>{
    const s=await setup(), c=createLinkDetailContext(s.data.situation,s.data.resources,s.data.resourceMeta), p=selectHistoryAssessment(c,'PL-002');
    p.display.assessment!.rules![0].conditionText='globalThis.__assessmentExecuted = true';
    const root=await s.mount({render:()=>h(LinkAssessmentPanel,p)}); await click(root,'DEMO-LR-WARNING · 预警记录说明');
    expect(textOf(root)).toContain('globalThis.__assessmentExecuted'); expect((globalThis as Record<string,unknown>).__assessmentExecuted).toBeUndefined();
  });
});

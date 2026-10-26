import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ssrContextKey, type App } from 'vue';
import { disposePinia } from 'pinia';
import TaskApiForm from '../src/components/TaskApiForm.vue';
import TaskApiPanel from '../src/components/TaskApiPanel.vue';
import PlanningOptionsEditor from '../src/components/PlanningOptionsEditor.vue';
import DeploymentConstraintsEditor from '../src/components/DeploymentConstraintsEditor.vue';
import { storeFixture, readNode } from './fixtures/planning-api';
// 仅复用模板编译，原有宿主、替身和业务交互保持本地。
import { clientTemplate } from './helpers/vue-client';

// 运行真实表单模板，仅替换浮层宿主；不依赖浏览器样式来证明输入保护。
vi.mock('../src/components/AppDrawer.vue', () => ({ default: { props: ['visible'], emits:['update:visible'], render(this:any) { return this.visible ? h('drawer-probe', [h('button',{onClick:()=>this.$emit('update:visible',false)},'关闭节点管理'),this.$slots.default?.()]) : null; } } }));
vi.mock('../src/components/TaskDemandEditor.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/TaskApiLibraryDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/TaskApiImportDrawer.vue', () => ({ default: { render: () => null } }));
beforeAll(async () => {
  for (const [component, name] of [[TaskApiForm, 'TaskApiForm'], [TaskApiPanel, 'TaskApiPanel'], [PlanningOptionsEditor, 'PlanningOptionsEditor'], [DeploymentConstraintsEditor, 'DeploymentConstraintsEditor']] as const) {
    const filename = `src/components/${name}.vue`;
    await clientTemplate(component, filename, 'layout-render.ts');
  }
});
interface Host { focus:()=>void;scrollIntoView:()=>void;getAttribute:(key:string)=>unknown;querySelectorAll:()=>Host[];readonly parentElement:Host|null;open?:boolean; tag:string; tagName:string; text:string; children:Host[]; parent:Host|null; props:Record<string,any>; style:Record<string,string>; options:Host[]; addEventListener:()=>void; removeEventListener:()=>void; getRootNode:()=>any; }
let focused:Host|undefined;
function node(tag:string, text=''):Host { return { tag, tagName:tag.toUpperCase(), text, children:[], parent:null, props:{}, style:{},focus(){focused=this;},scrollIntoView(){},getAttribute(key){return this.props[key]??null;},querySelectorAll(){return all(this,el=>!!el.props['data-validation-field']);},get parentElement(){return this.parent;}, get options(){ return this.children.filter(x=>x.tag==='option'); }, addEventListener(){}, removeEventListener(){}, getRootNode:()=>document }; }
function remove(el:Host) { if(el.parent) el.parent.children.splice(el.parent.children.indexOf(el),1); el.parent=null; }
const renderer = createRenderer<Host,Host>({ createElement:tag=>node(tag), createText:t=>node('#text',t), createComment:t=>node('#comment',t), insert(el,parent,anchor){ remove(el);el.parent=parent;const index=anchor?parent.children.indexOf(anchor):-1;parent.children.splice(index<0?parent.children.length:index,0,el); }, remove, setText(el,t){el.text=t;}, setElementText(el,t){el.text=t;el.children=[];}, parentNode:el=>el.parent, nextSibling:el=>el.parent?.children[el.parent.children.indexOf(el)+1]??null, patchProp(el,key,_old,value){el.props[key]=value;}, insertStaticContent(t,parent){const el=node('#static',t);el.parent=parent;parent.children.push(el);return [el,el];} });
const all=(el:Host,p:(el:Host)=>boolean):Host[]=>[...(p(el)?[el]:[]),...el.children.flatMap(x=>all(x,p))];
const text=(el:Host):string=>el.text+el.children.map(text).join('');
const button=(root:Host,label:string)=>all(root,el=>el.tag==='button'&&text(el).trim()===label)[0]!;
let app:App|undefined, fixture:Awaited<ReturnType<typeof storeFixture>>|undefined;
async function mounted() {
  vi.stubGlobal('Document',class {});vi.stubGlobal('ShadowRoot',class {});vi.stubGlobal('document',new EventTarget());
  fixture=await storeFixture();vi.spyOn(fixture.resources,'fetchNodes').mockResolvedValue({revision:'r1',items:[readNode(),readNode('N2')],pageNum:1,pageSize:10,total:2});
  const submit=vi.fn(),root=node('root');app=renderer.createApp({render:()=>h(TaskApiPanel,{}, {actions:()=>h('button',{onClick:submit},'提交规划')})});app.use(fixture.pinia);app.provide(ssrContextKey,{modules:new Set()});app.mount(root);await nextTick();await nextTick();return {...fixture,root,submit};
}
afterEach(()=>{app?.unmount();app=undefined;if(fixture)disposePinia(fixture.pinia);fixture=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('规划输入工作区',()=>{
  // 使用汇总按钮定位实际字段，不能只检查模板里存在错误文字。
  it('必填错误就近显示，汇总展开区域与时间分组并聚焦，修正后更新',async()=>{
    const s=await mounted();s.task.draft!.name='';s.task.draft!.bbox=[120,30,119,31];s.task.draft!.startTime='bad-time';
    expect(await s.task.save()).toBe(false);await nextTick();
    const name=all(s.root,el=>el.props['data-validation-field']==='name')[0];
    expect(name.props['aria-invalid']).toBe(true);expect(text(name.parent!)).toContain('任务名称为');
    for(const [label,field] of [['任务区域','bbox'],['开始时间','startTime']]){
      const link=all(s.root,el=>el.tag==='button'&&text(el).startsWith(label+'：'))[0];
      expect(link).toBeDefined();await link.props.onClick();await nextTick();
      expect(focused?.props['data-validation-field']).toBe(field);
      for(let parent=focused?.parent;parent;parent=parent.parent)if(parent.tag==='details')expect(parent.open).toBe(true);
    }
    s.task.draft!.name='已修正';await nextTick();expect(name.props['aria-invalid']).toBe(false);expect(text(name.parent!)).not.toContain('任务名称为');
    expect(s.task.draft!.startTime).toBe('bad-time');expect(s.submit).not.toHaveBeenCalled();
  });
  it('未知设备字段保留汇总，定位失败不聚焦同名任务字段或改值',async()=>{
    const s=await mounted(),before=JSON.stringify(s.task.draft);
    s.task.issues=[{objectId:'DV-0001',field:'name',message:'设备名称需核查'},{objectId:'TASK',field:'name.future',message:'未知子字段需核查'}];await nextTick();focused=undefined;
    for(const message of ['设备名称需核查','未知子字段需核查']){
      const link=all(s.root,el=>el.tag==='button'&&text(el).includes(message))[0];
      await link.props.onClick();await nextTick();expect(focused).toBeUndefined();
    }
    expect(text(s.root)).toContain('无法在当前任务表单定位');expect(JSON.stringify(s.task.draft)).toBe(before);
  });

  it('区域摘要随输入合法性更新，可选时间折叠不丢草稿，GIS保留原布局',async()=>{
    const s=await mounted(),region=()=>all(s.root,el=>el.tag==='summary'&&text(el).startsWith('任务区域'))[0];
    expect(text(region())).toContain('范围有效');s.task.draft!.bbox=[120,30,119,31];await nextTick();expect(text(region())).toContain('范围待完善');
    const optional=all(s.root,el=>el.tag==='details'&&text(el).startsWith('时间与说明'))[0];expect(optional.props.open).not.toBe(true);
    s.task.draft!.startTime='2026-10-21T08:00:00+08:00';await nextTick();expect(s.task.draft!.startTime).toBe('2026-10-21T08:00:00+08:00');
    await s.task.initialize('gis');await nextTick();expect(all(s.root,el=>el.tag==='details'&&text(el).startsWith('时间与说明'))).toHaveLength(0);
    expect(all(s.root,el=>el.tag==='input'&&text(el.parent!).startsWith('开始时间'))).toHaveLength(1);
  });
  it('节点默认摘要，抽屉选择立即应用且关闭不撤销',async()=>{
    const s=await mounted();expect(all(s.root,el=>String(el.props.class).includes('node-options'))).toHaveLength(0);
    button(s.root,'管理参与节点').props.onClick();await nextTick();const drawer=all(s.root,el=>el.tag==='drawer-probe')[0];expect(drawer).toBeDefined();
    const choice=all(drawer,el=>el.tag==='input'&&el.props.type==='checkbox')[0];choice.props.onChange({target:{checked:false}});await nextTick();expect(s.task.draft!.stationIds).toEqual(['N2']);
    // 关闭浮层仅改变可见性，草稿选择不回滚。
    button(s.root,'关闭节点管理').props.onClick();await nextTick();expect(all(s.root,el=>el.tag==='drawer-probe')).toHaveLength(0);expect(s.task.draft!.stationIds).toEqual(['N2']);
    expect(s.task.changed).toBe(true);expect(s.submit).not.toHaveBeenCalled();
    expect(all(s.root,el=>String(el.props.class)==='task-actions')).toHaveLength(1);
  });
  it('高级分组保留编辑器和非法原文，保存仍受 pending 输入保护',async()=>{
    const s=await mounted();const checks=all(s.root,el=>el.tag==='input'&&el.props.type==='checkbox');
    checks.find(el=>text(el.parent!).includes('设置 HF 条件'))!.props.onChange({target:{checked:true}});await nextTick();
    const minimum=all(s.root,el=>el.tag==='input'&&text(el.parent!).includes('最低频率'))[0];minimum.props.onInput({target:{value:'invalid'}});await nextTick();
    expect(s.task.auxiliary.options).toBe(true);expect(minimum.props.value).toBe('invalid');
    const group=all(s.root,el=>el.tag==='details'&&text(el).startsWith('频率与求解条件'))[0];expect(group).toBeDefined();
    expect(await s.task.save()).toBe(false);expect(s.task.auxiliary.options).toBe(true);expect(s.submit).not.toHaveBeenCalled();
  });
});

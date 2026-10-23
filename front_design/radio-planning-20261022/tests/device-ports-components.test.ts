import {afterEach,describe,it,expect,vi} from 'vitest';
import * as Vue from 'vue';
import {clientTemplate} from './helpers/vue-client';
import DevicePortsEditDrawer from '../src/components/DevicePortsEditDrawer.vue';
import {initialResources} from '../src/mocks/resource-presets';
import {createForm} from '../src/services/resource-validation';
// 实际模板与输入事件在轻量宿主运行，抽屉外壳不参与测试。
vi.mock('../src/components/AppDrawer.vue',()=>({default:Vue.defineComponent({props:['visible'],setup:(p,{slots})=>()=>p.visible?Vue.h('aside',slots.default?.()):null})}));
const filename='src/components/DevicePortsEditDrawer.vue';
// 模板编译错误统一由公共编译器立即抛出。
await clientTemplate(DevicePortsEditDrawer,filename,'ports-render.ts');
type Node={tag:string;text:string;children:Node[];parent:Node|null;props:Record<string,any>;style:Record<string,string>;value?:unknown;tagName:string;options:Node[];addEventListener:(name:string,callback:Function)=>void;removeEventListener:()=>void;getRootNode:()=>unknown};
const node=(tag:string,text=''):Node=>({tag,text,children:[],parent:null,props:{},style:{},tagName:tag.toUpperCase(),get options(){return this.children.filter(n=>n.tag==='option');},addEventListener(name,callback){this.props["dom:"+name]=callback;},removeEventListener(){},getRootNode:()=>null});
const remove=(n:Node)=>{if(n.parent)n.parent.children.splice(n.parent.children.indexOf(n),1);n.parent=null;};
const insert=(n:Node,p:Node,a?:Node|null)=>{remove(n);n.parent=p;const i=a?p.children.indexOf(a):-1;p.children.splice(i<0?p.children.length:i,0,n);};
const renderer=Vue.createRenderer<Node,Node>({insert,remove,createElement:node,createText:t=>node('#text',t),createComment:t=>node('#comment',t),setText:(n,t)=>{n.text=t;},setElementText:(n,t)=>{n.text=t;n.children=[];},parentNode:n=>n.parent,nextSibling:n=>n.parent?.children[n.parent.children.indexOf(n)+1]??null,patchProp:(n,k,_p,v)=>{n.props[k]=v;},insertStaticContent:(t,p,a)=>{const n=node('#static',t);insert(n,p,a);return[n,n];}});
const all=(n:Node):Node[]=>[n,...n.children.flatMap(all)];
let app:Vue.App|undefined;
afterEach(()=>{app?.unmount();vi.restoreAllMocks();});
function setup(){
  const form=Vue.reactive(createForm(initialResources(),'device','DV-0001')),state=Vue.reactive({editable:true,busy:false}),sent=vi.fn();
  app=renderer.createApp({render:()=>Vue.h(DevicePortsEditDrawer,{visible:true,form,context:'ledger',...state,error:'',message:'',issues:[],onPorts:(ports:unknown)=>{sent(ports);form.fields.ports=JSON.stringify(ports);}})});
  app.provide(Vue.ssrContextKey,{});const root=node('root');app.mount(root);
  const field=(label:string)=>all(root).find(n=>n.props['aria-label']===label)!;
  const input=async(label:string,value:string)=>{field(label).props.onInput({target:{value}});await Vue.nextTick();};
  return{form,state,sent,root,field,input};
}
describe('实例端口真实输入',()=>{
  it('单端口输入立即交表单所有者，身份和观测不进入可编辑字段',async()=>{
    const s=setup();await s.input('RF-1 速率 kbps','19.2');
    const ports=JSON.parse(s.form.fields.ports);expect(ports[0].rateKbps).toBe(19.2);expect(ports[1].rateKbps).toBe(64);expect(ports[0].id).toBe('DV-0001:RF1');
    expect(all(s.root).filter(n=>n.tag==='input').every(n=>!['status','id','type'].includes(n.props['aria-label']))).toBe(true);
    s.state.editable=false;await Vue.nextTick();await s.input('RF-1 速率 kbps','32');expect(s.sent).toHaveBeenCalledTimes(1);
  });
  it('同设备已选端口批量速率同步进入表单，清空保留 null',async()=>{
    const s=setup(),checkboxes=all(s.root).filter(n=>n.tag==='input'&&n.props.type==='checkbox');
    for(const box of checkboxes){(box as any)._value=box.props.value;(box as any).checked=true;box.props["dom:change"]({target:box});await Vue.nextTick();}
    await s.input('端口批量值','32');expect(JSON.parse(s.form.fields.ports).map((p:any)=>p.rateKbps)).toEqual([32,32]);
    await s.input('RF-1 天线增益 dBi','');expect(JSON.parse(s.form.fields.ports)[0].gainDbi).toBeNull();
  });
});

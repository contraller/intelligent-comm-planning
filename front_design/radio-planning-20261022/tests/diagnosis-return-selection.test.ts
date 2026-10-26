import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, reactive, watch, type EffectScope } from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';

type Target={scenarioId:string;id:string};
interface State {
  workspace:object|null;locked:boolean;catalogReady:boolean;scenarioId:string|null;
  versionId:string;draft:object|null;error:string;
}
let install:(observe:typeof watch,route:unknown,diagnosis:unknown,auth:unknown)=>void;
const scopes:EffectScope[]=[];

beforeAll(async()=>{
  const filename='src/views/DiagnosisView.vue';
  const descriptor=parse(readFileSync(filename,'utf8'),{filename}).descriptor;
  const source=descriptor.scriptSetup!.content;
  const ast=compileScript(descriptor,{id:'diagnosis-return-selection'}).scriptSetupAst!;
  const declarations=ast.filter(statement=>statement.type==='VariableDeclaration'&&statement.declarations.some(value=>value.id.type==='Identifier'&&value.id.name==='handledReturn'));
  expect(declarations).toHaveLength(1);
  const declaration=declarations[0]!,statement=ast[ast.indexOf(declaration)+1]!;
  expect(statement.type).toBe('ExpressionStatement');
  if(statement.type!=='ExpressionStatement'||statement.expression.type!=='CallExpression')throw new Error('The return watcher must follow handledReturn');
  expect(statement.expression.callee).toMatchObject({type:'Identifier',name:'watch'});
  expect(statement.expression.arguments).toHaveLength(3);
  expect(declaration.start).not.toBeNull();expect(statement.end).not.toBeNull();
  // Execute the actual SFC block, not a copied implementation or a text-only assertion.
  const {code}=await transformWithEsbuild(source.slice(declaration.start!,statement.end!),'diagnosis-return-watch.ts',{loader:'ts'});
  install=new Function('watch','route','diagnosis','auth',code) as typeof install;
});
afterEach(()=>{for(const scope of scopes.splice(0))scope.stop();});
async function settle(){for(let index=0;index<6;index++){await Promise.resolve();await nextTick();}}

function fixture(options:{ready?:boolean;selected?:boolean;query?:Record<string,unknown>}={}){
  const route=reactive({query:options.query??{scenarioId:'FS-original',versionId:'FSV-original'}});
  const auth=reactive({generation:0});
  const state=reactive<State>({workspace:options.ready?{}:null,locked:!options.ready,catalogReady:!!options.ready,
    scenarioId:options.selected?'FS-original':null,versionId:options.selected?'FSV-original':'',
    draft:options.selected?{name:'original'}:null,error:''});
  const pending:{target:Target;finish:(error?:Error)=>void}[]=[];
  const selectVersion=vi.fn(async(target:Target)=>{
    expect(state.catalogReady).toBe(true);
    const session=auth.generation;
    state.locked=true;
    try{
      const error=await new Promise<Error|undefined>(resolve=>pending.push({target:{...target},finish:resolve}));
      if(session!==auth.generation)return;
      if(error){state.error=error.message;return;}
      state.scenarioId=target.scenarioId;state.versionId=target.id;state.draft={name:'original'};state.error='';
    }finally{if(session===auth.generation)state.locked=false;}
  });
  const diagnosis=Object.assign(state,{selectVersion,submit:vi.fn(),cancel:vi.fn()});
  const scope=effectScope();scopes.push(scope);
  scope.run(()=>install(watch,route,diagnosis,auth));
  return {route,auth,diagnosis,selectVersion,pending,scope,
    async unlock(){state.catalogReady=true;state.locked=false;await settle();},
    async complete(index:number,error?:Error){expect(pending[index]).toBeDefined();pending[index]!.finish(error);await settle();}};
}

describe('SR5原场景返回的真实Vue watcher',()=>{
  it('metadata先hydrate但目录未完成时不消费目标，解锁后只选择一次且内部loading不循环',async()=>{
    const f=fixture();await settle();expect(f.selectVersion).not.toHaveBeenCalled();
    f.diagnosis.workspace={revision:'SR5-2'};await settle();expect(f.selectVersion).not.toHaveBeenCalled();
    f.diagnosis.workspace={revision:'SR5-2',catalogPending:true};await settle();expect(f.selectVersion).not.toHaveBeenCalled();
    await f.unlock();expect(f.selectVersion).toHaveBeenCalledExactlyOnceWith({scenarioId:'FS-original',id:'FSV-original'});expect(f.diagnosis.locked).toBe(true);
    await settle();expect(f.selectVersion).toHaveBeenCalledOnce();await f.complete(0);expect(f.diagnosis.locked).toBe(false);expect(f.diagnosis.versionId).toBe('FSV-original');expect(f.selectVersion).toHaveBeenCalledOnce();
    expect(f.diagnosis.submit).not.toHaveBeenCalled();expect(f.diagnosis.cancel).not.toHaveBeenCalled();
  });
  it('同query重新赋值或workspace/locked变化不重复选择',async()=>{
    const f=fixture({ready:true});await settle();await f.complete(0);
    f.route.query={scenarioId:'FS-original',versionId:'FSV-original'};f.diagnosis.workspace={revision:'SR5-2'};await settle();
    f.diagnosis.locked=true;await settle();f.diagnosis.locked=false;await settle();expect(f.selectVersion).toHaveBeenCalledOnce();
  });
  it('同ID且已有草稿不发重复读取，也不自动启动诊断',async()=>{
    const f=fixture({ready:true,selected:true});await settle();expect(f.selectVersion).not.toHaveBeenCalled();expect(f.diagnosis.submit).not.toHaveBeenCalled();
  });
  it('切query发生于前一读取锁定时，前次解锁后按新query读取一次',async()=>{
    const f=fixture({ready:true});await settle();
    f.route.query={scenarioId:'FS-next',versionId:'FSV-next'};await settle();expect(f.selectVersion).toHaveBeenCalledOnce();
    await f.complete(0);expect(f.selectVersion).toHaveBeenCalledTimes(2);expect(f.selectVersion).toHaveBeenLastCalledWith({scenarioId:'FS-next',id:'FSV-next'});
    await f.complete(1);expect(f.diagnosis.versionId).toBe('FSV-next');expect(f.selectVersion).toHaveBeenCalledTimes(2);
  });
  it('切身份后旧在途完成不写新现场，新metadata及目录解锁后同query可重新读取',async()=>{
    const f=fixture({ready:true});await settle();
    f.auth.generation++;f.diagnosis.workspace=null;f.diagnosis.catalogReady=false;f.diagnosis.draft=null;f.diagnosis.scenarioId=null;f.diagnosis.versionId='';await settle();
    await f.complete(0);expect(f.diagnosis.draft).toBeNull();expect(f.selectVersion).toHaveBeenCalledOnce();
    f.diagnosis.workspace={revision:'SR5-2'};await settle();expect(f.selectVersion).toHaveBeenCalledOnce();
    await f.unlock();expect(f.selectVersion).toHaveBeenCalledTimes(2);await f.complete(1);expect(f.diagnosis.versionId).toBe('FSV-original');expect(f.selectVersion).toHaveBeenCalledTimes(2);
  });
  it('参数在锁定时消失也清去重标记，重新进入同query且现场已清时可回读',async()=>{
    const f=fixture({ready:true});await settle();await f.complete(0);
    f.route.query={};f.diagnosis.locked=true;f.diagnosis.workspace=null;f.diagnosis.draft=null;f.diagnosis.scenarioId=null;f.diagnosis.versionId='';await settle();
    f.route.query={scenarioId:'FS-original',versionId:'FSV-original'};f.diagnosis.workspace={revision:'SR5-2'};await settle();expect(f.selectVersion).toHaveBeenCalledOnce();
    await f.unlock();expect(f.selectVersion).toHaveBeenCalledTimes(2);await f.complete(1);expect(f.diagnosis.versionId).toBe('FSV-original');
  });
  it('读取失败保留错误且不在解锁时无限重试，用户仍可手动重试原ID',async()=>{
    const f=fixture({ready:true});await settle();await f.complete(0,new Error('原版本读取失败'));
    expect(f.diagnosis.error).toBe('原版本读取失败');f.diagnosis.locked=true;await settle();f.diagnosis.locked=false;f.diagnosis.workspace={revision:'SR5-2'};f.route.query={...f.route.query};await settle();
    expect(f.selectVersion).toHaveBeenCalledOnce();expect(f.diagnosis.error).toBe('原版本读取失败');
    const retry=f.diagnosis.selectVersion({scenarioId:'FS-original',id:'FSV-original'});await settle();await f.complete(1);await retry;
    expect(f.diagnosis.error).toBe('');expect(f.selectVersion).toHaveBeenCalledTimes(2);expect(f.diagnosis.submit).not.toHaveBeenCalled();
  });
  it.each([
    {scenarioId:'FS-original'},
    {versionId:'FSV-original'},
    {scenarioId:'',versionId:'FSV-original'},
    {scenarioId:['FS-original'],versionId:'FSV-original'},
    {scenarioId:'FS-original',versionId:null},
  ])('非法query保留守卫且不选择：%j',async query=>{
    const f=fixture({ready:true,query});await settle();expect(f.diagnosis.error).toBe('场景返回参数无效');expect(f.selectVersion).not.toHaveBeenCalled();expect(f.diagnosis.submit).not.toHaveBeenCalled();
    f.diagnosis.locked=true;await settle();f.diagnosis.locked=false;await settle();expect(f.selectVersion).not.toHaveBeenCalled();
  });
});

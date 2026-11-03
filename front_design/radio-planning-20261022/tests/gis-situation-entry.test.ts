import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { computed, defineComponent, nextTick, ref, shallowRef, ssrContextKey } from 'vue';
import GisSituationView from '../src/views/GisSituationView.vue';
import CoverageLineLegend from '../src/components/CoverageLineLegend.vue';
import { previewService } from '../src/services';
import { authorizeStore } from './helpers/auth';
import { clientTemplate, find, node, renderer, textOf } from './helpers/vue-client';
import * as situation from '../src/composables/useGisSituation';
import {planningBounds} from '../src/maps/planning-bounds-layer';

const mapCalls=vi.hoisted(()=>({fit:vi.fn(),coverage:vi.fn()}));
vi.mock('../src/components/MapCanvas.vue', () => ({ default: defineComponent({setup(_, {expose}){expose({fit:mapCalls.fit,fitFrozenCoverage:mapCalls.coverage});return()=>null;}}) }));
await clientTemplate(CoverageLineLegend, 'src/components/CoverageLineLegend.vue', 'situation-legend-render.ts');
await clientTemplate(GisSituationView, 'src/views/GisSituationView.vue', 'situation-overview-render.ts');

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals();mapCalls.fit.mockClear();mapCalls.coverage.mockClear(); });

describe('GIS 态势真实页面初始化', () => {
  it('切换覆盖同步图例，新成果切换后同步目录与已选方案',async()=>{
    vi.stubGlobal('document',{hidden:false});
    const cell=(field:number,covered=true)=>({type:'Feature',properties:{is_coverage:covered,surface_kind:'TERRAIN_CELL',field_strength_dbuvm:field},geometry:{type:'Polygon',coordinates:[[[113.09,37.09],[113.11,37.09],[113.11,37.11],[113.09,37.11],[113.09,37.09]]]}});
    const device={device_id:'D1',node_id:'N1',lon:113.1,lat:37.1,band:'VUHF',status:'COMPLETE',computations:[{freq_khz:156000,shape:'CELLS',evaluated_samples:3,geojson:{features:[cell(14.5),cell(22.5),cell(999,false)]}},{freq_khz:157000,shape:'CELLS',evaluated_samples:1,geojson:{features:[cell(55.5)]}}]};
    const anchor={plan_id:'P1',task_id:'T1',snapshot_id:'SNP-S1',engine_version:'V01-6'};
    const parameters={radius_m:60000,hf_max_km:900,cell_m:2000,margin_min_db:6};
    const cache={state:'HIT',anchor,parameters,result:{schema_version:2,solution_id:'S1',devices:[device],provenance:{engine_version:'V01-6',bandwidth_selection_id:null,bandwidth_selection_hash:null,parameters,dem_bbox:[113,37,114,38]}}};
    const frame=shallowRef({plan:{id:'P1',taskId:'T1',name:'冻结方案',version:'V1',state:'SAVED',savedAt:'2026-11-03T00:00:00Z',input:{bbox:[113,37,114,38]}},network:{identity:{snapshot_id:'S1'},nodes:[],devices:[],links:[]},coverage:cache,notices:[],readAt:'2026-11-03T00:00:00Z'});
    const display=ref('field'),deviceId=ref(''),coverageVisible=ref(false);
    const frequencyKhz=ref<number>(),selectedFrequency=computed(()=>frequencyKhz.value??156000),terrainReference=ref(false);
    const rows=ref([{...frame.value.plan}]),newest=ref<typeof frame.value.plan|null>(null);
    const newPlan={...frame.value.plan,id:'P2',name:'新保存方案'};
    const catalog=vi.fn(async()=>{rows.value=[newPlan,...rows.value];return rows.value;});
    const select=vi.fn(async(row:typeof frame.value.plan)=>{frame.value={...frame.value,plan:row};newest.value=null;return true;});
    vi.spyOn(situation,'useGisSituation').mockReturnValue({frame,rows,loading:ref(false),error:ref(''),notice:ref(''),newest,autoRefresh:ref(false),page:ref(1),total:ref(1),deviceId,coverageVisible,display,frequencyKhz,selectedFrequency,terrainReference,coverageOverlay:computed(()=>coverageVisible.value&&deviceId.value==='D1'?{anchor,result:frame.value.coverage.result,deviceId:'D1',frequencyKhz:selectedFrequency.value,display:display.value,terrainReference:terrainReference.value}:null),dimensions:computed(()=>planningBounds(frame.value.plan.input.bbox)),catalog,select,latest:vi.fn(),refresh:vi.fn(),reset:vi.fn()} as unknown as ReturnType<typeof situation.useGisSituation>);
    const pinia=createPinia();setActivePinia(pinia);authorizeStore();
    const root=node('root'),app=renderer.createApp(GisSituationView);app.use(pinia);app.component('RouterLink',{render:()=>null});app.provide(ssrContextKey,{});
    try{
      app.mount(root);await nextTick();expect(mapCalls.coverage).not.toHaveBeenCalled();
      const deviceSelector=find(root,n=>n.props['aria-label']==='覆盖设备')!;
      (deviceSelector.props['onUpdate:modelValue'] as Function)('D1');await (deviceSelector.props.onChange as Function)();await nextTick();expect(coverageVisible.value).toBe(true);expect(mapCalls.coverage).toHaveBeenCalledOnce();
      expect(textOf(root)).toContain('14.5');expect(textOf(root)).toContain('22.5 dBμV/m');expect(textOf(root)).not.toContain('999');expect(textOf(root)).not.toContain('强 ≥20 dB');expect(textOf(root)).toContain('关闭地形影响标记仍保留地形计算');
      display.value='strength';terrainReference.value=true;await nextTick();expect(textOf(root)).toContain('强 ≥20 dB');expect(mapCalls.coverage).toHaveBeenCalledOnce();display.value='field';
      const frequency=find(root,n=>n.props['aria-label']==='覆盖频点')!;
      await (frequency.props.onChange as (event:unknown)=>Promise<void>)({target:{value:'157000'}});await nextTick();expect(textOf(root)).toContain('55.5 dBμV/m');expect(textOf(root)).not.toContain('22.5 dBμV/m');expect(mapCalls.coverage).toHaveBeenCalledTimes(2);
      frequencyKhz.value=156000;await nextTick();
      display.value='boundary';await nextTick();expect(textOf(root)).toContain('遇缺格或计算边缘不补闭合');expect(textOf(root)).not.toContain('dBμV/m');
      device.computations[0].geojson.features=[];frame.value={...frame.value};await nextTick();expect(textOf(root)).toContain('完整采样未提供，请刷新覆盖结果');expect(textOf(root)).not.toContain('达标格面外缘');
      expect(mapCalls.coverage).toHaveBeenCalledTimes(2);
      (deviceSelector.props['onUpdate:modelValue'] as Function)('UNKNOWN');await (deviceSelector.props.onChange as Function)();await nextTick();expect(coverageVisible.value).toBe(false);expect(textOf(root)).toContain('此设备未提供可显示的覆盖');expect(mapCalls.coverage).toHaveBeenCalledTimes(2);
      newest.value=newPlan;await nextTick();await (find(root,n=>n.tag==='button'&&textOf(n)==='切换查看')!.props.onClick as ()=>Promise<void>)();await nextTick();
      const selector=find(root,n=>n.props.id==='situation-plan')!;expect(selector.props.value).toBe('P2');expect(selector.children.some(n=>n.tag==='option'&&n.props.value==='P2')).toBe(true);expect(catalog).toHaveBeenCalledWith(1);
    }finally{app.unmount();disposePinia(pinia);}
  });
  it('同值身份回执不重复重置页面，实际撤权和恢复才重新读取', async () => {
    vi.stubGlobal('document', { hidden: false });
    const pinia = createPinia(); setActivePinia(pinia);
    const auth = authorizeStore(), permissions = [...auth.identity!.permissions];
    let reads = 0;
    const query = vi.spyOn(previewService, 'querySavedPlanningPlans').mockImplementation(async () => {
      // 复现公开服务每次读取重新接纳同值身份；上限让回归失败也能结束。
      if (++reads <= 8) auth.accept({ ...auth.identity!, permissions: [...permissions] });
      return { items: [], total: 0, pageNum: 1, pageSize: 10 };
    });
    const root = node('root'), app = renderer.createApp(GisSituationView);
    app.use(pinia); app.component('RouterLink', { render: () => null }); app.provide(ssrContextKey, {});
    try {
      app.mount(root);
      for (let i = 0; i < 30; i++) await nextTick();
      expect(query).toHaveBeenCalledTimes(1); expect(textOf(root)).toContain('GIS 态势');
      expect(textOf(root)).toContain('尚无已保存');
      auth.accept({ ...auth.identity!, permissions: permissions.filter(p => p !== 'planning.view') });
      await nextTick(); expect(query).toHaveBeenCalledTimes(1);
      auth.accept({ ...auth.identity!, permissions });
      for (let i = 0; i < 30; i++) await nextTick();
      expect(query).toHaveBeenCalledTimes(2);
    } finally { app.unmount(); disposePinia(pinia); }
  });
});

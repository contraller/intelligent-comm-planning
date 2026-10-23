import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useInterferenceStore } from '../stores/interference';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import { configuredStations, planStations } from '../services/planning-snapshot';
import type { Countermeasure } from '../types/interference';
import type { Station } from '../types/domain';

export interface InterferenceTargetAction {
  kind: 'node' | 'link'; id: string; label: string; reason: string;
  locate: () => Promise<void>;
}
export interface InterferenceTargetEntry {
  measureId: string; stateLabel: string; targets: InterferenceTargetAction[];
}
interface Navigation {
  blockedReason: () => string;
  show: (kind: 'node' | 'link', id: string) => void;
  locate: () => void;
  hidden: () => boolean;
}

// 只定位服务返回的目标和冻结坐标，不选择台账同名对象，不提交业务请求。
export function useInterferenceTargetNavigation(navigation: Navigation) {
  const auth=useAuthStore(), store=useInterferenceStore(), gis=useGisWorkspaceStore();
  const epoch=ref(0), notice=ref(''); let serial=0, active=true;
  const blockedReason=computed(()=>auth.blocked || !store.readable ? '需要有效会话及 GIS、网络规划查看权限'
    : store.locked ? '请先等待当前分析操作完成' : navigation.blockedReason());
  // 对象引用和深层变动均使旧按钮失效；单调代次同时隔离 A→B→A。
  watch([()=>store.selected,()=>store.measureId,()=>store.after,()=>store.effectiveAfter,()=>gis.mapMode,
    ()=>auth.generation,()=>auth.identity?.sessionId,()=>auth.identity?.id,()=>auth.blocked,
    ()=>auth.can('situation.view'),()=>auth.can('planning.view'),blockedReason],()=>{epoch.value++;notice.value='';},{deep:true,flush:'sync'});
  onBeforeUnmount(()=>{active=false;serial++;});
  const validCoordinate=(value:unknown)=>Array.isArray(value)&&value.length===2&&value.every(v=>typeof v==='number'&&Number.isFinite(v))&&Math.abs(value[0])<=180&&Math.abs(value[1])<=90;
  function entry(measure:Countermeasure, after:boolean, drawer:boolean):InterferenceTargetEntry {
    const version=epoch.value, selected=store.selected;
    const stateLabel=after?'措施后':'措施前';
    const preview=after?store.selectedMeasurePreview?.result:null;
    let stations:Station[]=[];
    // 异常快照只关闭定位能力，不能在生成按钮时中断整页渲染。
    try { stations=preview?configuredStations(preview.inputSnapshot.stations,preview.configuration):selected?planStations(selected.run.network):[]; } catch { /* 下方显示缺少可定位对象。 */ }
    const links=preview?.links??selected?.run.network.links??[];
    const targets:InterferenceTargetAction[]=[];
    for(const kind of ['node','link'] as const){
      const id=kind==='node'?measure.targetNodeId:measure.targetLinkId;
      if(!id)continue;
      const nodes=kind==='node'?stations.filter(row=>row.id===id):[];
      const matches=kind==='link'?links.filter(row=>row.id===id):[];
      const link=matches[0];
      const endpoints=link?[stations.filter(row=>row.id===link.a),stations.filter(row=>row.id===link.b)]:[];
      const objectReason=kind==='node'?(nodes.length!==1?'冻结网络中未找到唯一节点':!validCoordinate(nodes[0]!.coordinate)?'节点坐标无效':'')
        :matches.length!==1?'冻结网络中未找到唯一链路':link!.a===link!.b||endpoints.some(rows=>rows.length!==1)?'链路缺少唯一的两端节点':endpoints.some(rows=>!validCoordinate(rows[0]!.coordinate))?'链路端点坐标无效':'';
      const reason=blockedReason.value||objectReason;
      targets.push({kind,id,label:`定位${kind==='node'?'节点':'链路'}（${stateLabel}）`,reason,async locate(){
        if(!active||version!==epoch.value||reason||blockedReason.value||selected!==store.selected||drawer&&!store.measureOpen)return;
        const request=++serial;
        // 先核对旧事件，再切换本次定位自己的显示状态；不改图层偏好或输入。
        store.measureId=measure.id;store.after=after;gis.mapMode='analysis';
        navigation.show(kind,id);
        if(drawer)store.measureOpen=false;
        const displayVersion=epoch.value;
        await nextTick();
        if(!active||request!==serial||displayVersion!==epoch.value||blockedReason.value)return;
        navigation.locate();
        notice.value=kind==='link'&&navigation.hidden()?'已定位链路；拓扑当前隐藏，可在图层管理恢复显示。':`已定位${kind==='node'?'节点':'链路'} ${id}（${stateLabel}）`;
      }});
    }
    return {measureId:measure.id,stateLabel,targets};
  }
  const list=computed(()=>{epoch.value;return store.selected?.result?.measures.map(measure=>entry(measure,false,false))??[];});
  const drawer=computed(()=>{epoch.value;return store.measure?entry(store.measure,store.effectiveAfter,true):null;});
  return {list,drawer,notice};
}

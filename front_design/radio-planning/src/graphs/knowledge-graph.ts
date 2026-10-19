import type { KnowledgeGraph } from '../types/knowledge';

const categories=['设备知识','网络态势知识','故障运维知识'];
const colors=['#4f9cd9','#38ad9d','#bf8ee6'];
const symbols=['circle','roundRect','diamond','triangle','rect'];
// 仅为小规模图形安排位置，不把关系遍历用于故障推理或业务判定。
export function knowledgeGraphModel(graph:KnowledgeGraph,selectedId:string,typeIds:string[],relationNames:Record<string,string>,matchedIds:readonly string[] = []) {
  const selected=graph.entities.find(e=>e.id===selectedId);
  const matches=new Set(matchedIds);
  const others=graph.entities.filter(e=>e.id!==selected?.id);
  const nodes=graph.entities.map(e=>{
    const index=others.findIndex(n=>n.id===e.id),angle=index/Math.max(others.length,1)*Math.PI*2;
    const active=e.id===selectedId;
    // 明确点选优先于命中高亮；概览仍保留分类颜色与实体形状。
    const matched=!selected&&matches.has(e.id);
    return {id:e.id,name:e.name,x:active?450:450+Math.cos(angle)*320,y:active?300:300+Math.sin(angle)*230,symbol:symbols[Math.max(0,typeIds.indexOf(e.type))%symbols.length],symbolSize:active?76:matched?58:48,category:categories.indexOf(e.category),itemStyle:{color:colors[categories.indexOf(e.category)],opacity:(selected&&!active)||(!selected&&matches.size>0&&!matched)?0.55:1,borderWidth:active||matched?3:1,borderColor:active?'#eef9ff':matched?'#f0ce79':'#416883'},label:{show:true,color:'#def0ff',fontSize:11,formatter:e.name.length>10?e.name.slice(0,9)+'…':e.name}};
  });
  const typeLegend=[...new Set(graph.entities.map(e=>e.type))].map(type=>({type,symbol:['●','▰','◆','▲','■'][Math.max(0,typeIds.indexOf(type))%symbols.length]}));
  return {nodes,links:graph.relations.map(r=>({id:r.id,source:r.head,target:r.tail,value:relationNames[r.type]??r.type})),legend:categories.map((name,i)=>({name,color:colors[i]})),typeLegend,truncated:graph.totalNodes>nodes.length||graph.totalEdges>graph.relations.length};
}

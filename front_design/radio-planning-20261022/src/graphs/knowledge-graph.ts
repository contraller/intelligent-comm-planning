import type { KnowledgeGraph } from '../types/knowledge';

const categories=['设备知识','网络态势知识','故障运维知识'];
const colors=['#4798d1','#6db9ee','#e4a15c','#a8c2dc','#5fbfb6','#7d9fe1','#bb91d9','#d6ba6a','#4bbda0','#78cc89','#91b7ed','#c7d879','#73c6d3','#d8ad79','#d47c89','#ea9e77','#d7a7d9','#bb90e5','#829ee0','#7ac2b1','#9bb6cb','#d3bd8c'];
const symbols=['circle','roundRect','diamond','triangle','rect'];
const glyphs=['●','▰','◆','▲','■'];
// 只计算显示位置、标签和样式，不推导业务关系或状态。
export function knowledgeGraphModel(graph:KnowledgeGraph,selectedId:string,typeIds:string[],relationNames:Record<string,string>,matchedIds:readonly string[] = []) {
  const selected=graph.entities.find(e=>e.id===selectedId);
  const matches=new Set(matchedIds);
  const others=graph.entities.filter(e=>e.id!==selected?.id);
  const dense=graph.entities.length>32;
  const visibleCategories=categories.filter(category=>graph.entities.some(e=>e.category===category));
  // 分类分区按两列排列，避免三类全部横排时压缩成一条窄带。
  const groups=visibleCategories.map(category=>graph.entities.filter(e=>e.category===category));
  const columns=groups.map(group=>Math.ceil(Math.sqrt(group.length)));
  const width=Math.max(0,...columns.map(count=>(count-1)*130))+210;
  const height=Math.max(0,...groups.map((group,i)=>(Math.ceil(group.length/columns[i])-1)*130))+200;
  const style=(type:string)=>{const index=Math.max(0,typeIds.indexOf(type));return {color:colors[index%colors.length],symbol:symbols[index%symbols.length],glyph:glyphs[index%symbols.length]};};
  const nodes=graph.entities.map(e=>{
    const index=others.findIndex(n=>n.id===e.id),ring=Math.floor(index/12),count=Math.min(12,others.length-ring*12),angle=(index%12)/Math.max(count,1)*Math.PI*2;
    const active=e.id===selectedId;
    // 明确点选优先于命中高亮；概览仍保留分类颜色与实体形状。
    const matched=!selected&&matches.has(e.id);
    const category=visibleCategories.indexOf(e.category),group=groups[category],local=group.findIndex(n=>n.id===e.id),countColumns=columns[category];
    const offsetX=category===2?width/2:(category%2)*width;
    const x=selected?(active?450:450+Math.cos(angle)*(180+ring*105)):offsetX+100+(local%countColumns)*130;
    const y=selected?(active?300:300+Math.sin(angle)*(160+ring*85)):100+Math.floor(category/2)*height+Math.floor(local/countColumns)*130;
    return {id:e.id,name:e.name,x,y,symbol:style(e.type).symbol,symbolSize:active?76:matched?58:48,category:categories.indexOf(e.category),itemStyle:{color:style(e.type).color,opacity:(selected&&!active)||(!selected&&matches.size>0&&!matched)?0.55:1,borderWidth:active||matched?3:1,borderColor:active?'#eef9ff':matched?'#f0ce79':'#416883'},label:{show:!dense||active||(matched&&matches.size<=12),position:'bottom',color:'#def0ff',fontSize:11,formatter:e.name.length>8?e.name.slice(0,7)+'…':e.name},emphasis:{label:{show:true,formatter:e.name,backgroundColor:'#102439',padding:5}}};
  });
  const legend=visibleCategories.map(name=>({name,items:[...new Set(graph.entities.filter(e=>e.category===name).map(e=>e.type))].map(type=>({type,...style(type)}))}));
  // 密集概览隐藏边标签，悬停或选中后显示关联关系，减少交叉文字。
  const links=graph.relations.map(r=>({id:r.id,source:r.head,target:r.tail,value:relationNames[r.type]??r.type,label:{show:!!selected&&(r.head===selectedId||r.tail===selectedId)||graph.entities.length<=12},lineStyle:{opacity:selected?(r.head===selectedId||r.tail===selectedId?0.8:0.15):matches.size?(matches.has(r.head)||matches.has(r.tail)?0.6:0.12):0.3}}));
  return {nodes,links,legend,truncated:graph.totalNodes>nodes.length||graph.totalEdges>graph.relations.length};
}

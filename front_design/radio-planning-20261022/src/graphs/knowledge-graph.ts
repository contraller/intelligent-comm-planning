import type { KnowledgeEntity, KnowledgeGraph } from '../types/knowledge';
import { knowledgeEntityName, knowledgeRelationName } from '../services/knowledge-display';
import { knowledgeMedia } from '../config/knowledge-media';

const categories=['设备知识','网络态势知识','故障运维知识'];
const colors=['#4798d1','#6db9ee','#e4a15c','#a8c2dc','#5fbfb6','#7d9fe1','#bb91d9','#d6ba6a','#4bbda0','#78cc89','#91b7ed','#c7d879','#73c6d3','#d8ad79','#d47c89','#ea9e77','#d7a7d9','#bb90e5','#829ee0','#7ac2b1','#9bb6cb','#d3bd8c'];
const symbols=['circle','roundRect','diamond','triangle','rect'];
const glyphs=['●','▰','◆','▲','■'];
export interface KnowledgeGraphViewport { width:number; height:number }
// 只计算显示位置、标签和样式，不推导业务关系或状态。
export function knowledgeGraphModel(graph:KnowledgeGraph,selectedId:string,typeIds:string[],relationNames:Record<string,string>,matchedIds:readonly string[] = [],viewport?:KnowledgeGraphViewport,failedMedia:readonly string[]=[],entities:ReadonlyMap<string,KnowledgeEntity>=new Map()) {
  const selected=graph.entities.find(e=>e.id===selectedId);
  const matches=new Set(matchedIds);
  const others=graph.entities.filter(e=>e.id!==selected?.id);
  const dense=graph.entities.length>32;
  const visibleCategories=categories.filter(category=>graph.entities.some(e=>e.category===category));
  // 保留原概览位置与一屏布局；分类分区按两列排列，不按实体类型拉成长列表。
  const groups=visibleCategories.map(category=>graph.entities.filter(e=>e.category===category));
  const columns=groups.map(group=>Math.ceil(Math.sqrt(group.length)));
  const width=Math.max(0,...columns.map(count=>(count-1)*130))+210;
  const height=Math.max(0,...groups.map((group,i)=>(Math.ceil(group.length/columns[i])-1)*130))+200;
  const style=(type:string)=>{const index=Math.max(0,typeIds.indexOf(type));return {color:colors[index%colors.length],symbol:symbols[index%symbols.length],glyph:glyphs[index%symbols.length]};};
  const nodes=graph.entities.map(e=>{
    const detail=entities.get(e.id);
    const fullEntity=detail?.name===e.name&&detail.type===e.type?detail:undefined;
    const entity=fullEntity??e;
    const candidate=knowledgeMedia(entity);
    const photo=candidate&&!failedMedia.includes(candidate.url)?candidate:null;
    const realName=fullEntity?.attributes.find(attribute=>attribute.name===(e.type==='DeviceModel'?'model_name':e.type==='Antenna'?'antenna_name':''))?.value;
    const displayName=realName||photo?.name||knowledgeEntityName(e);
    // 常驻短标签保留设备编号；悬停仍显示完整中文名称，不改点击标识。
    const labelName=/^(DV|DM|AM|ND|LK|FC)-\d+$/.test(e.name)&&!realName&&!photo?e.name:displayName;
    const index=others.findIndex(n=>n.id===e.id),ring=Math.floor(index/12),count=Math.min(12,others.length-ring*12),angle=(index%12)/Math.max(count,1)*Math.PI*2;
    const active=e.id===selectedId;
    const symbol=style(e.type).symbol;
    // 明确点选优先于命中高亮；概览仍保留分类颜色与实体形状。
    const matched=!selected&&matches.has(e.id);
    const category=visibleCategories.indexOf(e.category),group=groups[category],local=group.findIndex(n=>n.id===e.id),countColumns=columns[category];
    const offsetX=category===2?width/2:(category%2)*width;
    const x=selected?(active?450:450+Math.cos(angle)*(180+ring*105)):offsetX+100+(local%countColumns)*130;
    const y=selected?(active?300:300+Math.sin(angle)*(160+ring*85)):100+Math.floor(category/2)*height+Math.floor(local/countColumns)*130;
    return {id:e.id,name:displayName,x,y,symbol,photo,symbolKeepAspect:true,symbolSize:photo?(active?120:matched?104:88):(active?76:matched?58:48),category:categories.indexOf(e.category),itemStyle:{color:style(e.type).color,opacity:(selected&&!active)||(!selected&&matches.size>0&&!matched)?(photo?0.9:0.55):1,borderWidth:active||matched?3:1,borderColor:active?'#eef9ff':matched?'#f0ce79':'#416883'},label:{show:!selected||!dense||active,position:'bottom',color:'#def0ff',fontSize:!selected&&dense?10:11,distance:3,width:selected?undefined:88,overflow:'truncate',ellipsis:'…',formatter:selected?(labelName.length>8?labelName.slice(0,7)+'…':labelName):labelName},emphasis:{label:{show:true,formatter:displayName,width:undefined,overflow:'none',backgroundColor:'#102439',padding:5}}};
  });
  const legend=visibleCategories.map(name=>({name,items:[...new Set(graph.entities.filter(e=>e.category===name).map(e=>e.type))].map(type=>({type,...style(type),hasPhoto:graph.entities.some(entity=>entity.category===name&&entity.type===type&&nodes.find(node=>node.id===entity.id)?.photo)}))}));
  // 图坐标随画布缩放，符号以像素绘制；限制最近邻占比以留出关系线通道。
  if(viewport&&Number.isFinite(viewport.width)&&Number.isFinite(viewport.height)&&viewport.width>0&&viewport.height>0&&nodes.length>1) {
    const spanX=Math.max(...nodes.map(node=>node.x))-Math.min(...nodes.map(node=>node.x));
    const spanY=Math.max(...nodes.map(node=>node.y))-Math.min(...nodes.map(node=>node.y));
    const scale=Math.min(spanX?Math.max(1,viewport.width-40)/spanX:Infinity,spanY?Math.max(1,viewport.height-40)/spanY:Infinity);
    let nearest=Infinity;
    for(let i=0;i<nodes.length;i++) for(let j=i+1;j<nodes.length;j++) nearest=Math.min(nearest,Math.hypot(nodes[i].x-nodes[j].x,nodes[i].y-nodes[j].y));
    const size=Math.min(dense?32:48,Math.max(2,nearest*scale*0.42));
    for(const node of nodes) {
      // 照片宽度按自身最近邻留白计算；中央型号不被外圈的密集设备挤成小缩略图。
      const photoSpace=node.photo?Math.min(...nodes.filter(other=>other!==node).map(other=>Math.hypot(node.x-other.x,node.y-other.y)))*scale*0.85:0;
      node.symbolSize=Math.min(node.symbolSize,node.photo?Math.max(12,photoSpace):size*(node.id===selectedId?76/48:matches.has(node.id)&&!selected?58/48:1));
      node.itemStyle.borderWidth=Math.min(node.itemStyle.borderWidth,Math.max(1,node.symbolSize/10));
      // 名称占用原节点间隙，不反过来撑大布局；完整名称通过悬停查看。
      if(!selected)node.label.width=Math.max(18,Math.min(88,nearest*scale*0.9-6));
    }
  }
  // 关系多时只通过单条边悬停展示名称，不因中心节点选中而同时挤出全部关系文字。
  const links=graph.relations.map(r=>({id:r.id,source:r.head,target:r.tail,value:knowledgeRelationName(r.type,relationNames[r.type]),label:{show:graph.relations.length<=12},lineStyle:{opacity:selected?(r.head===selectedId||r.tail===selectedId?0.85:0.15):matches.size?(matches.has(r.head)||matches.has(r.tail)?0.4:0.07):0.12,width:selected?1.5:1}}));
  const edgeSymbolSize=Math.min(7,Math.max(3,Math.min(...nodes.map(node=>node.symbolSize),35)/5));
  const renderedNodes=nodes.map(node=>{
    if(!node.photo)return node;
    const imageWidth=Math.max(1,node.symbolSize-12),imageHeight=imageWidth/node.photo.aspect;
    const formatter=`{photo|}\n{title|${node.name}}`;
    // 富文本明确图片宽高，避免图片缓存命中后 symbolKeepAspect 失效；透明节点承载选中描边。
    return {...node,symbol:'roundRect',photoSize:[node.symbolSize,imageHeight+30] as [number,number],itemStyle:{...node.itemStyle,color:'transparent',borderWidth:node.id===selectedId||(!selected&&matches.has(node.id))?2:0},label:{...node.label,show:true,position:'inside',formatter,rich:{photo:{backgroundColor:{image:node.photo.url},width:imageWidth,height:imageHeight,align:'center',lineHeight:imageHeight+4},title:{color:'#def0ff',fontSize:node.label.fontSize,align:'center',lineHeight:20}}},emphasis:{label:{show:true,formatter,width:undefined,overflow:'none'},itemStyle:{borderColor:'#9bdcff',borderWidth:2}}};
  });
  return {nodes:renderedNodes,links,legend,edgeSymbolSize,truncated:graph.totalNodes>nodes.length||graph.totalEdges>graph.relations.length};
}

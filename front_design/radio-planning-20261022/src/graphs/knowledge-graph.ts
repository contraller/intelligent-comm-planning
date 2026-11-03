import type { KnowledgeEntity, KnowledgeGraph } from '../types/knowledge';
import { knowledgeEntityName, knowledgeRelationName } from '../services/knowledge-display';
import { knowledgeMedia } from '../config/knowledge-media';

const categories=['设备知识','网络态势知识','故障运维知识'];
const colors=['#4798d1','#6db9ee','#e4a15c','#a8c2dc','#5fbfb6','#7d9fe1','#bb91d9','#d6ba6a','#4bbda0','#78cc89','#91b7ed','#c7d879','#73c6d3','#d8ad79','#d47c89','#ea9e77','#d7a7d9','#bb90e5','#829ee0','#7ac2b1','#9bb6cb','#d3bd8c'];
const symbols=['circle','roundRect','diamond','triangle','rect'];
const glyphs=['●','▰','◆','▲','■'];
export interface KnowledgeGraphViewport { width:number; height:number }
interface GraphPosition { x:number; y:number }
let overviewCache: { key:string; positions:Map<string,GraphPosition> } | undefined;

function overviewPositions(graph:KnowledgeGraph) {
  const ids=graph.entities.map(entity=>entity.id).sort();
  const adjacency=new Map(ids.map(id=>[id,new Set<string>()]));
  for(const relation of graph.relations) {
    if(relation.head===relation.tail||!adjacency.has(relation.head)||!adjacency.has(relation.tail))continue;
    adjacency.get(relation.head)!.add(relation.tail);
    adjacency.get(relation.tail)!.add(relation.head);
  }
  const edges=ids.flatMap(id=>[...adjacency.get(id)!].filter(other=>id<other).sort().map(other=>[id,other] as const));
  const key=JSON.stringify([ids,edges]);
  if(overviewCache?.key===key)return overviewCache.positions;
  // 仅以实际连通关系分组；方向仍由原始关系箭头表达，不推导新的知识关联。
  const visited=new Set<string>(),groups:string[][]=[];
  for(const id of ids) {
    if(visited.has(id))continue;
    const group=[id];visited.add(id);
    for(let i=0;i<group.length;i++)for(const neighbor of [...adjacency.get(group[i])!].sort()) {
      if(!visited.has(neighbor)){visited.add(neighbor);group.push(neighbor);}
    }
    groups.push(group.sort((a,b)=>adjacency.get(b)!.size-adjacency.get(a)!.size||a.localeCompare(b)));
  }
  groups.sort((a,b)=>b.length-a.length||a[0].localeCompare(b[0]));
  const positions=new Map<string,GraphPosition>(),occupied:{x:number;y:number;radius:number}[]=[];
  const goldenAngle=Math.PI*(3-Math.sqrt(5));
  for(const group of groups) {
    const indexes=new Map(group.map((id,i)=>[id,i]));
    const localEdges=edges.filter(([a,b])=>indexes.has(a)&&indexes.has(b)).map(([a,b])=>[indexes.get(a)!,indexes.get(b)!]);
    const points=group.map((_,i)=>({x:Math.cos(i*goldenAngle)*95*Math.sqrt(i),y:Math.sin(i*goldenAngle)*95*Math.sqrt(i)}));
    // 固定初始位置、边顺序和迭代次数，计算完成后静态绘制，避免刷新/搜索时跳动。
    for(let step=0;step<240&&points.length>1;step++) {
      const force=points.map(point=>({x:-point.x*0.025,y:-point.y*0.025}));
      for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++) {
        const dx=points[i].x-points[j].x,dy=points[i].y-points[j].y,distance=Math.max(1,Math.hypot(dx,dy));
        const strength=19600/(distance*distance);
        force[i].x+=dx*strength;force[i].y+=dy*strength;
        force[j].x-=dx*strength;force[j].y-=dy*strength;
      }
      for(const [a,b] of localEdges) {
        const dx=points[b].x-points[a].x,dy=points[b].y-points[a].y,distance=Math.max(1,Math.hypot(dx,dy));
        const strength=distance/400;
        force[a].x+=dx*strength;force[a].y+=dy*strength;
        force[b].x-=dx*strength;force[b].y-=dy*strength;
      }
      const limit=35*Math.pow(1-step/240,1.5)+0.15;
      for(let i=0;i<points.length;i++) {
        const length=Math.hypot(force[i].x,force[i].y),factor=Math.min(1,limit/Math.max(length,0.001));
        points[i].x+=force[i].x*factor;points[i].y+=force[i].y*factor;
      }
    }
    // 确保局部密集关联仍有符号和短标签的空间，不把整图重新排回网格。
    for(let pass=0;pass<40;pass++)for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++) {
      let dx=points[j].x-points[i].x,dy=points[j].y-points[i].y;
      let distance=Math.hypot(dx,dy);
      if(distance>=100)continue;
      if(distance<0.001){dx=Math.cos(j*goldenAngle);dy=Math.sin(j*goldenAngle);distance=1;}
      const shift=(100-distance)/2;
      points[i].x-=dx/distance*shift;points[i].y-=dy/distance*shift;
      points[j].x+=dx/distance*shift;points[j].y+=dy/distance*shift;
    }
    const centerX=(Math.min(...points.map(point=>point.x))+Math.max(...points.map(point=>point.x)))/2;
    const centerY=(Math.min(...points.map(point=>point.y))+Math.max(...points.map(point=>point.y)))/2;
    for(const point of points){point.x-=centerX;point.y-=centerY;}
    const radius=Math.max(...points.map(point=>Math.hypot(point.x,point.y)))+65;
    let x=0,y=0;
    // 不连通的关系群与孤立实体沿空位疏开；留白只表达排布，不代表业务分级。
    for(let attempt=0;occupied.some(other=>Math.hypot(x-other.x,y-other.y)<radius+other.radius+45);attempt++) {
      const distance=85*Math.sqrt(attempt+1);
      x=Math.cos(attempt*goldenAngle)*distance;y=Math.sin(attempt*goldenAngle)*distance;
    }
    occupied.push({x,y,radius});
    group.forEach((id,i)=>positions.set(id,{x:450+x+points[i].x,y:300+y+points[i].y}));
  }
  // 只缓存最近一次图结构的显示坐标；不缓存或改写实体详情与关系数据。
  overviewCache={key,positions};
  return positions;
}
// 只计算显示位置、标签和样式，不推导业务关系或状态。
export function knowledgeGraphModel(graph:KnowledgeGraph,selectedId:string,typeIds:string[],relationNames:Record<string,string>,matchedIds:readonly string[] = [],viewport?:KnowledgeGraphViewport,failedMedia:readonly string[]=[],entities:ReadonlyMap<string,KnowledgeEntity>=new Map()) {
  const selected=graph.entities.find(e=>e.id===selectedId);
  const matches=new Set(matchedIds);
  const others=graph.entities.filter(e=>e.id!==selected?.id);
  const dense=graph.entities.length>32;
  const visibleCategories=categories.filter(category=>graph.entities.some(e=>e.category===category));
  const overview=selected?undefined:overviewPositions(graph);
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
    const x=selected?(active?450:450+Math.cos(angle)*(180+ring*105)):overview!.get(e.id)!.x;
    const y=selected?(active?300:300+Math.sin(angle)*(160+ring*85)):overview!.get(e.id)!.y;
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
      const localSpace=Math.min(...nodes.filter(other=>other!==node).map(other=>Math.hypot(node.x-other.x,node.y-other.y)))*scale;
      // 照片宽度按自身最近邻留白计算；中央型号不被外圈的密集设备挤成小缩略图。
      const photoSpace=node.photo?localSpace*0.85:0;
      // 概览按每个实体附近的空间缩放，避免一处密集关联把整图缩成细点。
      const localSize=selected?size:matches.has(node.id)?(dense?30:48):Math.min(dense?30:48,Math.max(8,localSpace*0.6));
      node.symbolSize=Math.min(node.symbolSize,node.photo?Math.max(12,photoSpace):localSize*(node.id===selectedId?76/48:matches.has(node.id)&&!selected?58/48:1));
      node.itemStyle.borderWidth=Math.min(node.itemStyle.borderWidth,Math.max(1,node.symbolSize/10));
      if(!selected)node.label.width=Math.max(48,Math.min(88,localSpace*1.6));
    }
    if(!selected&&dense) {
      // 优先显示搜索命中和关联较多的实体名称；拥挤标签悬停再显示，避免只剩满屏省略号。
      const degree=new Map(nodes.map(node=>[node.id,0]));
      for(const relation of graph.relations)for(const id of [relation.head,relation.tail])degree.set(id,(degree.get(id)??0)+1);
      const captions:{x:number;y:number;width:number;height:number}[]=[];
      const ordered=[...nodes].sort((a,b)=>Number(matches.has(b.id))-Number(matches.has(a.id))||(degree.get(b.id)??0)-(degree.get(a.id)??0)||a.id.localeCompare(b.id));
      for(const node of ordered) {
        if(node.photo)continue;
        const box={x:node.x*scale,y:node.y*scale+node.symbolSize/2+10,width:Math.min(node.label.width!,node.label.formatter.length*10),height:14};
        const overlapsLabel=captions.some(other=>Math.abs(box.x-other.x)<(box.width+other.width)/2+5&&Math.abs(box.y-other.y)<(box.height+other.height)/2+3);
        const overlapsNode=nodes.some(other=>other!==node&&Math.abs(box.x-other.x*scale)<box.width/2+other.symbolSize/2+3&&Math.abs(box.y-other.y*scale)<box.height/2+other.symbolSize/2+3);
        node.label.show=matches.has(node.id)||(!overlapsLabel&&!overlapsNode);
        if(node.label.show)captions.push(box);
      }
    }
  }
  // 关系多时只通过单条边悬停展示名称，不因中心节点选中而同时挤出全部关系文字。
  const links=graph.relations.map(r=>({id:r.id,source:r.head,target:r.tail,value:knowledgeRelationName(r.type,relationNames[r.type]),label:{show:graph.relations.length<=12},lineStyle:{opacity:selected?(r.head===selectedId||r.tail===selectedId?0.85:0.15):matches.size?(matches.has(r.head)||matches.has(r.tail)?0.4:0.07):0.4,width:selected?1.5:1}}));
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

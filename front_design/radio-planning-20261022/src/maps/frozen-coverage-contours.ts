import type { FrozenCoverageGrid } from '../types/frozen-coverage';

type Point = [number, number];
export interface CoverageIsoline { value:number; coordinates:Point[] }
const key = (x:number,y:number) => `${x},${y}`;
const pointKey = (p:Point) => key(Math.round(p[0]*1e8),Math.round(p[1]*1e8));

// 拼接共享端点，保留计算边缘和缺格处的开放端；不沿数据外缘补闭合线。
function joinSegments(segments:[Point,Point][]):Point[][] {
  const ends=new Map<string,number[]>();
  segments.forEach((segment,i)=>segment.forEach(p=>{const k=pointKey(p),list=ends.get(k)??[];list.push(i);ends.set(k,list);}));
  const used=new Set<number>(),lines:Point[][]=[];
  const walk=(start:Point,index:number)=>{
    const points=[start];let cursor=start,next:number|undefined=index;
    while(next!==undefined&&!used.has(next)){
      used.add(next);const segment:[Point,Point]=segments[next]!,other:Point=pointKey(segment[0])===pointKey(cursor)?segment[1]:segment[0];
      points.push(other);cursor=other;next=ends.get(pointKey(other))?.find(i=>!used.has(i));
    }
    if(points.length>1)lines.push(points);
  };
  for(const [end,indices] of ends)if(indices.length===1){const i=indices[0]!,segment=segments[i]!;walk(segment.find(p=>pointKey(p)===end)!,i);}
  segments.forEach((segment,i)=>{if(!used.has(i))walk(segment[0],i);});
  return lines;
}

/** 在四角均有有效采样的格间做双线性插值；采样中心不是方格外缘。 */
export function coverageIsolines(grid:FrozenCoverageGrid,levels:readonly number[],component:2|3):CoverageIsoline[] {
  const samples=new Map(grid.samples.map(sample=>[key(sample[0],sample[1]),sample]));
  const segments=levels.map(()=>[] as [Point,Point][]);
  // 限制大网格显示细分；只影响折线逼近，不改变预测值和门限。
  const divisions=grid.samples.length<3000?8:grid.samples.length<20000?4:1;
  for(const a of grid.samples){
    const [x,y]=a,b=samples.get(key(x+1,y)),c=samples.get(key(x+1,y+1)),d=samples.get(key(x,y+1));
    if(!b||!c||!d)continue;
    const values=[a[component],b[component],c[component],d[component]];
    const lo=Math.min(...values),hi=Math.max(...values);
    if(lo===hi)continue;
    const value=(u:number,v:number)=>values[0]!*(1-u)*(1-v)+values[1]!*u*(1-v)+values[2]!*u*v+values[3]!*(1-u)*v;
    for(let j=0;j<divisions;j++)for(let i=0;i<divisions;i++){
      const u=i/divisions,v=j/divisions,h=1/divisions;
      const points:Point[]=[[x+u,y+v],[x+u+h,y+v],[x+u+h,y+v+h],[x+u,y+v+h]];
      const z=[value(u,v),value(u+h,v),value(u+h,v+h),value(u,v+h)];
      levels.forEach((level,index)=>{
        if(level<=lo||level>hi)return;
        const hits:Point[]=[];
        for(let edge=0;edge<4;edge++){
          const n=(edge+1)%4,za=z[edge]!-level,zb=z[n]!-level;
          if((za>=0)===(zb>=0))continue;
          const t=za/(za-zb),p=points[edge]!,q=points[n]!;
          hits.push([p[0]+t*(q[0]-p[0]),p[1]+t*(q[1]-p[1])]);
        }
        const add=(p:Point,q:Point)=>{if(pointKey(p)!==pointKey(q))segments[index]!.push([p,q]);};
        if(hits.length===2)add(hits[0]!,hits[1]!);
        else if(hits.length===4){
          // 双曲鞍点用渐近判别配对，避免把两个独立高值区跨接。
          const determinant=(z[0]!-level)*(z[2]!-level)-(z[1]!-level)*(z[3]!-level);
          if(determinant>=0){add(hits[0]!,hits[1]!);add(hits[2]!,hits[3]!);}
          else{add(hits[0]!,hits[3]!);add(hits[1]!,hits[2]!);}
        }
      });
    }
  }
  const dx=grid.cell_m/(111320*Math.cos(grid.origin[1]*Math.PI/180)),dy=grid.cell_m/111320;
  return levels.flatMap((level,i)=>joinSegments(segments[i]!).map(points=>({value:level,coordinates:points.map(p=>[grid.origin[0]+p[0]*dx,grid.origin[1]+p[1]*dy] as Point)})));
}

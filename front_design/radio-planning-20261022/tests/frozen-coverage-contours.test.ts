import { describe,expect,it } from 'vitest';
import { coverageIsolines } from '../src/maps/frozen-coverage-contours';
import type { FrozenCoverageGrid,FrozenCoverageSample } from '../src/types/frozen-coverage';

const grid=(fn:(x:number,y:number)=>number,size=5):FrozenCoverageGrid=>({origin:[114,37.5],cell_m:2000,radius_m:10000,
  samples:Array.from({length:size*size},(_,i)=>{const x=i%size,y=Math.floor(i/size),v=fn(x,y);return [x,y,v,v-10,null,null,null] as FrozenCoverageSample;})});
const local=(g:FrozenCoverageGrid,p:number[])=>[(p[0]!-g.origin[0])*111320*Math.cos(g.origin[1]*Math.PI/180)/g.cell_m,(p[1]!-g.origin[1])*111320/g.cell_m];

describe('覆盖等值线遵守实际采样与门限',()=>{
  it('6 dB门限在采样中心之间插值，北向和原点不发生半格偏移',()=>{
    const g=grid(x=>x*20,2),before=JSON.stringify(g),lines=coverageIsolines(g,[6],3);
    expect(lines).toHaveLength(1);
    const coordinates=lines[0]!.coordinates.map(p=>local(g,p));
    coordinates.forEach(p=>expect(p[0]).toBeCloseTo(.8,8));
    expect(Math.min(...coordinates.map(p=>p[1]!))).toBeCloseTo(0,8);
    expect(Math.max(...coordinates.map(p=>p[1]!))).toBeCloseTo(1,8);
    expect(JSON.stringify(g)).toBe(before);
  });
  it('全域达标或全域未达标不沿计算外缘造边界，孤立采样不外推',()=>{
    expect(coverageIsolines(grid(()=>50),[6],3)).toEqual([]);
    expect(coverageIsolines(grid(()=>0),[6],3)).toEqual([]);
    expect(coverageIsolines(grid(()=>50,1),[20,40,60],2)).toEqual([]);
  });
  it('缺失样本切断等值线，开放端不沿空洞或外缘补闭合',()=>{
    const g=grid(x=>x*20);g.samples=g.samples.filter(s=>!(s[0]===2&&s[1]===2));
    const lines=coverageIsolines(g,[30],2);
    expect(lines).toHaveLength(2);
    for(const line of lines){
      expect(line.coordinates[0]).not.toEqual(line.coordinates.at(-1));
      for(const p of line.coordinates){const [x,y]=local(g,p);expect(x).toBeCloseTo(1.5,8);expect(y!<=1+1e-8||y!>=3-1e-8).toBe(true);}
    }
  });
  it('固定绝对刻度下不同预测值形成不同位置，局部峰值可自然闭合',()=>{
    const g=grid((x,y)=>80-15*((x-2)**2+(y-2)**2));
    const original=coverageIsolines(g,[40],2);
    expect(original).toHaveLength(1);expect(original[0]!.coordinates[0]).toEqual(original[0]!.coordinates.at(-1));
    const shifted=structuredClone(g);shifted.samples.forEach(s=>{s[2]-=20;s[3]-=20;});
    expect(coverageIsolines(shifted,[40],2)).not.toEqual(original);
  });
});

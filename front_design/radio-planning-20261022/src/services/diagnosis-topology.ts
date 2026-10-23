import type { EChartsCoreOption } from 'echarts/core';
import type { GraphSeriesOption } from 'echarts/charts';
import type { PlanVersion } from '../types/domain';
import type { DiagnosisPropagationPath, FaultInput } from '../types/diagnosis';
import { diagnosisFaultVisual } from './diagnosis-display';

// 分组坐标仅服务排版；不改变站点归属、通信端点或传播顺序。
export function diagnosisTopology(network: PlanVersion, faults: FaultInput[], affectedNodes: string[], affectedLinks: string[], paths: DiagnosisPropagationPath[], expanded: string[], selected: Pick<FaultInput, 'objectType' | 'objectId'> | null): EChartsCoreOption {
  const nodes: NonNullable<GraphSeriesOption['data']> = [], links: NonNullable<GraphSeriesOption['links']> = [];
  const positions = new Map<string, [number, number]>();
  const endpoints = new Set(network.links.flatMap(link => [link.deviceA, link.deviceB]));
  const visibleDevices = network.inputSnapshot.devices.filter(device => expanded.includes(device.stationId) || endpoints.has(device.id) ||
    faults.some(f => f.objectType === 'DEVICE' && f.objectId === device.id) ||
    paths.some(path => path.steps.some(step => step.objectType === 'DEVICE' && step.objectId === device.id)) ||
    selected?.objectType === 'DEVICE' && selected.objectId === device.id);
  const add = (type: FaultInput['objectType'], id: string, name: string, x: number, y: number, affected: boolean, size: number) => {
    const injected = faults.find(f => f.objectType === type && f.objectId === id), visual = injected && diagnosisFaultVisual(injected.faultType);
    const identity = `${type}:${id}`; positions.set(identity, [x,y]);
    nodes.push({ id: identity, name, x, y, symbolSize: size, symbol: visual?.symbol ?? (type === 'LINK' ? 'roundRect' : type === 'DEVICE' ? 'rect' : 'circle'),
      itemStyle: { color: affected ? '#e47589' : type === 'DEVICE' ? '#386b91' : '#398d85', borderColor: visual?.color ?? '#8ab5c7', borderWidth: visual ? 3 : 1 },
      label: { show: true, position: 'bottom', color: '#c0d5e9', fontSize: 11, formatter: () => name + (visual ? `\n场景注入 · ${visual.glyph} ${visual.label}` : '') } });
  };
  network.inputSnapshot.stations.forEach((station,index) => {
    const x=(index % 3)*360, y=Math.floor(index/3)*300;
    const devices=visibleDevices.filter(d => d.stationId === station.id), total=network.inputSnapshot.devices.filter(d => d.stationId === station.id).length;
    add('NODE',station.id,`${station.id}\n${station.name}${total > devices.length ? `\n另有 ${total-devices.length} 台设备可展开` : ''}`,x,y,affectedNodes.includes(station.id),32);
    devices.forEach((device,i) => {
      const dx=x+(i%4-1.5)*83, dy=y+100+Math.floor(i/4)*76;
      add('DEVICE',device.id,device.id,dx,dy,affectedNodes.includes(station.id),20);
      links.push({ source:`NODE:${station.id}`,target:`DEVICE:${device.id}`,lineStyle:{color:'#466179',type:'dotted'},symbol:['none','none'] });
    });
  });
  for (const link of network.links) links.push({ id:`LINK:${link.id}`,name:link.id,source:`DEVICE:${link.deviceA}`,target:`DEVICE:${link.deviceB}`,
    label:{show:true,formatter:() => link.id+(link.backup?' · 备份':'')+(faults.some(f => f.objectType==='LINK'&&f.objectId===link.id) ? '\n场景注入 · '+diagnosisFaultVisual(faults.find(f => f.objectType==='LINK'&&f.objectId===link.id)!.faultType).label : ''),color:'#aac2d7'},
    lineStyle:{color:affectedLinks.includes(link.id)?'#eb8392':'#5489b4',width:selected?.objectType==='LINK'&&selected.objectId===link.id?4:2,type:link.backup?'dashed':'solid'} });
  // 传播中的链路使用独立锚点，箭头只连接服务已给的有序步骤。
  for (const path of paths) {
    for (const step of path.steps.filter(step => step.objectType === 'LINK')) {
      if (positions.has(`LINK:${step.objectId}`)) continue;
      const link=network.links.find(link => link.id===step.objectId), a=link&&positions.get(`DEVICE:${link.deviceA}`), b=link&&positions.get(`DEVICE:${link.deviceB}`);
      if (a&&b) add('LINK',step.objectId,`传播 · ${step.objectId}`,(a[0]+b[0])/2,(a[1]+b[1])/2,true,16);
    }
    path.steps.slice(1).forEach((step,i) => links.push({ id:`PROP:${path.id}:${i}`,source:`${path.steps[i].objectType}:${path.steps[i].objectId}`,target:`${step.objectType}:${step.objectId}`,
      symbol:['none','arrow'],symbolSize:9,lineStyle:{color:'#8ce4ee',type:'dashed',width:3,curveness:0.12},label:{show:false} }));
  }
  return { tooltip:{trigger:'item'},series:[{type:'graph',layout:'none',roam:true,data:nodes,links,edgeSymbol:['none','none'],emphasis:{focus:'adjacency'}}] };
}

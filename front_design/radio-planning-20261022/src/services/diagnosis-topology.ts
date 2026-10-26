import type { EChartsCoreOption } from 'echarts/core';
import type { GraphSeriesOption } from 'echarts/charts';
import type { PlanVersion } from '../types/domain';
import type { DiagnosisPropagationPath, FaultInput } from '../types/diagnosis';
import { diagnosisFaultVisual } from './diagnosis-display';

const objectLabels = { NODE: '节点', DEVICE: '设备', LINK: '链路' };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

// 分组坐标仅服务排版；不改变站点归属、通信端点或传播顺序。
export function diagnosisTopology(network: PlanVersion, faults: FaultInput[], affectedNodes: string[], affectedLinks: string[], paths: DiagnosisPropagationPath[], expanded: string[], selected: Pick<FaultInput, 'objectType' | 'objectId'> | null, viewport = { width: 800, height: 500 }): EChartsCoreOption {
  const nodes: NonNullable<GraphSeriesOption['data']> = [], links: NonNullable<GraphSeriesOption['links']> = [];
  const positions = new Map<string, [number, number]>();
  const width = Number.isFinite(viewport.width) && viewport.width > 0 ? viewport.width : 800;
  const height = Number.isFinite(viewport.height) && viewport.height > 0 ? viewport.height : 500;
  const plotWidth = Math.max(1, width - 64), plotHeight = Math.max(1, height - 80);
  const endpoints = new Set(network.links.flatMap(link => [link.deviceA, link.deviceB]));
  const visibleDevices = network.inputSnapshot.devices.filter(device => expanded.includes(device.stationId) || endpoints.has(device.id) ||
    faults.some(f => f.objectType === 'DEVICE' && f.objectId === device.id) ||
    paths.some(path => path.steps.some(step => step.objectType === 'DEVICE' && step.objectId === device.id)) ||
    selected?.objectType === 'DEVICE' && selected.objectId === device.id);
  const groups = network.inputSnapshot.stations.map(station => {
    const devices = visibleDevices.filter(device => device.stationId === station.id);
    return { station, devices, height: 100 + Math.ceil(devices.length / 4) * 60 };
  });
  // 固定三列会把大网络压成细长条；按画布比例选列数，并为展开后的设备行预留高度。
  let columns = 1, fitScale = 0;
  for (let count = 1; count <= groups.length; count++) {
    let totalHeight = 0;
    for (let i = 0; i < groups.length; i += count) totalHeight += Math.max(...groups.slice(i, i + count).map(group => group.height));
    const scale = Math.min(plotWidth / (count * 280), plotHeight / totalHeight);
    if (scale > fitScale) { fitScale = scale; columns = count; }
  }
  type Label = { show: boolean; align?: 'left' | 'right' | 'center'; position?: string };
  const labels: { x: number; y: number; size: number; priority: number; edge: boolean; label: Label }[] = [];
  const labelStyle = { color: '#c0d5e9', fontSize: 11, lineHeight: 14, width: 132, overflow: 'truncate' as const, backgroundColor: '#101e33', padding: [3, 5], borderRadius: 3 };
  const add = (type: FaultInput['objectType'], id: string, name: string, x: number, y: number, affected: boolean, size: number) => {
    const injected = faults.find(f => f.objectType === type && f.objectId === id), visual = injected && diagnosisFaultVisual(injected.faultType);
    const isSelected = selected?.objectType === type && selected.objectId === id;
    const symbolSize = Math.min(size, Math.max(type === 'NODE' ? 5 : 3, size * fitScale));
    const identity = `${type}:${id}`; positions.set(identity, [x,y]);
    const label = { ...labelStyle, show: false, position: 'bottom' as 'bottom' | 'top', align: 'center' as 'left' | 'right' | 'center', formatter: () => id + (visual ? `\n场景注入 · ${visual.glyph} ${visual.label}` : '') };
    const device = type === 'DEVICE' && visibleDevices.find(device => device.id === id);
    const node = { id: identity, name, x, y, symbolSize, symbol: visual?.symbol ?? (type === 'LINK' ? 'roundRect' : type === 'DEVICE' ? 'rect' : 'circle'),
      description: `${objectLabels[type]}：${escapeHtml(name).replace(/\n/g, '<br/>')}${device ? `<br/>归属节点：${escapeHtml(device.stationId)}` : ''}<br/>${affected ? '受影响对象' : '未标记影响'}${visual ? `<br/>场景注入 · ${visual.glyph} ${visual.label}` : ''}`,
      itemStyle: { color: affected ? '#e47589' : type === 'DEVICE' ? '#386b91' : '#398d85', borderColor: visual?.color ?? (isSelected ? '#ffe098' : '#8ab5c7'), borderWidth: visual || isSelected ? 2 : 1, shadowBlur: isSelected ? 8 : 0, shadowColor: '#ffe098' },
      label, emphasis: { label: { show: true } } };
    nodes.push(node);
    if (type !== 'LINK' && (isSelected || visual)) labels.push({ x, y, size: symbolSize, priority: isSelected ? 0 : 1, edge: false, label });
  };
  let rowY = 0;
  groups.forEach(({ station, devices }, index) => {
    if (index && index % columns === 0) rowY += Math.max(...groups.slice(index - columns, index).map(group => group.height));
    const x = (index % columns) * 280, y = rowY;
    const total=network.inputSnapshot.devices.filter(d => d.stationId === station.id).length;
    add('NODE',station.id,`${station.id}\n${station.name}${total > devices.length ? `\n另有 ${total-devices.length} 台设备可展开` : ''}`,x,y,affectedNodes.includes(station.id),32);
    devices.forEach((device,i) => {
      const dx=x+(i%4-(Math.min(devices.length,4)-1)/2)*60, dy=y+70+Math.floor(i/4)*60;
      add('DEVICE',device.id,device.id,dx,dy,affectedNodes.includes(station.id),20);
      const ownership = { source:`NODE:${station.id}`,target:`DEVICE:${device.id}`,description:`设备归属：${escapeHtml(station.id)} → ${escapeHtml(device.id)}`,lineStyle:{color:'#466179',type:'dotted' as const,width:1},symbol:['none','none'],label:{show:false},emphasis:{label:{show:false}} };
      links.push(ownership);
    });
  });
  for (const link of network.links) {
    const injected = faults.find(f => f.objectType === 'LINK' && f.objectId === link.id), visual = injected && diagnosisFaultVisual(injected.faultType);
    const isSelected = selected?.objectType === 'LINK' && selected.objectId === link.id;
    const label = { ...labelStyle, show: false, rotate: 0, formatter: () => link.id + (link.backup ? ' · 备份' : '') + (visual ? `\n场景注入 · ${visual.glyph} ${visual.label}` : '') };
    const edge = { id:`LINK:${link.id}`,name:link.id,source:`DEVICE:${link.deviceA}`,target:`DEVICE:${link.deviceB}`, label,
      description: `链路：${escapeHtml(link.id)}<br/>端点设备：${escapeHtml(link.deviceA)} → ${escapeHtml(link.deviceB)}<br/>${link.backup ? '备份链路' : '规划链路'} · ${link.frequencyKhz} kHz<br/>${affectedLinks.includes(link.id) ? '受影响链路' : '未标记影响'}${visual ? `<br/>场景注入 · ${visual.glyph} ${visual.label}` : ''}`,
      emphasis: { label: { show: true } },
      lineStyle:{color:affectedLinks.includes(link.id)?'#eb8392':visual?.color ?? '#5489b4',width:isSelected?4:injected?3:1,type:link.backup?'dashed' as const:'solid' as const} };
    links.push(edge);
    const a = positions.get(edge.source), b = positions.get(edge.target);
    if ((isSelected || visual) && a && b) labels.push({ x: (a[0]+b[0])/2, y: (a[1]+b[1])/2, size: 0, priority: isSelected ? 0 : 1, edge: true, label });
  }
  // 传播中的链路使用独立锚点，箭头只连接服务已给的有序步骤。
  for (const path of paths) {
    for (const step of path.steps.filter(step => step.objectType === 'LINK')) {
      if (positions.has(`LINK:${step.objectId}`)) continue;
      const link=network.links.find(link => link.id===step.objectId), a=link&&positions.get(`DEVICE:${link.deviceA}`), b=link&&positions.get(`DEVICE:${link.deviceB}`);
      if (a&&b) add('LINK',step.objectId,`传播 · ${step.objectId}`,(a[0]+b[0])/2,(a[1]+b[1])/2,true,16);
    }
    path.steps.slice(1).forEach((step,i) => {
      const propagation = { id:`PROP:${path.id}:${i}`,source:`${path.steps[i].objectType}:${path.steps[i].objectId}`,target:`${step.objectType}:${step.objectId}`,
        description:`故障传播：${objectLabels[path.steps[i].objectType]} ${escapeHtml(path.steps[i].objectId)} → ${objectLabels[step.objectType]} ${escapeHtml(step.objectId)}<br/>${escapeHtml(step.reason || path.reason)}`,
        symbol:['none','arrow'],symbolSize:7,lineStyle:{color:'#8ce4ee',type:'dashed' as const,width:2,curveness:0.12},label:{show:false},emphasis:{label:{show:false}} };
      links.push(propagation);
    });
  }
  // 按初始屏幕位置避让常显标签；选中对象先占位，其他完整名称始终可悬浮查看。
  const points = [...positions.values()], xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys), rangeX = Math.max(...xs)-minX, rangeY = Math.max(...ys)-minY;
  const occupied: { x: number; y: number; width: number; height: number }[] = [];
  for (const candidate of labels.sort((a,b) => a.priority-b.priority)) {
    const x = 32 + (rangeX ? (candidate.x-minX)/rangeX : 0.5) * plotWidth;
    const y = 32 + (rangeY ? (candidate.y-minY)/rangeY : 0.5) * plotHeight;
    const top = y > height-96;
    const align = x < 79 ? 'left' : x > width-79 ? 'right' : 'center';
    const rect = { x: align === 'left' ? x : align === 'right' ? x-142 : x-71, y: candidate.edge ? y-20 : top ? y-candidate.size/2-44 : y+candidate.size/2+4, width: 142, height: 40 };
    if (candidate.priority && (occupied.length >= 6 || occupied.some(other => rect.x < other.x+other.width && rect.x+rect.width > other.x && rect.y < other.y+other.height && rect.y+rect.height > other.y))) continue;
    candidate.label.show = true;
    candidate.label.align = align;
    if (!candidate.edge) candidate.label.position = top ? 'top' : 'bottom';
    occupied.push(rect);
  }
  return { animation:false, tooltip:{trigger:'item',confine:true,formatter:(params: unknown) => (params as {data?:{description?:string}}).data?.description ?? ''},series:[{type:'graph',layout:'none',roam:true,left:32,right:32,top:32,bottom:48,preserveAspect:false,scaleLimit:{min:0.5,max:12},nodeScaleRatio:0.5,data:nodes,links,edgeSymbol:['none','none'],edgeLabel:{show:false},emphasis:{focus:'self',label:{show:true},edgeLabel:{show:true}}}] };
}

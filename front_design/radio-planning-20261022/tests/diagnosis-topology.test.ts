import { describe, expect, it } from 'vitest';
import { diagnosisTopology } from '../src/services/diagnosis-topology';
import { diagnosisPresetResult } from '../src/mocks/diagnosis-result-presets';
import { diagnosisPresets } from '../src/mocks/diagnosis-presets';
import { planningPresets } from '../src/mocks/planning-presets';
import legacy from '../src/mocks/planning.json';
import type { PlanVersion } from '../src/types/domain';
import type { FaultInput } from '../src/types/diagnosis';
import { init, use } from 'echarts/core';
import { GraphChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

use([GraphChart, TooltipComponent, SVGRenderer]);

// 检查真实对象身份与展开行为，不把排版坐标当作业务结果。
const network = legacy.plans[0] as unknown as PlanVersion;
const graph = (expanded: string[] = [], selected: { objectType: 'DEVICE'; objectId: string } | null = null) => {
  const option=diagnosisTopology(network,[],[],[],[],expanded,selected);
  return (option.series as any[])[0] as {data:any[];links:any[]};
};
describe('诊断拓扑分组', () => {
  it('默认不铺开全部设备，全部规划链路仍保留精确端点及身份', () => {
    const before=JSON.stringify(network),result=graph();
    expect(result.data.filter(row => row.id.startsWith('DEVICE:')).length).toBeLessThan(network.inputSnapshot.devices.length);
    for (const link of network.links) expect(result.links.find(row => row.id===`LINK:${link.id}`)).toMatchObject({source:`DEVICE:${link.deviceA}`,target:`DEVICE:${link.deviceB}`});
    expect(JSON.stringify(network)).toBe(before);
  });
  it('展开站点和定位隐藏设备都保留具体设备 ID', () => {
    const first=network.inputSnapshot.stations[0],devices=network.inputSnapshot.devices.filter(d => d.stationId===first.id);
    const expanded=graph([first.id]);for(const device of devices)expect(expanded.data.some(row => row.id===`DEVICE:${device.id}`)).toBe(true);
    const hidden=network.inputSnapshot.devices.find(d => !graph().data.some(row => row.id===`DEVICE:${d.id}`))!;
    expect(graph([],{objectType:'DEVICE',objectId:hidden.id}).data.some(row => row.id===`DEVICE:${hidden.id}`)).toBe(true);
  });
  it('传播箭头保持服务步骤顺序，独立于原有备份链路', () => {
    const preset=diagnosisPresets[0],paths=diagnosisPresetResult(preset,'diagnosis-demo-2','normal').propagationPaths!;
    // 只以预设对应的三站输入检查传播图，避免拼接不同版本身份。
    const scenarioNetwork={...network,inputSnapshot:structuredClone(planningPresets[0].baseline),links:structuredClone(planningPresets[0].result!.links)} as PlanVersion;
    const result=(diagnosisTopology(scenarioNetwork,preset.faults,[],[],paths,[],null).series as any[])[0];
    const arrows=result.links.filter((row:any) => row.id?.startsWith('PROP:'));
    expect(arrows).toHaveLength(3);expect(arrows[0]).toMatchObject({source:'DEVICE:DV-0027',target:'NODE:ND-0003',symbol:['none','arrow']});
    expect(arrows[2]).toMatchObject({source:'LINK:LINK-A',target:'NODE:ND-0001'});
    expect(result.links.find((row:any) => row.id==='LINK:LINK-C').lineStyle.type).toBe('dashed');
  });
});

// 仅供规模回归的合成夹具，不读取运行库，也不作为业务拓扑输出。
function largeNetwork(): PlanVersion {
  const stations = Array.from({ length: 142 }, (_, i) => ({ ...network.inputSnapshot.stations[0], id: `TEST-N-${i}`, name: `测试节点 ${i}` }));
  const devices = stations.flatMap(station => Array.from({ length: 3 }, (_, i) => ({ ...network.inputSnapshot.devices[0], id: `${station.id}-D-${i}`, stationId: station.id })));
  const links = Array.from({ length: 159 }, (_, i) => {
    const a = stations[i % stations.length], b = stations[(i + 1) % stations.length];
    return { ...network.links[0], id: `TEST-L-${i}`, a: a.id, b: b.id, deviceA: `${a.id}-D-0`, deviceB: `${b.id}-D-1`, backup: i % 5 === 0 };
  });
  return { ...network, inputSnapshot: { stations, devices }, stationIds: stations.map(station => station.id), links };
}

describe('诊断拓扑大网络排版', () => {
  it.each([{ width: 360, height: 350 }, { width: 440, height: 350 }, { width: 960, height: 560 }])('142 站 / 159 链路在 $width × $height 画布保留身份、边距和分散坐标', viewport => {
    const snapshot = largeNetwork(), before = JSON.stringify(snapshot);
    const option = diagnosisTopology(snapshot, [], [], [], [], [], null, viewport);
    const series = (option.series as any[])[0];
    expect(series.layout).toBe('none');
    expect(option.animation).toBe(false);
    expect(series.data.filter((row: any) => row.id.startsWith('NODE:'))).toHaveLength(142);
    expect(series.links.filter((row: any) => row.id?.startsWith('LINK:'))).toHaveLength(159);
    const identities = new Set(series.data.map((row: any) => row.id));
    for (const link of snapshot.links) {
      expect(series.links.find((row: any) => row.id === `LINK:${link.id}`)).toMatchObject({ source: `DEVICE:${link.deviceA}`, target: `DEVICE:${link.deviceB}` });
      expect(identities.has(`DEVICE:${link.deviceA}`)).toBe(true);
      expect(identities.has(`DEVICE:${link.deviceB}`)).toBe(true);
    }
    expect(new Set(series.data.filter((row: any) => row.id.startsWith('NODE:')).map((row: any) => row.x)).size).toBeGreaterThan(3);
    // 使用 ECharts 自身的 SVG SSR 坐标变换；不启动浏览器或 Canvas，不执行 force。
    const chart = init(null, undefined, { renderer: 'svg', ssr: true, ...viewport });
    try {
      chart.setOption(option);
      const model = (chart as any).getModel().getSeriesByIndex(0);
      expect(model.getData().count()).toBe(series.data.length);
      expect(model.getEdgeData().count()).toBe(series.links.length);
      const points = series.data.map((row: any) => ({ ...row, point: model.coordinateSystem.dataToPoint([row.x, row.y]) as [number, number] }));
      for (const row of points) {
        expect(row.point.every(Number.isFinite)).toBe(true);
        expect(row.point[0] - row.symbolSize / 2).toBeGreaterThanOrEqual(20);
        expect(row.point[0] + row.symbolSize / 2).toBeLessThanOrEqual(viewport.width - 20);
        expect(row.point[1] - row.symbolSize / 2).toBeGreaterThanOrEqual(20);
        expect(row.point[1] + row.symbolSize / 2).toBeLessThanOrEqual(viewport.height - 20);
      }
      expect(Math.max(...points.map((row: any) => row.point[0])) - Math.min(...points.map((row: any) => row.point[0]))).toBeGreaterThan(viewport.width * 0.75);
      let clearance = Infinity, closest = '';
      for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
        const a = points[i], b = points[j];
        const gap = Math.hypot(a.point[0] - b.point[0], a.point[1] - b.point[1]) - (a.symbolSize + b.symbolSize) / 2;
        if (gap < clearance) { clearance = gap; closest = `${a.id} / ${b.id}`; }
      }
      expect(clearance, closest).toBeGreaterThan(1);
      expect(chart.renderToSVGString()).toContain('<svg');
    } finally { chart.dispose(); }
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('普通对象仅悬浮显示完整中文提示，悬浮不铺开邻接对象的标签', () => {
    const snapshot = largeNetwork(), option = diagnosisTopology(snapshot, [], [], [], [], [], null);
    const series = (option.series as any[])[0], tooltip = (option.tooltip as any).formatter;
    expect(series.data.every((row: any) => row.label.show === false)).toBe(true);
    expect(series.links.every((row: any) => row.label.show === false)).toBe(true);
    expect(series.emphasis.focus).toBe('self');
    expect(tooltip({ data: series.data.find((row: any) => row.id === 'NODE:TEST-N-0') })).toContain('节点：TEST-N-0<br/>测试节点 0');
    expect(tooltip({ data: series.data.find((row: any) => row.id === 'DEVICE:TEST-N-0-D-0') })).toContain('归属节点：TEST-N-0');
    const link = series.links.find((row: any) => row.id === 'LINK:TEST-L-0');
    expect(tooltip({ data: link })).toContain('备份链路');
    expect(tooltip({ data: link })).toContain('端点设备：TEST-N-0-D-0 → TEST-N-1-D-1');
  });

  it('选中标签先占位，大量注入标签受限但类型轮廓、影响填色与备份线型保留', () => {
    const snapshot = largeNetwork();
    const faults: FaultInput[] = snapshot.inputSnapshot.stations.slice(0, 20).map(station => ({ objectType: 'NODE', objectId: station.id, faultType: 'HW_FAILURE', symptomIds: [], occurTime: null, interferenceId: null }));
    faults.push({ ...faults[0], objectType: 'LINK', objectId: snapshot.links[0].id, faultType: 'EMI' });
    const paths = [{ id: 'test-path', faultKey: 'test-fault', level: 'SEVERE' as const, reason: '服务给定传播', steps: [{ objectType: 'LINK' as const, objectId: snapshot.links[0].id, reason: '起点' }, { objectType: 'NODE' as const, objectId: snapshot.links[0].b, reason: '终点' }] }];
    const option = diagnosisTopology(snapshot, faults, [snapshot.inputSnapshot.stations[0].id], [snapshot.links[0].id], paths, [], { objectType: 'LINK', objectId: snapshot.links[0].id }, { width: 440, height: 350 });
    const series = (option.series as any[])[0], selected = series.links.find((row: any) => row.id === 'LINK:TEST-L-0');
    expect(selected.label.show).toBe(true);
    expect(selected.label.formatter()).toContain('场景注入 · ✦ 电磁干扰');
    expect(selected.lineStyle).toMatchObject({ color: '#eb8392', width: 4, type: 'dashed' });
    expect(series.data.find((row: any) => row.id === 'NODE:TEST-N-0')).toMatchObject({ symbol: 'diamond', itemStyle: { color: '#e47589', borderColor: '#c895ed' } });
    expect(series.data.find((row: any) => row.id === 'LINK:TEST-L-0').label.show).toBe(false);
    expect(series.data.filter((row: any) => row.label.show).length + series.links.filter((row: any) => row.label.show).length).toBeLessThanOrEqual(6);
    expect(series.links.find((row: any) => row.id === 'PROP:test-path:0')).toMatchObject({ source: 'LINK:TEST-L-0', target: 'NODE:TEST-N-1', symbol: ['none', 'arrow'] });
    expect((option.tooltip as any).formatter({ data: series.data.find((row: any) => row.id === 'NODE:TEST-N-19') })).toContain('硬件故障');
  });

  it('展开设备超过原固定站点行高时重新预留空间，隐藏设备仍可单独选中', () => {
    const snapshot = largeNetwork(), first = snapshot.inputSnapshot.stations[0];
    snapshot.inputSnapshot.devices.push(...Array.from({ length: 30 }, (_, i) => ({ ...snapshot.inputSnapshot.devices[0], id: `TEST-EXPAND-${i}`, stationId: first.id })));
    const before = JSON.stringify(snapshot);
    const expanded = (diagnosisTopology(snapshot, [], [], [], [], [first.id], null).series as any[])[0];
    const coordinates = expanded.data.map((row: any) => `${row.x}:${row.y}`);
    expect(new Set(coordinates).size).toBe(coordinates.length);
    for (const device of snapshot.inputSnapshot.devices.filter(device => device.stationId === first.id)) expect(expanded.data.some((row: any) => row.id === `DEVICE:${device.id}`)).toBe(true);
    const selected = (diagnosisTopology(snapshot, [], [], [], [], [], { objectType: 'DEVICE', objectId: 'TEST-EXPAND-29' }).series as any[])[0];
    expect(selected.data.find((row: any) => row.id === 'DEVICE:TEST-EXPAND-29').label.show).toBe(true);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('悬浮内容转义来源名称，零尺寸输入有有限坐标及稳定回退', () => {
    const snapshot = largeNetwork();
    snapshot.inputSnapshot.stations[0].name = '<img src=x onerror=alert(1)>';
    const option = diagnosisTopology(snapshot, [], [], [], [], [], null, { width: 0, height: 0 }), series = (option.series as any[])[0];
    const tip = (option.tooltip as any).formatter({ data: series.data[0] });
    expect(tip).toContain('&lt;img'); expect(tip).not.toContain('<img');
    expect(series.data.every((row: any) => Number.isFinite(row.x) && Number.isFinite(row.y) && Number.isFinite(row.symbolSize))).toBe(true);
  });
});

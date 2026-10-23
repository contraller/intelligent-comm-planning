import { describe, expect, it } from 'vitest';
import { diagnosisTopology } from '../src/services/diagnosis-topology';
import { diagnosisPresetResult } from '../src/mocks/diagnosis-result-presets';
import { diagnosisPresets } from '../src/mocks/diagnosis-presets';
import { planningPresets } from '../src/mocks/planning-presets';
import legacy from '../src/mocks/planning.json';
import type { PlanVersion } from '../src/types/domain';

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

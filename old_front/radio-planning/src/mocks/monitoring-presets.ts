import { planningPresets } from './planning-presets';
import { interferenceVariants } from './interference-presets';
import type { NetworkObservationFrame, DeviceObservation, LinkObservation, MonitoringNetwork } from '../types/monitoring';
import type { PlanningResult } from '../types/planning';
import { MONITORING_PRESET_VERSION } from '../config/demo';

const deviceIds = ['DV-0001', 'DV-0002', 'DV-0027', 'DV-0028', 'DV-0037', 'DV-0038'];
const stationIds = ['ND-0001', 'ND-0001', 'ND-0003', 'ND-0003', 'ND-0004', 'ND-0004'];
const linkIds = ['LINK-A', 'LINK-B', 'LINK-C'];
const times = ['2026-10-05T09:00:00+08:00', '2026-10-05T09:00:30+08:00', '2026-10-05T09:01:00+08:00', '2026-10-05T09:01:30+08:00'];
const labels = ['正常观测', '功率越限与链路预警', '设备故障及链路中断', '恢复观测'];
interface Profile { id: string; power: number[]; frequency: number[]; snr: number[] }
// 每种网络明确配套观测常量，不能用规划功率/频率计算监控值或链路质量。
const profiles: Profile[] = [
  { id: 'balanced', power: [44.2,44.4,44.1,44.3,44.2,44.4], frequency: [6000,8000,6000,10000,8000,10000], snr: [20.2,18.1,17.4] },
  { id: 'economical', power: [39.2,39.4,39.1,39.3,39.2,39.4], frequency: [6000,8000,6000,10000,8000,10000], snr: [18.3,16.2,15.7] },
  { id: 'device-balanced', power: [44.1,44.2,44.3,44.1,44.4,44.2], frequency: [6000,8000,6000,10000,8000,10000], snr: [20.4,18.4,17.2] },
  { id: 'balanced:FREQ_ADJUST', power: [44.2,44.3,44.1,44.3,44.4,44.2], frequency: [6000,9000,6000,10000,9000,10000], snr: [20.2,21.3,17.4] },
  { id: 'balanced:CHANNEL_SWITCH', power: [44.2,44.4,44.1,44.3,44.2,44.4], frequency: [6000,8300,6000,10000,8300,10000], snr: [20.2,20.6,17.4] },
  { id: 'balanced:POWER_OPT', power: [44.2,48.4,44.1,44.3,48.2,44.4], frequency: [6000,8000,6000,10000,8000,10000], snr: [20.2,20.1,17.4] },
  { id: 'balanced:ROUTE_REBUILD', power: [44.2,44.4,44.1,44.3,44.2,44.4], frequency: [6000,8000,6000,10000,8000,10000], snr: [20.6,18.1,19.4] },
  { id: 'balanced:NODE_REDEPLOY', power: [44.2,44.4,44.1,44.3,44.2,44.4], frequency: [6000,8000,6000,10000,8000,10000], snr: [20.2,21.8,20.4] },
  { id: 'economical:FREQ_ADJUST', power: [39.2,39.3,39.1,39.3,39.4,39.2], frequency: [6000,9000,6000,10000,9000,10000], snr: [18.3,20.3,15.7] },
  { id: 'economical:CHANNEL_SWITCH', power: [39.2,39.4,39.1,39.3,39.2,39.4], frequency: [6000,8300,6000,10000,8300,10000], snr: [18.3,19.6,15.7] },
  { id: 'economical:POWER_OPT', power: [39.2,48.4,39.1,39.3,48.2,39.4], frequency: [6000,8000,6000,10000,8000,10000], snr: [18.3,19.1,15.7] },
  { id: 'economical:NODE_REDEPLOY', power: [39.2,39.4,39.1,39.3,39.2,39.4], frequency: [6000,8000,6000,10000,8000,10000], snr: [18.3,20.8,18.4] },
];
export interface MonitoringPreset { id: string; network: MonitoringNetwork; frames: NetworkObservationFrame[] }
function frames(profile: Profile): NetworkObservationFrame[] {
  return times.map((observedAt, phase) => {
    const devices: DeviceObservation[] = deviceIds.map((deviceId, index) => {
      const offline = phase === 2 && index === 5, fault = phase === 2 && index === 1;
      const powerAlert = (phase === 1 || phase === 2) && index === 1;
      return { deviceId, stationId: stationIds[index], status: offline ? 'OFFLINE' : fault ? 'FAULT' : 'NORMAL',
        online: !offline, alarm: powerAlert || offline,
        txPowerDbm: offline ? null : powerAlert ? 56.4 : profile.power[index],
        frequencyKhz: offline ? null : fault ? 11500 : profile.frequency[index],
        violations: [...(powerAlert ? [{field:'txPowerDbm' as const,message:'预生成告警：发射功率超过演示允许范围'}] : []),
          ...(fault ? [{field:'frequencyKhz' as const,message:'预生成告警：工作频率偏离演示分配范围'}] : [])] };
    });
    const links: LinkObservation[] = linkIds.map((linkId, index) => {
      const fault = phase === 2 && index === 1, warning = phase === 1 && index === 1;
      return { linkId, state: fault ? 'FAULT' : warning ? 'WARNING' : index === 0 || phase === 3 && index === 1 ? 'EXCELLENT' : 'GOOD',
        snrDb: fault ? null : warning ? 7.2 : profile.snr[index],
        ber: fault ? null : warning ? 0.002 : [0.00000001,0.0000001,0.0000001][index],
        packetLossRate: fault ? 1 : warning ? 0.08 : [0.001,0.003,0.005][index],
        delayMs: fault ? null : warning ? 180 : [22,31,38][index],
        throughputKbps: fault ? 0 : warning ? 1.2 : [64,32,16][index] };
    });
    // 对写明的观测做计数仅用于图表分布；状态、越限与业务指标均由上方常量指定。
    const frequencies = [...new Set(devices.flatMap(row => row.frequencyKhz === null ? [] : [row.frequencyKhz]))].sort((a,b)=>a-b);
    return { id: profile.id + ':' + phase, observedAt, label: labels[phase], devices, links,
      statistics: {
        devices: { total: 6, normal: phase === 2 ? 4 : 6, fault: phase === 2 ? 1 : 0, offline: phase === 2 ? 1 : 0,
          online: phase === 2 ? 5 : 6, alarms: phase === 2 ? 2 : phase === 1 ? 1 : 0 },
        links: { EXCELLENT: phase === 3 ? 2 : 1, GOOD: phase === 1 || phase === 2 || phase === 3 ? 1 : 2, WARNING: phase === 1 ? 1 : 0, FAULT: phase === 2 ? 1 : 0 },
        power: [
          {label:'≤40 dBm',count:devices.filter(row=>row.txPowerDbm !== null && row.txPowerDbm <= 40).length},
          {label:'40–50 dBm',count:devices.filter(row=>row.txPowerDbm !== null && row.txPowerDbm > 40 && row.txPowerDbm <= 50).length},
          {label:'>50 dBm',count:devices.filter(row=>row.txPowerDbm !== null && row.txPowerDbm > 50).length},
        ],
        frequency: frequencies.map(value=>({label:value+' kHz',count:devices.filter(row=>row.frequencyKhz===value).length})),
      },
      alerts: phase === 1 ? [{id:'AL-POWER',deviceId:'DV-0002',linkId:null,level:'WARNING',message:'功率越限；链路 B 质量预警'}]
        : phase === 2 ? [
          {id:'AL-FAULT',deviceId:'DV-0002',linkId:'LINK-B',level:'FAULT',message:'设备故障、频率异常及链路 B 中断'},
          {id:'AL-OFFLINE',deviceId:'DV-0038',linkId:null,level:'WARNING',message:'设备离线，当前采样值未提供'},
        ] : [],
    };
  });
}
export const monitoringPresets: MonitoringPreset[] = profiles.map(profile => {
  const base = planningPresets.find(row => row.id === profile.id.split(':')[0])!;
  const result = (profile.id.includes(':') ? interferenceVariants.find(row => row.id === profile.id)!.result : base.result!) as PlanningResult;
  const links = structuredClone(result.links);
  // 仅内置均衡监控演示补充教学标记；不改规划预设、已保存方案或其确认网络。
  if (profile.id === 'balanced') {
    const backbone: Record<string, boolean> = { 'LINK-A': true, 'LINK-B': true, 'LINK-C': false };
    for (const link of links) link.isBackbone = backbone[link.id];
  }
  return { id: profile.id, network: {
    key: '', kind: 'DEMO', taskId: null, planId: null, version: MONITORING_PRESET_VERSION,
    name: '三站网络监控演示', presetId: profile.id,
    stations: structuredClone(base.baseline.stations), devices: structuredClone(base.baseline.devices),
    links, configuration: structuredClone(result.configuration),
  }, frames: frames(profile) };
});

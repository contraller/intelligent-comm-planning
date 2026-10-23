import { SPECTRUM_MONITORING_BANDS } from '../config/demo';
import type { SpectrumObservationFrame } from '../types/monitoring';

// 占用率、接收功率和异常均为独立观测常量，不读取规划分配推导频谱占用。
const ranges = [
  [[6000,7000],[7000,8000],[8000,9000],[9000,10000]],
  [[30000,44500],[44500,59000],[59000,73500],[73500,88000]],
];
const samples = [
  { occupancy: [22,35,18,26], power: [-92,-86,-97,-90], total: 25.25, abnormal: [] as number[], label: '正常占用' },
  { occupancy: [24,88,21,29], power: [-90,-48,-93,-88], total: 40.5, abnormal: [1], label: '异常占用出现' },
  { occupancy: [30,96,91,32], power: [-87,-39,-43,-86], total: 62.25, abnormal: [1,2], label: '连续频段异常' },
  { occupancy: [23,36,20,27], power: [-91,-84,-95,-89], total: 26.5, abnormal: [] as number[], label: '占用恢复' },
];
export const spectrumObservationPresets = SPECTRUM_MONITORING_BANDS.map((band, bandIndex) => ({
  ...band,
  frames: samples.map((sample,index): SpectrumObservationFrame => ({
    id: band.id + ':' + index,
    observedAt: ['2026-10-05T09:00:00+08:00','2026-10-05T09:00:30+08:00','2026-10-05T09:01:00+08:00','2026-10-05T09:01:30+08:00'][index],
    label: sample.label, occupancyPercent: sample.total, abnormalBandCount: sample.abnormal.length,
    bins: ranges[bandIndex].map(([minKhz,maxKhz],bin) => ({
      id: band.id + ':bin-' + bin, minKhz, maxKhz, occupancyPercent: sample.occupancy[bin], powerDbm: sample.power[bin],
      abnormal: sample.abnormal.includes(bin), reason: sample.abnormal.includes(bin) ? '预生成结果：异常持续占用及接收功率抬升' : null,
    })),
  })),
}));

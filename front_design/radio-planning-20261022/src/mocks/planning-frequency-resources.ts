import type { PlanningFrequencyResource } from '../types/planning-options';

// 独立教学频点身份，与附件FQ编号无映射，不表示真实分配许可。
export const planningFrequencyResources: PlanningFrequencyResource[] = [
  { freqId: 'FQ-DEMO-HF-6000', deviceClass: 'HF', centerFreqKhz: 6000, bandwidthKhz: 3, channelNo: 1, isAvailable: true, occupiedBy: null, reuseMinDistanceM: 60000, adjacentGuardKhz: 3, note: '教学频点' },
  { freqId: 'FQ-DEMO-HF-8000', deviceClass: 'HF', centerFreqKhz: 8000, bandwidthKhz: 3, channelNo: 2, isAvailable: true, occupiedBy: null, reuseMinDistanceM: 60000, adjacentGuardKhz: 3, note: '教学频点' },
  { freqId: 'FQ-DEMO-HF-9000', deviceClass: 'HF', centerFreqKhz: 9000, bandwidthKhz: 3, channelNo: 3, isAvailable: false, occupiedBy: '教学保留用途', reuseMinDistanceM: 60000, adjacentGuardKhz: 3, note: '不可用；取消额外排除不会改变此标记' },
  { freqId: 'FQ-DEMO-HF-10000', deviceClass: 'HF', centerFreqKhz: 10000, bandwidthKhz: 3, channelNo: 4, isAvailable: true, occupiedBy: null, reuseMinDistanceM: 60000, adjacentGuardKhz: 3, note: '教学频点' },
  { freqId: 'FQ-DEMO-VUHF-150000', deviceClass: 'VUHF', centerFreqKhz: 150000, bandwidthKhz: 25, channelNo: null, isAvailable: null, occupiedBy: null, reuseMinDistanceM: null, adjacentGuardKhz: null, note: '可用性未提供；不据此推算分配' },
];
planningFrequencyResources.forEach(Object.freeze); Object.freeze(planningFrequencyResources);

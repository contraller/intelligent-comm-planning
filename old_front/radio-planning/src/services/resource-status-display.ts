import type { Device } from '../types/domain';
import type { DeviceStatusBatch, DeviceStatusDisplay, DeviceStatusRecord } from '../types/resource-status';
import { ApiError } from './types';

// 先构造完整新副本；任何序号冲突都不会留下半批更新。
export function mergeDeviceStatuses(previous: Record<string, DeviceStatusRecord>, batch: DeviceStatusBatch, fetchedAt: string) {
  const next = { ...previous };
  for (const item of batch.items) {
    const old = previous[item.deviceId], prior = old?.source.id === batch.source.id ? old.observation : undefined;
    let observation = item.outcome === 'REPORTED' ? item.observation : prior;
    let retained = item.outcome !== 'REPORTED' && !!prior, reason = item.reason;
    if (observation && prior && item.outcome === 'REPORTED') {
      if (observation.sequence === prior.sequence && JSON.stringify(observation) !== JSON.stringify(prior))
        throw new ApiError('同一观测序号内容冲突，整批结果未接收', 'DEVICE_STATUS_CONFLICT');
      if (observation.sequence < prior.sequence) { observation = prior; retained = true; reason = '本次上报序号较旧，保留上次记录'; }
    }
    next[item.deviceId] = { source: batch.source, observation, outcome: item.outcome, reason, fetchedAt, retained };
  }
  return next;
}
export function deviceStatusDisplay(device: Device, mode: 'baseline' | 'observed', record?: DeviceStatusRecord, sourceLabel = '同步观测'): DeviceStatusDisplay {
  if (mode === 'baseline') return { mode, status: device.status, alert: device.alert, sourceLabel: '台账基线', note: '已保存台账状态', retained: false };
  return { mode, status: record?.observation?.status ?? null, alert: record?.observation?.alert ?? null,
    sourceLabel: record?.source.label ?? sourceLabel, observedAt: record?.observation?.observedAt, fetchedAt: record?.fetchedAt,
    retained: record?.retained ?? false,
    note: (record?.retained ? '上次记录；' : '') + (record?.outcome === 'REPORTED' ? record.reason ?? '已上报'
      : record?.outcome === 'FAILED' ? `本次失败：${record.reason}` : record?.outcome === 'NO_REPORT' ? `本次未上报：${record.reason}` : '未取得状态，尚未同步此设备') };
}

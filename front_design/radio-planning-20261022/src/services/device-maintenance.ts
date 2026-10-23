import type { Device, DeviceModel } from '../types/domain';
import type { DeviceFieldChange, DeviceHistory, DevicePort, DeviceRestorePreview } from '../types/device-maintenance';

// 模式是前端暂定教学字典，不从 ALE/SDR 等型号能力文本推导。
export const maintenanceModes = [{ value: 'MOCK_FIXED', label: '教学定频' }, { value: 'MOCK_HOPPING', label: '教学跳频' }];
export const maintenanceFields = ['antennaHeightM', 'txPowerDbm', 'workFreqKhz', 'currentWorkMode', 'ports'] as const;
export const portFields = ['freqMinKhz', 'freqMaxKhz', 'rateKbps', 'gainDbi', 'heightM', 'azimuthDeg', 'tiltDeg'] as const;
export const maintenanceEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export function deviceChanges(before: Device | null, after: Device): DeviceFieldChange[] {
  return Object.keys(after).filter(field => !maintenanceEqual(before?.[field as keyof Device], after[field as keyof Device]))
    .map(field => ({ field, before: before?.[field as keyof Device] ?? null, after: after[field as keyof Device] ?? null }));
}
export function maintenanceIssues(device: Device, previous: Device | undefined, model: DeviceModel): string[] {
  const errors: string[] = [];
  if (device.currentWorkMode != null && !maintenanceModes.some(mode => mode.value === device.currentWorkMode)) errors.push('当前工作模式不在服务允许的教学字典中');
  if (device.ports == null) {
    if (previous?.ports?.length) errors.push('不能移除已有端口');
    return errors;
  }
  if (!Array.isArray(device.ports)) return [...errors, '端口集合格式无效'];
  if (!previous?.ports && device.ports.length) errors.push('未提供既有端口清单，不能新增端口');
  const old = previous?.ports;
  if (old && (old.length !== device.ports.length || old.some(p => !device.ports!.some(n => n.id === p.id && n.number === p.number && n.type === p.type)))) errors.push('端口身份、编号、类型和数量不可修改');
  const ids = new Set<string>();
  for (const port of device.ports) {
    if (!port || typeof port.id !== 'string' || !port.id || ids.has(port.id) || typeof port.number !== 'string' || !port.number || !['RF', 'BUSINESS'].includes(port.type)) { errors.push('端口身份无效或重复'); continue; }
    ids.add(port.id);
    if (Object.keys(port).some(key => !['id', 'number', 'type', ...portFields].includes(key))) errors.push('端口包含只读观测或未知字段');
    for (const field of portFields) if (port[field] !== null && (typeof port[field] !== 'number' || !Number.isFinite(port[field]))) errors.push(`${port.number} ${field} 须为有限数或空值`);
    if ((port.freqMinKhz === null) !== (port.freqMaxKhz === null) || port.freqMinKhz !== null && port.freqMaxKhz !== null && (port.freqMinKhz < model.freqMinKhz || port.freqMaxKhz > model.freqMaxKhz || port.freqMinKhz > port.freqMaxKhz)) errors.push(`${port.number} 频段范围无效`);
    if (port.rateKbps !== null && port.rateKbps <= 0 || port.heightM !== null && port.heightM < 0 || port.azimuthDeg !== null && (port.azimuthDeg < 0 || port.azimuthDeg >= 360) || port.tiltDeg !== null && (port.tiltDeg < -90 || port.tiltDeg > 90)) errors.push(`${port.number} 速率或天线参数越界`);
    if (port.type === 'BUSINESS' && ['freqMinKhz','freqMaxKhz','gainDbi','heightM','azimuthDeg','tiltDeg'].some(key => port[key as keyof DevicePort] !== null)) errors.push(`${port.number} 业务端口不维护射频与天线参数`);
  }
  return errors;
}
export function restoreDevice(history: DeviceHistory, current: Device, revision: string, epoch: string, model: DeviceModel): DeviceRestorePreview {
  const reasons: string[] = [];
  if (history.deviceId !== current.id || history.epoch !== epoch || history.after.modelId !== current.modelId) reasons.push('设备身份、资源批次或型号不兼容');
  const values: DeviceRestorePreview['values'] = {};
  // 未知旧字段不清空当前值；恢复的是选中版本的保存后状态。
  for (const field of maintenanceFields) if (Object.hasOwn(history.after,field) && history.after[field] !== undefined) Object.assign(values, { [field]: structuredClone(history.after[field]) });
  const candidate = { ...current, ...values };
  reasons.push(...maintenanceIssues(candidate, current, model));
  if(candidate.txPowerDbm!==current.txPowerDbm&&(candidate.txPowerDbm==null||candidate.txPowerDbm>model.txPowerMaxDbm))reasons.push('历史功率不符合当前型号上限');
  if(candidate.workFreqKhz!==null&&(candidate.workFreqKhz<model.freqMinKhz||candidate.workFreqKhz>model.freqMaxKhz))reasons.push('历史频率超出当前型号范围');
  return { historyId: history.id, revision, compatible: reasons.length === 0, reasons, values,
    changes: deviceChanges(current, candidate) };
}

// 历史正文与资源同条保存；损坏时拒绝读取，不制造审计事实。
export function validDeviceHistories(value: unknown): value is DeviceHistory[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every(h => {
    if (!h || typeof h.id !== 'string' || ids.has(h.id) || typeof h.deviceId !== 'string' || h.after?.id !== h.deviceId || h.before !== null && h.before?.id !== h.deviceId || !Number.isFinite(Date.parse(h.time)) || !['revision','previousRevision','epoch','source'].every(k => typeof h[k] === 'string' && h[k]) || !Array.isArray(h.changes)) return false;
    if (h.actor !== null && (!h.actor || !['id','name','roleId','roleName'].every(k => typeof h.actor[k] === 'string'))) return false;
    if (!maintenanceEqual(h.changes, deviceChanges(h.before, h.after))) return false;
    ids.add(h.id); return true;
  });
}

import type { Device } from '../types/domain';
import type { DeviceFieldChange, DeviceHistory, DeviceHistorySummary } from '../types/device-maintenance';
import { maintenanceModes } from './device-maintenance';

const fieldLabels: Record<string, string> = {
  id: '设备编号', stationId: '所属节点编号', modelId: '设备型号编号', antennaId: '关联天线编号',
  origin: '创建来源', availability: '在架状态', status: '运行状态', alert: '告警',
  antennaHeightM: '天线高度', txPowerDbm: '发射功率', workFreqKhz: '工作频率',
  currentWorkMode: '当前工作模式', installedAt: '安装时间', ports: '实例端口台账',
  azimuthDeg: '方位角', tiltDeg: '俯仰角',
};
const portLabels: Record<string, string> = {
  id: '端口标识', number: '端口编号', type: '端口类型', freqMinKhz: '频段下限',
  freqMaxKhz: '频段上限', rateKbps: '速率', gainDbi: '天线增益', heightM: '天线高度',
  azimuthDeg: '方位角', tiltDeg: '俯仰角',
};
const units: Record<string, string> = {
  antennaHeightM: 'm', txPowerDbm: 'dBm', workFreqKhz: 'kHz', freqMinKhz: 'kHz',
  freqMaxKhz: 'kHz', rateKbps: 'kbps', gainDbi: 'dBi', heightM: 'm', azimuthDeg: '°', tiltDeg: '°',
};
const enums: Record<string, Record<string, string>> = {
  currentWorkMode: Object.fromEntries(maintenanceModes.map(mode => [mode.value, mode.label])),
  origin: { SOURCE: '初始资料', MANUAL: '手动新增', IMPORT: '导入' },
  availability: { ACTIVE: '在架', OFF_SHELF: '已下架' },
  status: { NORMAL: '正常', FAULT: '故障', OFFLINE: '离线' },
  type: { RF: '射频端口', BUSINESS: '业务端口' },
};
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export interface MaintenanceDisplayRow { key: string; label: string; before: string; after: string }
export const maintenanceFieldLabel = (field: string) => Object.hasOwn(fieldLabels, field) ? fieldLabels[field]! : field;
export function configurationStatusLabel(status: string) {
  const labels: Record<string, string> = { RUNNING: '执行中', SUCCEEDED: '成功', FAILED: '失败', NOT_FOUND: '记录未找到' };
  return Object.hasOwn(labels, status) ? labels[status]! : status;
}

export function formatMaintenanceTime(value: string): string {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return value || '未提供';
  const parts = Object.fromEntries(timeFormat.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatMaintenanceValue(field: string, value: unknown): string {
  // 空值只表示留存资料缺失，不推断为新增、删除或清空操作。
  if (value == null) return '未提供';
  if (value === '') return '空字符串';
  if (field === 'installedAt' && typeof value === 'string') return Number.isFinite(Date.parse(value)) ? `${formatMaintenanceTime(value)}（北京时间）` : value;
  if (typeof value === 'boolean') return field === 'alert' ? (value ? '有告警' : '无告警') : (value ? '是' : '否');
  if (typeof value === 'number' && Object.hasOwn(units, field)) return `${value}${units[field] === '°' ? '' : ' '}${units[field]}`;
  if (typeof value === 'string' && Object.hasOwn(enums, field)) return Object.hasOwn(enums[field]!, value) ? enums[field]![value]! : value;
  if (field === 'ports' && Array.isArray(value) && !value.length) return '无端口记录';
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

export function isDeviceBaseline(item: DeviceHistory | DeviceHistorySummary): boolean {
  // 摘要沿用既有来源标识；正文以缺少修改前快照为准，不依赖操作人或版本号猜测。
  return 'before' in item ? item.before === null : item.source === '首次留存的变更前快照';
}

type PortData = Record<string, unknown> & { id: string };
const ports = (value: unknown): PortData[] | null => Array.isArray(value) && value.every(
  port => port && typeof port === 'object' && typeof port.id === 'string',
) ? value as PortData[] : null;

export function maintenanceChangeRows(changes: readonly DeviceFieldChange[]): MaintenanceDisplayRow[] {
  return changes.flatMap(change => {
    const beforePorts = ports(change.before), afterPorts = ports(change.after);
    if (change.field !== 'ports' || (!beforePorts && !afterPorts)) return [{
      key: change.field, label: maintenanceFieldLabel(change.field),
      before: formatMaintenanceValue(change.field, change.before), after: formatMaintenanceValue(change.field, change.after),
    }];
    const ids = [...new Set([...(beforePorts ?? []).map(port => port.id), ...(afterPorts ?? []).map(port => port.id)])];
    const rows: MaintenanceDisplayRow[] = [];
    // 用已保存的端口身份对齐参数，不按数组下标拼接不同端口。
    for (const id of ids) {
      const before = beforePorts?.find(port => port.id === id), after = afterPorts?.find(port => port.id === id);
      const number = after?.number ?? before?.number ?? id;
      for (const field of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
        if (JSON.stringify(before?.[field]) === JSON.stringify(after?.[field])) continue;
        rows.push({ key: `ports:${id}:${field}`, label: `端口 ${number} · ${Object.hasOwn(portLabels, field) ? portLabels[field] : field}`,
          before: formatMaintenanceValue(field, before?.[field]), after: formatMaintenanceValue(field, after?.[field]) });
      }
    }
    if (beforePorts && afterPorts && beforePorts.length === afterPorts.length && beforePorts.every(port => afterPorts.some(next => next.id === port.id)) && beforePorts.some((port, index) => port.id !== afterPorts[index]?.id)) {
      rows.push({ key: 'ports:order', label: '端口排列', before: beforePorts.map(port => port.number ?? port.id).join('、'), after: afterPorts.map(port => port.number ?? port.id).join('、') });
    }
    return rows.length ? rows : [{ key: 'ports', label: maintenanceFieldLabel('ports'), before: formatMaintenanceValue('ports', change.before), after: formatMaintenanceValue('ports', change.after) }];
  });
}

export function maintenanceSnapshotRows(device: Device) {
  return maintenanceChangeRows(Object.entries(device).map(([field, value]) => ({ field, before: undefined, after: value })))
    .map(row => ({ key: row.key, label: row.label, value: row.after }));
}

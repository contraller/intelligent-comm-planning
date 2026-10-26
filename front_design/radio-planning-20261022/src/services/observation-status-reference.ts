import type { ObservationDeviceStatusRefInput, ObservationDeviceStatusRefWire, ObservationServices } from '../types/observation';
import type { DeviceStatusClient } from './device-status-http';
import type { DeviceStatusHeader, DeviceStatusItem } from '../types/device-status-snapshot';
import { assertObservationQuery, decodeObservationDeviceStatusRef, decodeObservationStatusRefInput,
  observationStatusRefInput, sameObservationStatusRef } from './observation-validation';
import { readObservationStatusHeader } from './gis-observation-status';
import { readStatusDevices, readStatusHeader } from './device-status-decode';
import { ApiError } from './types';

export interface ObservationStatusReferenceTarget {
  datasetId: string;
  datasetRevision: string;
  ref: ObservationDeviceStatusRefInput;
}
export interface ObservationStatusReferenceServices {
  observations: Pick<ObservationServices, 'getObservationDeviceStatusRef'>;
  deviceStatuses: Pick<DeviceStatusClient, 'getSnapshot' | 'queryDevices'>;
}
export interface ObservationStatusReferencePage {
  target: ObservationStatusReferenceTarget;
  reference: ObservationDeviceStatusRefWire;
  header: DeviceStatusHeader;
  items: DeviceStatusItem[];
  page: number;
  pageSize: number;
  total: number;
}
export const OBSERVATION_STATUS_REFERENCE_PAGE_SIZE = 20;
const CONCURRENCY = 4;
const invalid = (message: string): never => {
  throw new ApiError(message, 'INVALID_OBSERVATION_STATUS_REFERENCE');
};

export function captureObservationStatusReference(target: ObservationStatusReferenceTarget): ObservationStatusReferenceTarget {
  if (!target || typeof target !== 'object' || Array.isArray(target)
    || Object.keys(target).length !== 3 || !['datasetId', 'datasetRevision', 'ref'].every(key => Object.hasOwn(target, key)))
    invalid('观测冻结引用目标无效');
  const selection = { datasetId: target.datasetId, datasetRevision: target.datasetRevision };
  assertObservationQuery(selection, 'context');
  if (!selection.datasetId || !selection.datasetRevision) invalid('请选择精确观测版本');
  return { ...selection, ref: observationStatusRefInput(decodeObservationStatusRefInput(target.ref)) };
}

// 全部结果仅属于冻结引用，不绑定当前台账或共享状态store。
export async function readObservationStatusReference(
  services: ObservationStatusReferenceServices,
  target: ObservationStatusReferenceTarget,
  page: number,
  signal: AbortSignal,
): Promise<ObservationStatusReferencePage | null> {
  if (signal.aborted) return null;
  const captured = captureObservationStatusReference(target);
  const total = captured.ref.deviceIds.length, pageSize = OBSERVATION_STATUS_REFERENCE_PAGE_SIZE;
  if (!Number.isSafeInteger(page) || page < 1 || page > Math.ceil(total / pageSize)) invalid('引用成员页码无效');
  const controller = new AbortController(), abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const observations = services.observations, statuses = services.deviceStatuses;
  try {
    const selection = { datasetId: captured.datasetId, datasetRevision: captured.datasetRevision };
    const binding = decodeObservationDeviceStatusRef(
      await observations.getObservationDeviceStatusRef({ ...selection, signal: controller.signal }), selection,
    );
    if (controller.signal.aborted) return null;
    if (!binding.deviceStatusRef) return invalid('该观测版本未关联设备状态快照');
    if (binding.resourceRevision !== captured.ref.resourceRevision
      || !sameObservationStatusRef(binding.deviceStatusRef, captured.ref)) invalid('观测冻结绑定与所选引用不一致');
    const reference = structuredClone(binding.deviceStatusRef);
    const raw = await readObservationStatusHeader(statuses, captured.ref, captured.ref.resourceRevision, controller.signal);
    if (!raw || controller.signal.aborted) return null;
    const expected = { context: 'ledger' as const, snapshot_id: reference.snapshotId, snapshot_revision: reference.snapshotRevision };
    const header = readStatusHeader(raw, expected);
    if (header.total < total) invalid('声明成员数量超过冻结快照记录数');
    const ids = captured.ref.deviceIds.slice((page - 1) * pageSize, page * pageSize);
    const items: DeviceStatusItem[] = new Array(ids.length);
    let cursor = 0;
    async function worker() {
      while (!controller.signal.aborted && cursor < ids.length) {
        const index = cursor++, deviceId = ids[index]!;
        const query = { ...expected, device_id: deviceId, status_filter: 'ALL' as const, page: 1, page_size: 1 };
        const value = await statuses.queryDevices(query, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const result = readStatusDevices(value, query);
        if (result.resource_revision !== reference.resourceRevision || result.total !== 1 || result.items.length !== 1)
          invalid('冻结引用成员缺失或资源版本不符：' + deviceId);
        items[index] = result.items[0]!;
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, () => worker()));
    if (controller.signal.aborted) return null;
    return { target: captured, reference, header, items, page, pageSize, total };
  } catch (reason) {
    if (signal.aborted) return null;
    controller.abort();
    throw reason;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

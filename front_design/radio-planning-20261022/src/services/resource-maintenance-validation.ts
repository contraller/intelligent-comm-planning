import type { Device, Station } from '../types/domain';
import type { ResourceCommit, ResourceMaintenanceContext, ResourceMutationReceipt } from '../types/resource-edit';
import { decodeModel, decodeObject, readRecord, readText } from './resource-read-validation';
import { ApiError } from './types';

function fail(field: string): never { throw new ApiError('设备维护响应不符合契约：' + field, 'INVALID_RESOURCE_RESPONSE'); }
const revision = (value: unknown) => typeof value === 'string' && /^resource-[0-9a-f]{16}$/.test(value) ? value : fail('revision');
const ids = (value: unknown): string[] => {
  if (!Array.isArray(value)) return fail('ids');
  const result = value.map(v => readText(v, 'id'));
  if (new Set(result).size !== result.length) fail('duplicate ids');
  return result;
};
export function maintenanceDevice(value: unknown): Device {
  const row = decodeObject('device', value);
  if (row.kind !== 'device' || row.origin === null || row.availability === null) return fail('device');
  return { id: row.id, stationId: row.stationId, modelId: row.modelId, antennaId: row.antennaId,
    status: row.status, alert: row.alert, origin: row.origin, availability: row.availability,
    antennaHeightM: row.antennaHeightM, txPowerDbm: row.txPowerDbm, workFreqKhz: row.workFreqKhz,
    currentWorkMode: row.currentWorkMode, tiltDeg: row.tiltDeg, azimuthDeg: row.azimuthDeg, installedAt: row.installedAt };
}
export function readMaintenanceContext(value: unknown, expectedRevision: string, deviceId: string): ResourceMaintenanceContext {
  const v = readRecord(value), rev = revision(v.revision);
  if (rev !== expectedRevision || v.base_revision !== rev) fail('context revision');
  const device = maintenanceDevice(v.device);
  if (device.id !== deviceId || !Array.isArray(v.stations) || v.stations.length !== 1
    || !Array.isArray(v.models) || v.models.length !== 1 || !Array.isArray(v.antennas) || v.antennas.length !== 1) fail('context association');
  const node = decodeObject('node', v.stations[0]), model = decodeModel(v.models[0]), antenna = readRecord(v.antennas[0]);
  const a = { id: readText(antenna.antenna_id, 'antenna_id'), name: readText(antenna.antenna_name, 'antenna_name') };
  if (node.kind !== 'node' || node.id !== device.stationId || model.id !== device.modelId || a.id !== device.antennaId) fail('context association');
  const { kind: _kind, childCount: _children, deviceCount: _devices, origin, ...station } = node;
  const stations: Station[] = [{ ...station, ...(origin === null ? {} : { origin }) }];
  const impact = readRecord(v.impact);
  return { revision: rev, baseRevision: rev, device, stations, models: [model], antennas: [a],
    impact: { planIds: ids(impact.plan_ids), linkIds: ids(impact.link_ids), description: readText(impact.description, 'impact.description') } };
}
export function readMaintenanceReceipt(value: unknown, input: ResourceCommit): ResourceMutationReceipt {
  const v = readRecord(value), rev = revision(v.revision), patch = input.devices[0]!;
  if (v.read_revision !== rev || typeof v.changed !== 'boolean' || v.object_id !== patch.id
    || v.changed === (rev === input.baseRevision)) fail('receipt revision');
  const device = maintenanceDevice(v.device), affectedIds = ids(v.affected_ids);
  if (device.id !== patch.id || affectedIds.length !== (v.changed ? 1 : 0) || v.changed && affectedIds[0] !== patch.id) fail('receipt device');
  for (const field of ['antennaHeightM', 'txPowerDbm', 'workFreqKhz'] as const)
    if (Object.hasOwn(patch, field) && patch[field] !== device[field]) fail('saved ' + field);
  if (!Array.isArray(v.warnings)) fail('warnings');
  const warnings = v.warnings.map(value => {
    const w = readRecord(value), objectId = readText(w.object_id, 'warning.object_id'), field = readText(w.field, 'warning.field');
    if (objectId !== patch.id || !['antennaHeightM', 'txPowerDbm', 'workFreqKhz'].includes(field)) fail('warning association');
    return { objectId, field, message: readText(w.message, 'warning.message') };
  });
  return { objectId: patch.id, changed: v.changed, revision: rev, readRevision: rev, device, affectedIds, warnings };
}

export function readAvailabilityContext(value: unknown, expectedRevision: string, selected: string[]): ResourceMaintenanceContext {
  const v = readRecord(value), rev = revision(v.revision), selectedIds = ids(v.selected_ids);
  if (rev !== expectedRevision || v.base_revision !== rev || selectedIds.length !== selected.length
    || selectedIds.some(id => !selected.includes(id)) || v.device !== null
    || ![v.stations,v.models,v.antennas].every(rows => Array.isArray(rows) && rows.length === 0)) fail('availability preview');
  const impact = readRecord(v.impact), linkIds = ids(impact.link_ids);
  if (linkIds.length) fail('unexpected link impact');
  return {revision:rev,baseRevision:rev,device:null,stations:[],models:[],antennas:[],selectedIds,
    impact:{planIds:ids(impact.plan_ids),linkIds,description:readText(impact.description,'impact.description')}};
}

export function readAvailabilityReceipt(value: unknown, baseRevision: string, selected: string[]): ResourceMutationReceipt & {updated:string[];unchanged:string[]} {
  const v = readRecord(value), rev = revision(v.revision), updated = ids(v.updated), unchanged = ids(v.unchanged), affectedIds = ids(v.affected_ids);
  if (v.object_id !== 'resource-device-availability' || v.read_revision !== rev || typeof v.changed !== 'boolean'
    || v.changed !== (updated.length > 0) || v.changed === (rev === baseRevision)
    || updated.length + unchanged.length !== selected.length || updated.some(id => unchanged.includes(id))
    || [...updated,...unchanged].some(id => !selected.includes(id)) || affectedIds.length !== updated.length
    || affectedIds.some(id => !updated.includes(id)) || !Array.isArray(v.warnings) || v.warnings.length) fail('availability receipt');
  return {objectId:v.object_id,changed:v.changed,revision:rev,readRevision:rev,affectedIds,updated,unchanged,warnings:[]};
}

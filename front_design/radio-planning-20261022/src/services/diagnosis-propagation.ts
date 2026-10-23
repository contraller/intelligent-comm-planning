import type { Coordinate, Device, NetworkLink, PlanVersion, Station } from '../types/domain';
import type { DiagnosisPropagationPath, FaultInput } from '../types/diagnosis';
import { planStations } from './planning-snapshot';
import { ApiError } from './types';

// 仅把给定对象映射到冻结坐标；链路中点仅是展示锚点。
export function propagationObjectCoordinate(target: Pick<FaultInput, 'objectType' | 'objectId'>, stations: Station[], devices: Device[], links: NetworkLink[]): Coordinate | null {
  const node = (id: string) => stations.find(row => row.id === id)?.coordinate ?? null;
  if (target.objectType === 'NODE') return node(target.objectId);
  if (target.objectType === 'DEVICE') return node(devices.find(row => row.id === target.objectId)?.stationId ?? '');
  const link = links.find(row => row.id === target.objectId), a = link && node(link.a), b = link && node(link.b);
  return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;
}
export function propagationCoordinates(path: DiagnosisPropagationPath, network: PlanVersion): Coordinate[] {
  return path.steps.flatMap(step => {
    const point = propagationObjectCoordinate(step, planStations(network), network.inputSnapshot.devices, network.links);
    return point ? [point] : [];
  });
}
export function assertPropagationPaths(value: unknown, network: PlanVersion, faults: FaultInput[]): asserts value is DiagnosisPropagationPath[] | undefined {
  if (value === undefined) return;
  const fail = () => { throw new ApiError('故障传播路径结构或冻结对象引用无效', 'INVALID_RESULT'); };
  if (!Array.isArray(value)) return fail();
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id) ||
      !faults.some(f => `${f.objectType}:${f.objectId}` === item.faultKey) ||
      !['SEVERE', 'MODERATE', 'MINOR'].includes(item.level) || typeof item.reason !== 'string' || !item.reason.trim() ||
      !Array.isArray(item.steps) || item.steps.length < 2) fail();
    ids.add(item.id);
    for (const step of item.steps) {
      if (!step || !['NODE', 'DEVICE', 'LINK'].includes(step.objectType) || typeof step.objectId !== 'string' ||
        typeof step.reason !== 'string' || !step.reason.trim() ||
        !propagationObjectCoordinate(step, planStations(network), network.inputSnapshot.devices, network.links)) fail();
    }
    if (`${item.steps[0].objectType}:${item.steps[0].objectId}` !== item.faultKey) fail();
  }
}

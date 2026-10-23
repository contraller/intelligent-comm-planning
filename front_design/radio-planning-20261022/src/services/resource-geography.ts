import type { Coordinate, ResourcesData } from '../types/domain';

export type PlanningBounds = NonNullable<ResourcesData['planningBounds']>;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function validPlanningBounds(value: unknown): value is PlanningBounds {
  return Array.isArray(value) && value.length === 4 && value.every(finite)
    && -180 <= value[0] && value[0] < value[2] && value[2] <= 180
    && -90 <= value[1] && value[1] < value[3] && value[3] <= 90;
}

export function validCoordinate(value: unknown): value is Coordinate {
  return Array.isArray(value) && value.length === 2 && value.every(finite)
    && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}

export function coordinateInBounds(value: unknown, bounds: unknown): boolean {
  return validCoordinate(value) && validPlanningBounds(bounds)
    && bounds[0] <= value[0] && value[0] <= bounds[2]
    && bounds[1] <= value[1] && value[1] <= bounds[3];
}

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourcesData } from '../src/types/domain';
import type { ResourceCommit } from '../src/types/resource-edit';
import { validPlanningBounds, coordinateInBounds } from '../src/services/resource-geography';
import { applyChanges, diffResources, formChanges, createNewForm, validateResources } from '../src/services/resource-validation';
import { readWorkspaceResources, workspaceCommitBody, workspaceSource } from '../src/services/resource-workspace-validation';
import { createResourceWorkspaceHttp } from '../src/services/resource-workspace-http';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import { ApiError } from '../src/services/types';
import { initialResources } from '../src/mocks/resource-presets';
import { DEMO_BBOX } from '../src/config/demo';

const runtime = vi.hoisted(() => ({ mode: 'http' }));
vi.mock('../src/config/env', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config/env')>();
  return { ...actual, env: { ...actual.env, get mode() { return runtime.mode; } } };
});
const bounds: NonNullable<ResourcesData['planningBounds']> = [113.14986111114996, 36.27597222221908, 114.9498611111502, 37.72402777777483];
beforeEach(() => { runtime.mode = 'http'; });

function resources(): ResourcesData {
  return { source: workspaceSource, version: 'resource-1111111111111111', planningBounds: [...bounds],
    stations: [{ id: 'N1', name: 'West station', echelon: 'I', subtype: 'I_FIXED', role: 'FIXED_STATION',
      parentIds: [], coordinate: [113.500000123, 37.123456789], elevationM: null, region: '', classes: ['HF'],
      status: null, alert: null, relayCapable: true, key: false, mobility: 'FIXED', remark: '', origin: 'SOURCE' }],
    devices: [{ id: 'D1', stationId: 'N1', modelId: 'M1', antennaId: 'A1', status: null, alert: null,
      antennaHeightM: 10, txPowerDbm: 40, workFreqKhz: null, installedAt: '', availability: 'ACTIVE',
      tiltDeg: null, azimuthDeg: null, currentWorkMode: null, origin: 'SOURCE' }],
    models: [{ id: 'M1', name: 'Existing model', manufacturer: '', deviceClass: 'HF', freqMinKhz: 1500,
      freqMaxKhz: 30000, txPowerMaxDbm: 50, modulation: [], workMode: [] }], antennas: [{ id: 'A1', name: 'Existing antenna' }],
    interferences: [{ id: 'I1', name: 'West interference', coordinate: [113.500000123, 37.123456789], elevationM: null,
      antennaHeightM: 0, centerFreqKhz: 1500, bandwidthKhz: 10, txPowerDbm: -10, antennaGainDbi: null,
      interferenceType: 'NOISE', patternType: null, azimuthDeg: null, dutyCycle: null, active: false, origin: 'SOURCE' }], candidateLinks: [] };
}

describe('M5 read-only HTTP DEM coverage', () => {
  it('strictly decodes, clones and preserves missing/null coverage without sample fallback', () => {
    const input = resources(), result = readWorkspaceResources(input);
    expect(result.planningBounds).toEqual(bounds);
    input.planningBounds![0] = 0;
    expect(result.planningBounds).toEqual(bounds);
    input.planningBounds = null;
    expect(readWorkspaceResources(input).planningBounds).toBeNull();
    delete input.planningBounds;
    expect(Object.hasOwn(readWorkspaceResources(input), 'planningBounds')).toBe(false);
  });
  it.each([[], [0, 0, 0, 1], [true, 0, 1, 1], [-181, 0, 1, 1], [0, -91, 1, 1], [0, 0, Infinity, 1], ['0', 0, 1, 1]].map(value => [value]))('rejects malformed coverage %j', value => {
    expect(validPlanningBounds(value)).toBe(false);
    expect(() => readWorkspaceResources({ ...resources(), planningBounds: value })).toThrow();
  });
  it('only the explicit Mock initializer supplies the old sample area', () => {
    runtime.mode = 'mock';
    expect(initialResources().planningBounds).toEqual(DEMO_BBOX);
    const base = resources(); delete base.planningBounds;
    const next = structuredClone(base); next.stations[0].coordinate = [114.5, 37.5];
    expect(validateResources(next, base, base).issues.some(issue => issue.field === 'coordinate')).toBe(true);
  });
  it.each(['station', 'interference'] as const)('%s accepts the west and exact DEM edges, not the old sample restriction', kind => {
    for (const point of [[113.2, 36.3], [bounds[0], bounds[1]], [bounds[2], bounds[3]]] as [number, number][]) {
      const base = resources();
      const next = applyChanges(base, kind === 'station' ? { stations: [{ id: 'N1', coordinate: point }], devices: [] }
        : { stations: [], devices: [], interferences: [{ id: 'I1', coordinate: point }] });
      expect(validateResources(next, base, base).issues).toEqual([]);
      const coordinate = kind === 'station' ? next.stations[0].coordinate : next.interferences![0].coordinate;
      expect(coordinateInBounds(coordinate, bounds)).toBe(true);
      if (point[0] === bounds[0] || point[0] === bounds[2]) expect(coordinate).toEqual(point);
    }
  });
  it.each([[bounds[0] - 1e-9, 37], [bounds[2] + 1e-9, 37], [114, bounds[1] - 1e-9],
    [114, bounds[3] + 1e-9], [37, 114], [NaN, 37]])('does not round or clamp an invalid raw coordinate %j', (lon, lat) => {
    const base = resources(), next = applyChanges(base, { stations: [{ id: 'N1', coordinate: [lon, lat] }], devices: [] });
    expect(validateResources(next, base, base).issues.some(issue => issue.field === 'coordinate')).toBe(true);
    expect(next.stations[0].coordinate).toEqual([lon, lat]);
  });
  it.each([null, undefined])('missing coverage %s permits non-coordinate changes and preserves all coordinates', planningBounds => {
    const base = resources(); base.planningBounds = planningBounds;
    base.stations[0].coordinate = [115.500000123, 37.123456789];
    const before = structuredClone(base);
    const next = applyChanges(base, { stations: [{ id: 'N1', remark: 'rename only' }], devices: [{ id: 'D1', antennaHeightM: 12 }] });
    expect(validateResources(next, base, base).issues).toEqual([]);
    expect(next.stations[0].coordinate).toEqual(before.stations[0].coordinate);
    expect(next.interferences![0].coordinate).toEqual(before.interferences![0].coordinate);
    expect(base).toEqual(before);
    next.stations[0].coordinate[0] = 113.6;
    expect(validateResources(next, base, base).issues.some(issue => issue.message.includes('DEM'))).toBe(true);
  });
  it('rejects missing bounds for creation and validates the complete pair after a one-axis edit', () => {
    const base = resources(); base.planningBounds = null;
    const next = structuredClone(base); next.stations.push({ ...structuredClone(base.stations[0]), id: 'NEW', origin: 'MANUAL' });
    expect(validateResources(next, base, base).issues.some(issue => issue.field === 'coordinate')).toBe(true);
    base.planningBounds = [...bounds]; base.stations[0].coordinate[0] = 115.5;
    const edited = structuredClone(base); edited.stations[0].coordinate[1] = 37.2;
    expect(validateResources(edited, base, base).issues.some(issue => issue.field === 'coordinate')).toBe(true);
  });
  it('drafts cannot replace the trusted bounds or mutate the source dictionary', () => {
    const base = resources(), next = structuredClone(base); next.planningBounds = [-180, -90, 180, 90];
    expect(validateResources(next, base, base).issues.some(issue => issue.field === 'dictionary')).toBe(true);
  });
  it('device edits never round stations/interference or re-emit unchanged protocol values', () => {
    const base = resources(); base.devices[0].currentWorkMode = 'OPAQUE_SOURCE_VALUE';
    const next = applyChanges(base, { stations: [], devices: [{ id: 'D1', antennaHeightM: 12 }] });
    expect(validateResources(next, base, base).issues).toEqual([]);
    const changes = diffResources(base, next);
    expect(changes.stations).toEqual([]); expect(changes.interferences).toBeUndefined();
    expect(Object.hasOwn(changes.devices[0], 'currentWorkMode')).toBe(false);
    expect(next.stations[0].coordinate).toEqual(base.stations[0].coordinate);
    expect(next.interferences![0].coordinate).toEqual(base.interferences![0].coordinate);
  });
});

describe('M5 HTTP device mode boundary', () => {
  const input = (): ResourceCommit => ({ context: 'gis', baseRevision: resources().version, requestId: 'new-device', stations: [], devices: [],
    newDevices: [{ ...resources().devices[0], id: 'NEW', origin: 'MANUAL', currentWorkMode: null }] });
  it('new form already omits an empty mode and keeps UNKNOWN status/alert', () => {
    const form = createNewForm('device', resources(), 'N1');
    Object.assign(form.fields, { modelId: 'M1', antennaId: 'A1', antennaHeightM: '10', txPowerDbm: '40' });
    const row = formChanges(form).newDevices![0];
    expect(row.status).toBeNull(); expect(row.alert).toBeNull(); expect(Object.hasOwn(row, 'currentWorkMode')).toBe(false);
  });
  it.each([null, undefined])('HTTP encoding omits %s mode without changing caller data or ports', value => {
    const commit = input(); commit.newDevices![0].currentWorkMode = value;
    commit.devices = [{ id: 'D1', antennaHeightM: 12, currentWorkMode: value }];
    const original = structuredClone(commit), body = workspaceCommitBody(commit);
    expect(Object.hasOwn(body.changes.newDevices![0], 'currentWorkMode')).toBe(false);
    expect(Object.hasOwn(body.changes.devices[0], 'currentWorkMode')).toBe(false);
    expect(commit).toEqual(original);
  });
  it('real HTTP adapter sends no null mode for creation', async () => {
    const request = vi.fn<AuthenticatedRequest>().mockRejectedValue(new ApiError('capture only', 'REQUEST_FAILED'));
    await expect(createResourceWorkspaceHttp(request as AuthenticatedRequest).commitResources(input())).rejects.toThrow('capture only');
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(body.changes.newDevices[0]).not.toHaveProperty('currentWorkMode');
    expect(body.changes.newDevices[0]).toMatchObject({ status: null, alert: null });
  });
  it.each(['new', 'patch'])('rejects explicit nonempty %s mode before HTTP', async kind => {
    const commit = input();
    if (kind === 'new') commit.newDevices![0].currentWorkMode = 'MOCK_FIXED';
    else { delete commit.newDevices; commit.devices = [{ id: 'D1', currentWorkMode: 'MOCK_FIXED' }]; }
    const request = vi.fn<AuthenticatedRequest>();
    await expect(createResourceWorkspaceHttp(request as AuthenticatedRequest).commitResources(commit)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(request).not.toHaveBeenCalled();
  });
  it('Mock retains real teaching-mode edits in generic validation/diff, without using HTTP encoder', () => {
    runtime.mode = 'mock';
    const base = resources(), next = applyChanges(base, { stations: [], devices: [{ id: 'D1', currentWorkMode: 'MOCK_FIXED' }] });
    expect(validateResources(next, base, base).issues).toEqual([]);
    expect(diffResources(base, next).devices[0].currentWorkMode).toBe('MOCK_FIXED');
  });
});

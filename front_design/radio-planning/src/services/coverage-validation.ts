import type { Coordinate } from '../types/domain';
import type { CoverageFeature, CoverageRaster, PlanningCoverage } from '../types/coverage';
import { apiChoice, apiId, apiList, apiNumber, apiRecord, apiText, invalidApi, uniqueIds } from './task-api-validation';

export function readCoveragePoint(v: unknown): Coordinate {
  if (!Array.isArray(v) || v.length !== 2) return invalidApi('coordinate');
  return [apiNumber(v[0], 'longitude', -180, 180), apiNumber(v[1], 'latitude', -90, 90)];
}
function ring(value: unknown): Coordinate[] {
  const points = apiList(value, 'ring', readCoveragePoint);
  if (points.length < 4 || points[0].some((n, i) => n !== points.at(-1)![i])) invalidApi('closed ring');
  return points;
}
function polygon(value: unknown): Coordinate[][] { const rings = apiList(value, 'polygon', ring); if (!rings.length) invalidApi('polygon'); return rings; }
export function readCoverageRaster(value: unknown): CoverageRaster {
  const v = apiRecord(value), bbox = apiList(v.bbox, 'bbox', x => apiNumber(x, 'bbox'));
  if (bbox.length !== 4) invalidApi('bbox'); readCoveragePoint(bbox.slice(0, 2)); readCoveragePoint(bbox.slice(2));
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) invalidApi('bbox');
  const width = apiNumber(v.width, 'width', 1, 16384), height = apiNumber(v.height, 'height', 1, 16384);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width * height > 40000000) invalidApi('raster dimensions');
  const colormap = apiList(v.colormap, 'colormap', raw => { const c = apiRecord(raw), rgba = apiList(c.rgba, 'rgba', x => apiNumber(x, 'rgba', 0, 255)); if (rgba.length !== 4 || rgba.some(n => !Number.isInteger(n))) invalidApi('rgba'); return { value_dbuvm: apiNumber(c.value_dbuvm, 'value_dbuvm'), rgba: rgba as [number, number, number, number] }; });
  if (!colormap.length || colormap.some((c, i) => i > 0 && c.value_dbuvm <= colormap[i - 1].value_dbuvm)) invalidApi('colormap');
  return { url: apiText(v.url, 'url'), bbox: bbox as CoverageRaster['bbox'], crs: apiChoice(v.crs, ['EPSG:4326'], 'crs'), width, height, colormap };
}
export function readCoverage(value: unknown): PlanningCoverage {
  const v = apiRecord(value); let contour: PlanningCoverage['contour'] = null;
  if (v.contour !== null) {
    const c = apiRecord(v.contour); if (c.type !== 'FeatureCollection') invalidApi('FeatureCollection');
    const features = apiList(c.features, 'features', raw => {
      const f = apiRecord(raw), g = apiRecord(f.geometry), p = apiRecord(f.properties); if (f.type !== 'Feature') invalidApi('Feature');
      const type = apiChoice(g.type, ['Polygon', 'MultiPolygon'], 'geometry');
      const geometry: CoverageFeature['geometry'] = type === 'Polygon' ? { type, coordinates: polygon(g.coordinates) } : { type, coordinates: apiList(g.coordinates, 'MultiPolygon', polygon) };
      if (!geometry.coordinates.length) invalidApi('empty geometry');
      return { type: 'Feature' as const, id: apiId(f.id), properties: { level: apiText(p.level, 'level'), field_strength_dbuvm_min: p.field_strength_dbuvm_min == null ? null : apiNumber(p.field_strength_dbuvm_min, 'field strength') }, geometry };
    });
    contour = { type: 'FeatureCollection', features: uniqueIds(features, f => f.id, 'feature ids') };
  }
  return { contour, rasterPng: v.raster_png === null ? null : readCoverageRaster(v.raster_png) };
}

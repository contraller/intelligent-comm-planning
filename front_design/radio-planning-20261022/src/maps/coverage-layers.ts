import GeoJSON from 'ol/format/GeoJSON';
import VectorSource from 'ol/source/Vector';
import VectorLayer from 'ol/layer/Vector';
import ImageLayer from 'ol/layer/Image';
import ImageStatic from 'ol/source/ImageStatic';
import { Fill, Stroke, Style } from 'ol/style';
import type { CoverageDisplay, PlanningCoverage } from '../types/coverage';

// 缩放只增加已有边界的显示细节，不请求规划或生成场强。
export const COVERAGE_VECTOR_ZOOM = 13;
export type CoverageImageState = 'idle' | 'loading' | 'ready' | 'error';
const independentRegion = (level: string) => level === 'blind' || level === 'uncalculated';
export function coverageVisibility(coverage: PlanningCoverage, imageUrl: string, zoom: number, mode: CoverageDisplay = 'auto', state: CoverageImageState = 'ready', enabled = true) {
  const features = coverage.contour?.features ?? [];
  const wanted = enabled && mode !== 'contour' && !!coverage.rasterPng;
  // 加载中仍开启图片层以触发 OpenLayers 读取，同时保留已有轮廓。
  const raster = wanted && !!imageUrl && state !== 'error';
  const contour = enabled && features.some(feature => !independentRegion(feature.properties.level))
    && (mode === 'contour' || !raster || state !== 'ready' || mode === 'auto' && zoom >= COVERAGE_VECTOR_ZOOM);
  return { wanted, raster, contour, vector: contour || enabled && features.some(feature => independentRegion(feature.properties.level)),
    outlineOnly: contour && raster && state === 'ready' && mode === 'auto' };
}
export function coverageLayers(coverage: PlanningCoverage, imageUrl: string, zoom: number, opacity = 0.7) {
  let visible = coverageVisibility(coverage, imageUrl, zoom);
  const features = coverage.contour ? new GeoJSON().readFeatures(coverage.contour, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }) : [];
  const vector = new VectorLayer({ source: new VectorSource({ features }), opacity, visible: visible.vector, style: feature => {
    const value = feature.get('field_strength_dbuvm_min'), level = feature.get('level');
    const independent = independentRegion(level);
    // 盲区和未计算区域只认明确标记，不从 PNG 的透明像素推断。
    if (!independent && !visible.contour) return undefined;
    const entry = typeof value === 'number' ? coverage.rasterPng?.colormap.filter(c => c.value_dbuvm <= value).at(-1) : undefined;
    // 明确等级且没有匹配色表时才采用统一语义色；原填充透明度与未分级颜色保持。
    const fallback: Record<string, string> = { STRONG: '#2e7d3266', MEDIUM: '#9ccc6555', WEAK: '#fdd83544', blind: '#a75e8055', uncalculated: '#79839644', coverage: '#55bb9955' };
    const fill = entry ? `rgba(${entry.rgba[0]},${entry.rgba[1]},${entry.rgba[2]},${entry.rgba[3] / 255})` : fallback[level] ?? '#70a6ce55';
    return new Style({ fill: !independent && visible.outlineOnly ? undefined : new Fill({ color: fill }), stroke: new Stroke({ color: '#8cb8cd', width: 1 }) });
  } });
  const raster = coverage.rasterPng && imageUrl ? new ImageLayer({ source: new ImageStatic({ url: imageUrl, projection: coverage.rasterPng.crs, imageExtent: coverage.rasterPng.bbox }), visible: visible.raster, opacity }) : null;
  return { vector, raster,
    setDisplay(mode: CoverageDisplay, nextZoom: number, state: CoverageImageState = 'ready', enabled = true, nextOpacity = opacity) {
      // 模式和缩放只刷新样式、显隐与透明度，保留同一图片源。
      visible = coverageVisibility(coverage, imageUrl, nextZoom, mode, state, enabled);
      vector.setVisible(visible.vector); raster?.setVisible(visible.raster);
      vector.setOpacity(nextOpacity); raster?.setOpacity(nextOpacity); vector.changed();
    },
  };
}

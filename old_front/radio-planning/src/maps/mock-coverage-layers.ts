import ImageStatic from 'ol/source/ImageStatic';
import { unByKey } from 'ol/Observable';
import type { EventsKey } from 'ol/events';
import { COVERAGE_VECTOR_ZOOM, coverageLayers, coverageVisibility, type CoverageImageState } from './coverage-layers';
import type { CoverageDisplay, PlanningCoverage } from '../types/coverage';

export type MockCoverageDisplay = CoverageDisplay;
export type MockCoverageState = CoverageImageState;
// 保留旧导出兼容调用；阈值现在表示叠加边界，不再开关 PNG。
export const MOCK_RASTER_ZOOM = COVERAGE_VECTOR_ZOOM;
export function mockCoverageVisibility(coverage: PlanningCoverage, mode: MockCoverageDisplay, zoom: number, state: MockCoverageState, enabled = true) {
  return coverageVisibility(coverage, coverage.rasterPng?.url ?? '', zoom, mode, state, enabled);
}
export function createMockCoverageLayers(coverage: PlanningCoverage, onState: (state: MockCoverageState) => void, baseUrl = import.meta.env.BASE_URL) {
  const url = coverage.rasterPng ? `${baseUrl.replace(/\/$/, '')}/${coverage.rasterPng.url.replace(/^\//, '')}` : '';
  const layers = coverageLayers(coverage, url, 9);
  let state: MockCoverageState = 'idle';
  let mode: MockCoverageDisplay = 'auto', zoom = 9, enabled = true, opacity = 0.7, disposed = false;
  let listeners: EventsKey[] = [];
  function update() {
    if (disposed) return;
    const visible = mockCoverageVisibility(coverage, mode, zoom, state, enabled);
    layers.setDisplay(mode, zoom, state, enabled, opacity);
    onState(visible.wanted ? (state === 'idle' ? 'loading' : state) : 'idle');
  }
  function observe() {
    const source = layers.raster?.getSource();
    if (!source) return;
    const change = (next: MockCoverageState) => { if (!disposed) { state = next; update(); } };
    listeners = [source.on('imageloadstart', () => change('loading')), source.on('imageloadend', () => change('ready')), source.on('imageloaderror', () => change('error'))];
  }
  observe();
  return {
    ...layers,
    setDisplay(nextMode: MockCoverageDisplay, nextZoom: number, nextEnabled: boolean, nextOpacity: number) {
      mode = nextMode; zoom = nextZoom; enabled = nextEnabled; opacity = nextOpacity;
      update();
    },
    retry() {
      if (disposed || state !== 'error' || !layers.raster || !coverage.rasterPng) return;
      // 替换失败的图片源，图层和快照不变；解绑旧事件避免迟到回调干扰重试。
      unByKey(listeners);
      const previous = layers.raster.getSource();
      layers.raster.setSource(new ImageStatic({ url, projection: coverage.rasterPng.crs, imageExtent: coverage.rasterPng.bbox }));
      previous?.dispose(); state = 'idle'; observe(); update();
    },
    dispose() {
      disposed = true; unByKey(listeners);
      layers.vector.getSource()?.dispose(); layers.raster?.getSource()?.dispose();
    },
  };
}

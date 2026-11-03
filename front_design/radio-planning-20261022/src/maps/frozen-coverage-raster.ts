import { fromLonLat } from 'ol/proj';
import type Layer from 'ol/layer/Layer';
import type { FrameState } from 'ol/Map';
import type { FrozenCoverageDisplay, FrozenCoverageFeature } from '../types/frozen-coverage';

export const COVERAGE_RASTER_LIMITS = {
  edge: 1024,
  pixels: 1024 * 1024,
  cells: 50000,
  cacheBytes: 16 * 1024 * 1024,
  screenPixels: 4 * 1024 * 1024,
  screenEdge: 3072,
} as const;
type Extent = [number, number, number, number];
interface Cell {
  extent: Extent;
  field: number;
  grade: number;
}
export interface CoverageRaster {
  width: number;
  height: number;
  extent: Extent;
  pixels: Uint8ClampedArray;
  blurPixels: number;
  pixelMeters: number;
  sourceCells: number;
}
const palettes = [
  [224, 147, 74],
  [226, 194, 85],
  [42, 151, 91],
];
const fieldPalette = [
  [218, 145, 78],
  [230, 193, 93],
  [137, 183, 105],
  [41, 137, 89],
];

// 只接受矩形地形格。异形、缺口及旧版图形继续走原矢量显示。
function cell(feature: FrozenCoverageFeature): Cell | null {
  const p = feature.properties,
    geometry = feature.geometry;
  if (
    !p.is_coverage ||
    p.surface_kind !== 'TERRAIN_CELL' ||
    geometry?.type !== 'Polygon' ||
    geometry.coordinates.length !== 1
  )
    return null;
  const ring = geometry.coordinates[0];
  if (
    !ring ||
    ring.length !== 5 ||
    ring.some((point) => point.length !== 2 || point.some((value) => !Number.isFinite(value)))
  )
    return null;
  if (ring[0][0] !== ring[4][0] || ring[0][1] !== ring[4][1]) return null;
  const xs = [...new Set(ring.slice(0, 4).map((point) => point[0]))].sort((a, b) => a - b),
    ys = [...new Set(ring.slice(0, 4).map((point) => point[1]))].sort((a, b) => a - b);
  if (
    xs.length !== 2 ||
    ys.length !== 2 ||
    xs[0] >= xs[1] ||
    ys[0] >= ys[1] ||
    xs[0] < -180 ||
    xs[1] > 180 ||
    Math.abs(ys[0]) >= 85 ||
    Math.abs(ys[1]) >= 85
  )
    return null;
  if (
    new Set(ring.slice(0, 4).map((point) => point.join(','))).size !== 4 ||
    ring.slice(1).some((point, i) => point[0] !== ring[i][0] && point[1] !== ring[i][1])
  )
    return null;
  if (typeof p.field_strength_dbuvm !== 'number' || !Number.isFinite(p.field_strength_dbuvm))
    return null;
  const grade = ['WEAK', 'MEDIUM', 'STRONG'].indexOf(p.strength_class ?? '');
  if (grade < 0) return null;
  const sw = fromLonLat([xs[0], ys[0]]),
    ne = fromLonLat([xs[1], ys[1]]);
  return { extent: [sw[0], sw[1], ne[0], ne[1]], field: p.field_strength_dbuvm, grade };
}

function displayColor(row: Cell, mode: FrozenCoverageDisplay, min: number, max: number) {
  if (mode !== 'field') return palettes[row.grade];
  const position =
      (max > min ? Math.max(0, Math.min(1, (row.field - min) / (max - min))) : 0.5) * 3,
    index = Math.min(2, Math.floor(position)),
    fraction = position - index;
  return fieldPalette[index].map((value, c) =>
    Math.round(value + (fieldPalette[index + 1][c] - value) * fraction),
  );
}

// 两遍盒式核只作用于一张已合成的预乘色图，不对每个格面分别模糊/叠亮。
function soften(source: Uint8ClampedArray, width: number, height: number, radius: number) {
  if (!radius) return source;
  const horizontal = new Float32Array(source.length),
    output = new Uint8ClampedArray(source.length),
    span = radius * 2 + 1;
  for (let y = 0; y < height; y++)
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let x = 0; x <= radius && x < width; x++) sum += source[(y * width + x) * 4 + c];
      for (let x = 0; x < width; x++) {
        horizontal[(y * width + x) * 4 + c] = sum / span;
        const add = x + radius + 1,
          remove = x - radius;
        if (add < width) sum += source[(y * width + add) * 4 + c];
        if (remove >= 0) sum -= source[(y * width + remove) * 4 + c];
      }
    }
  for (let x = 0; x < width; x++)
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let y = 0; y <= radius && y < height; y++) sum += horizontal[(y * width + x) * 4 + c];
      for (let y = 0; y < height; y++) {
        output[(y * width + x) * 4 + c] = Math.round(sum / span);
        const add = y + radius + 1,
          remove = y - radius;
        if (add < height) sum += horizontal[(add * width + x) * 4 + c];
        if (remove >= 0) sum -= horizontal[(remove * width + x) * 4 + c];
      }
    }
  return output;
}

// 仅生成显示颜色与透明度；不插补、修改或返回任何新的场强/门限/覆盖判定。
export function buildCoverageRaster(
  features: readonly FrozenCoverageFeature[],
  mode: FrozenCoverageDisplay,
  demBox: readonly number[],
): CoverageRaster | null {
  if (
    !features.length ||
    features.length > COVERAGE_RASTER_LIMITS.cells ||
    demBox.length !== 4 ||
    demBox.some((value) => !Number.isFinite(value)) ||
    demBox[0] >= demBox[2] ||
    demBox[1] >= demBox[3] ||
    demBox[0] < -180 ||
    demBox[2] > 180 ||
    Math.abs(demBox[1]) >= 85 ||
    Math.abs(demBox[3]) >= 85
  )
    return null;
  const cells: Cell[] = [];
  let west = Infinity,
    south = Infinity,
    east = -Infinity,
    north = -Infinity,
    smallest = Infinity,
    min = Infinity,
    max = -Infinity;
  for (const feature of features) {
    const row = cell(feature);
    if (!row) return null;
    const [w, s, e, n] = row.extent;
    cells.push(row);
    west = Math.min(west, w);
    south = Math.min(south, s);
    east = Math.max(east, e);
    north = Math.max(north, n);
    smallest = Math.min(smallest, e - w, n - s);
    min = Math.min(min, row.field);
    max = Math.max(max, row.field);
  }
  const demSW = fromLonLat([demBox[0], demBox[1]]),
    demNE = fromLonLat([demBox[2], demBox[3]]);
  if (
    west < demSW[0] - 0.01 ||
    south < demSW[1] - 0.01 ||
    east > demNE[0] + 0.01 ||
    north > demNE[1] + 0.01 ||
    !Number.isFinite(smallest) ||
    smallest <= 0
  )
    return null;
  // 常规格每边约8像素；超大格网降低显示分辨率，绝不分配无上限画布。
  const pixelMeters = Math.max(smallest / 8, (east - west) / 1014, (north - south) / 1014),
    blurPixels = Math.min(3, Math.floor((smallest / pixelMeters) * 0.35));
  const pad = (blurPixels + 1) * pixelMeters;
  west = Math.max(demSW[0], west - pad);
  south = Math.max(demSW[1], south - pad);
  east = Math.min(demNE[0], east + pad);
  north = Math.min(demNE[1], north + pad);
  const width = Math.max(1, Math.ceil((east - west) / pixelMeters)),
    height = Math.max(1, Math.ceil((north - south) / pixelMeters));
  if (
    width > COVERAGE_RASTER_LIMITS.edge ||
    height > COVERAGE_RASTER_LIMITS.edge ||
    width * height > COVERAGE_RASTER_LIMITS.pixels
  )
    return null;
  const source = new Uint8ClampedArray(width * height * 4),
    dx = (east - west) / width,
    dy = (north - south) / height;
  // 重叠只取已有较强等级/较高场强的颜色，避免多频半透明重复填色造成发亮。
  cells.sort((a, b) =>
    mode === 'field' ? a.field - b.field : a.grade - b.grade || a.field - b.field,
  );
  for (const row of cells) {
    const [w, s, e, n] = row.extent,
      color = displayColor(row, mode, min, max);
    const x0 = Math.max(0, Math.floor((w - west) / dx)),
      x1 = Math.min(width, Math.ceil((e - west) / dx)),
      y0 = Math.max(0, Math.floor((north - n) / dy)),
      y1 = Math.min(height, Math.ceil((north - s) / dy));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        source[i] = color[0];
        source[i + 1] = color[1];
        source[i + 2] = color[2];
        source[i + 3] = 255;
      }
  }
  const pixels = soften(source, width, height, blurPixels);
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255;
    if (mode === 'boundary') {
      const edge = Math.max(0, 1 - Math.abs(alpha - 0.5) / 0.3);
      pixels[i] = 139;
      pixels[i + 1] = 216;
      pixels[i + 2] = 167;
      pixels[i + 3] = Math.round(edge * 220);
    } else if (alpha > 0) {
      // 先还原预乘色再统一透明度；空洞保持alpha=0，不填成未提供的覆盖。
      pixels[i] = Math.round(pixels[i] / alpha);
      pixels[i + 1] = Math.round(pixels[i + 1] / alpha);
      pixels[i + 2] = Math.round(pixels[i + 2] / alpha);
      pixels[i + 3] = Math.round(alpha * 148);
    }
  }
  return {
    width,
    height,
    extent: [west, south, east, north],
    pixels,
    blurPixels,
    pixelMeters,
    sourceCells: features.length,
  };
}

// 缓存只保留有限显示像素，不强引用整份冻结业务结果。
const cache = new Map<string, CoverageRaster>();
let cacheBytes = 0;
export function cachedCoverageRaster(
  key: string,
  features: readonly FrozenCoverageFeature[],
  mode: FrozenCoverageDisplay,
  demBox: readonly number[],
) {
  let hash = 2166136261;
  const add = (value: string) => {
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  };
  add(JSON.stringify(demBox));
  for (const feature of features)
    add(
      JSON.stringify([
        feature.geometry,
        feature.properties.strength_class,
        feature.properties.field_strength_dbuvm,
      ]),
    );
  const id = key + '|' + mode + '|' + features.length + '|' + (hash >>> 0),
    existing = cache.get(id);
  if (existing) {
    cache.delete(id);
    cache.set(id, existing);
    return existing;
  }
  const raster = buildCoverageRaster(features, mode, demBox);
  if (!raster) return null;
  while (cache.size && cacheBytes + raster.pixels.byteLength > COVERAGE_RASTER_LIMITS.cacheBytes) {
    const oldest = cache.keys().next().value!;
    cacheBytes -= cache.get(oldest)!.pixels.byteLength;
    cache.delete(oldest);
  }
  cache.set(id, raster);
  cacheBytes += raster.pixels.byteLength;
  return raster;
}

export function coverageScreenSize(size: readonly number[], pixelRatio: number) {
  if (size.length !== 2 || size.some((value) => !Number.isFinite(value) || value <= 0)) return null;
  const ratio = Math.min(
    Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1,
    2,
    COVERAGE_RASTER_LIMITS.screenEdge / Math.max(...size),
    Math.sqrt(COVERAGE_RASTER_LIMITS.screenPixels / (size[0] * size[1])),
  );
  return {
    width: Math.max(1, Math.floor(size[0] * ratio)),
    height: Math.max(1, Math.floor(size[1] * ratio)),
    ratio,
  };
}

// 保留VectorLayer/source供既有定位与来源检查；渲染时只贴一次合成图。
export function attachCoverageRaster(
  layer: Pick<Layer, 'render' | 'dispose' | 'getOpacity' | 'set'>,
  raster: CoverageRaster,
) {
  const fallback = layer.render.bind(layer),
    dispose = layer.dispose.bind(layer);
  let image: HTMLCanvasElement | null = null,
    screen: HTMLCanvasElement | null = null,
    container: HTMLDivElement | null = null,
    disposed = false;
  layer.render = (frame: FrameState | null, target: HTMLElement) => {
    if (disposed) return null;
    if (!frame || typeof document === 'undefined' || typeof document.createElement !== 'function')
      return fallback(frame, target);
    const size = coverageScreenSize(frame.size, frame.pixelRatio);
    if (!size) return null;
    if (!image) {
      image = document.createElement('canvas');
      image.width = raster.width;
      image.height = raster.height;
      const context = image.getContext('2d');
      if (!context) {
        image = null;
        return fallback(frame, target);
      }
      const data = context.createImageData(raster.width, raster.height);
      data.data.set(raster.pixels);
      context.putImageData(data, 0, 0);
    }
    if (!screen) {
      screen = document.createElement('canvas');
      screen.className = 'frozen-coverage-raster';
      Object.assign(screen.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        pointerEvents: 'none',
      });
      // OL can reuse a bare canvas as the following vector layer's target.
      // Keep the transformed raster context isolated from nodes and labels.
      container = document.createElement('div');
      container.className = 'ol-layer frozen-coverage-layer';
      Object.assign(container.style, {
        position: 'absolute', width: '100%', height: '100%', pointerEvents: 'none',
      });
      container.appendChild(screen);
    }
    if (screen.width !== size.width) screen.width = size.width;
    if (screen.height !== size.height) screen.height = size.height;
    screen.style.width = frame.size[0] + 'px';
    screen.style.height = frame.size[1] + 'px';
    const context = screen.getContext('2d');
    if (!context) return fallback(frame, target);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    context.save();
    context.globalAlpha = layer.getOpacity();
    context.imageSmoothingEnabled = true;
    const [a, b, c, d, e, f] = frame.coordinateToPixelTransform,
      [west, south, east, north] = raster.extent,
      sx = (east - west) / raster.width,
      sy = (south - north) / raster.height,
      r = size.ratio;
    context.setTransform(
      a * sx * r,
      b * sx * r,
      c * sy * r,
      d * sy * r,
      (a * west + c * north + e) * r,
      (b * west + d * north + f) * r,
    );
    context.drawImage(image, 0, 0);
    context.restore();
    return container;
  };
  layer.dispose = () => {
    if (!disposed) {
      disposed = true;
      for (const canvas of [image, screen])
        if (canvas) {
          canvas.remove();
          canvas.width = 0;
          canvas.height = 0;
        }
      image = null;
      screen = null;
      container?.remove();
      container = null;
    }
    dispose();
  };
  layer.set('coverageDisplaySmoothing', {
    kind: 'CACHED_CELL_RASTER',
    maximumEdgeCells: 0.5,
    width: raster.width,
    height: raster.height,
    sourceCells: raster.sourceCells,
  });
}

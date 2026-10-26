import MVT from 'ol/format/MVT';
import VectorTileSource from 'ol/source/VectorTile';
import VectorTileLayer from 'ol/layer/VectorTile';
import type VectorTile from 'ol/VectorTile';
import type RenderFeature from 'ol/render/Feature';
import { transformExtent } from 'ol/proj';
import { createXYZ } from 'ol/tilegrid';
import { unByKey } from 'ol/Observable';
import { Stroke, Style } from 'ol/style';

export type RoadState = 'idle' | 'loading' | 'ready' | 'error';
interface RoadManifest {
  format: 'mvt';
  version: string;
  minZoom: number;
  maxZoom: number;
  tileSize: number;
  bounds: number[];
  ranges: number[][];
  tiles: string;
}
interface RoadRequest {
  url: string;
  controller: AbortController;
  listeners: Set<{ ready: (data: ArrayBuffer) => void; fail: () => void }>;
}
// 道路数量较多，复用样式避免平移时为每条道路反复分配对象。
const majorRoadStyle = new Style({ stroke: new Stroke({ color: '#35546b', width: 1.6 }) });
const minorRoadStyle = new Style({ stroke: new Stroke({ color: '#223b51', width: 0.7 }) });

function readManifest(data: ArrayBuffer): RoadManifest {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  if (
    value.format !== 'mvt' ||
    value.layer !== 'roads' ||
    !/^[a-f0-9]{16}$/.test(value.version) ||
    value.minZoom !== 0 ||
    value.maxZoom !== 14 ||
    value.tileSize !== 256 ||
    value.tiles !== `${value.version}/{z}/{x}/{y}.mvt` ||
    !Array.isArray(value.bounds) ||
    value.bounds.length !== 4 ||
    !value.bounds.every(Number.isFinite) ||
    value.bounds[0] >= value.bounds[2] ||
    value.bounds[1] >= value.bounds[3] ||
    value.bounds[0] < -180 ||
    value.bounds[2] > 180 ||
    value.bounds[1] < -85.05112878 ||
    value.bounds[3] > 85.05112878 ||
    !Array.isArray(value.ranges) ||
    value.ranges.length !== 15 ||
    !value.ranges.every(
      (range: unknown, z: number) =>
        Array.isArray(range) &&
        range.length === 4 &&
        range.every((n) => Number.isInteger(n) && n >= 0 && n < 2 ** z) &&
        range[0] <= range[2] &&
        range[1] <= range[3],
    )
  )
    throw new Error('道路瓦片清单无效');
  return value;
}

export function createRoadLayerPool(
  fetcher: typeof fetch = (...args) => fetch(...args),
  url = `${import.meta.env.BASE_URL}maps/demo-roads-tiles/manifest.json`,
) {
  let manifest: RoadManifest | undefined;
  let active = 0;
  // 缓存的是有限数量的二进制瓦片；各地图独立解码和控制显隐。
  const cache = new globalThis.Map<string, ArrayBuffer>();
  const requests = new globalThis.Map<string, RoadRequest>();
  const queue: RoadRequest[] = [];
  const manifestUrl = () =>
    typeof document !== 'undefined' && document.baseURI ? new URL(url, document.baseURI).href : url;

  function pump() {
    // 大文件换成小瓦片后仍限制并发，避免道路再次堆满同源连接。
    while (active < 2 && queue.length) {
      const request = queue.shift()!;
      if (request.controller.signal.aborted) continue;
      active++;
      void (async () => {
        try {
          // 即便注入的读取器同步抛错，也等订阅者完成登记后再通知。
          await Promise.resolve();
          const response = await fetcher(request.url, {
            signal: request.controller.signal,
            cache: request.url === manifestUrl() ? 'no-cache' : 'default',
          });
          if (!response.ok) throw new Error(`道路读取失败：${response.status}`);
          const data = await response.arrayBuffer();
          if (request.controller.signal.aborted) return;
          cache.delete(request.url);
          cache.set(request.url, data);
          if (cache.size > 128) cache.delete(cache.keys().next().value!);
          requests.delete(request.url);
          for (const listener of request.listeners) listener.ready(data);
        } catch {
          if (!request.controller.signal.aborted)
            for (const listener of request.listeners) listener.fail();
        } finally {
          if (requests.get(request.url) === request) requests.delete(request.url);
          active--;
          pump();
        }
      })();
    }
  }
  function subscribe(address: string, ready: (data: ArrayBuffer) => void, fail: () => void) {
    const cached = cache.get(address);
    if (cached) {
      cache.delete(address);
      cache.set(address, cached);
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) ready(cached);
      });
      return () => {
        cancelled = true;
      };
    }
    let request = requests.get(address);
    if (!request) {
      request = { url: address, controller: new AbortController(), listeners: new Set() };
      requests.set(address, request);
      queue.push(request);
    }
    const listener = { ready, fail };
    request.listeners.add(listener);
    pump();
    return () => {
      request.listeners.delete(listener);
      if (!request.listeners.size) {
        request.controller.abort();
        if (requests.get(address) === request) requests.delete(address);
      }
    };
  }

  return (changed: (state: RoadState) => void = () => {}) => {
    const layer = new VectorTileLayer({
      visible: false,
      preload: 0,
      renderBuffer: 4,
      style: (feature) =>
        ['motorway', 'trunk'].includes(feature.get('fclass')) ? majorRoadStyle : minorRoadStyle,
    });
    let source: VectorTileSource | undefined;
    let manifestRelease: (() => void) | undefined;
    let epoch = 0,
      disposed = false,
      roundFailed = false;
    const pending = new Set<() => void>();
    const notify = (state: RoadState) => {
      if (!disposed) changed(state);
    };
    const release = () => {
      epoch++;
      manifestRelease?.();
      manifestRelease = undefined;
      for (const cancel of pending) cancel();
      pending.clear();
      layer.setSource(null);
      source?.dispose();
      source = undefined;
    };
    function attach(value: RoadManifest, current: number) {
      if (disposed || current !== epoch) return;
      layer.setExtent(transformExtent(value.bounds, 'EPSG:4326', 'EPSG:3857'));
      source = new VectorTileSource({
        format: new MVT({ layers: ['roads'] }),
        tileGrid: createXYZ({
          minZoom: value.minZoom,
          maxZoom: value.maxZoom,
          tileSize: value.tileSize,
        }),
        wrapX: false,
        transition: 0,
        attributions:
          '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> · 本地道路 / ODbL',
        tileUrlFunction: ([z, x, y]) => {
          const range = value.ranges[z];
          if (!range || x < range[0] || x > range[2] || y < range[1] || y > range[3])
            return undefined;
          return new URL(
            value.tiles
              .replace('{z}', String(z))
              .replace('{x}', String(x))
              .replace('{y}', String(y)),
            manifestUrl(),
          ).href;
        },
        tileLoadFunction: (tile, address) => {
          const vectorTile = tile as VectorTile<RenderFeature>;
          vectorTile.setLoader((extent, _resolution, projection) => {
            if (disposed || current !== epoch) return;
            if (!pending.size) roundFailed = false;
            notify('loading');
            const finish = (failed: boolean) => {
              pending.delete(cancel);
              roundFailed ||= failed;
              notify(pending.size ? 'loading' : roundFailed ? 'error' : 'ready');
            };
            const cancel = subscribe(
              address,
              (data) => {
                if (disposed || current !== epoch) return;
                try {
                  vectorTile.setFeatures(
                    vectorTile.getFormat().readFeatures(data, {
                      extent,
                      featureProjection: projection,
                    }),
                  );
                  finish(false);
                } catch {
                  cache.delete(address);
                  vectorTile.onError();
                  finish(true);
                }
              },
              () => {
                if (disposed || current !== epoch) return;
                vectorTile.onError();
                finish(true);
              },
            );
            pending.add(cancel);
          });
        },
      });
      layer.setSource(source);
      notify('ready');
    }
    const visibility = layer.on('change:visible', () => {
      if (disposed) return;
      release();
      if (!layer.getVisible()) {
        notify('idle');
        return;
      }
      const current = epoch;
      if (manifest) {
        attach(manifest, current);
        return;
      }
      notify('loading');
      manifestRelease = subscribe(
        manifestUrl(),
        (data) => {
          if (disposed || current !== epoch) return;
          try {
            manifest = readManifest(data);
            attach(manifest, current);
          } catch {
            cache.delete(manifestUrl());
            notify('error');
          }
        },
        () => {
          if (current === epoch) notify('error');
        },
      );
    });
    return {
      layer,
      dispose() {
        if (disposed) return;
        disposed = true;
        unByKey(visibility);
        release();
        layer.dispose();
      },
    };
  };
}

// 仅缓存当前标签页的清单及最近瓦片；不下载原 GeoJSON，不写入业务持久化存储。
export const createRoadLayer = createRoadLayerPool();

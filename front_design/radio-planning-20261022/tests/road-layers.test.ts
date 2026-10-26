import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GeoJSON from 'ol/format/GeoJSON';
import MVT from 'ol/format/MVT';
import type LineString from 'ol/geom/LineString';
import { get as getProjection } from 'ol/proj';
import { createRoadLayerPool } from '../src/maps/road-layers';
import {
  createRoadWorkerHandler,
  type RoadRecord,
  type RoadReply,
  type RoadRequest,
} from '../src/maps/roads.worker';

const manifestUrl = 'https://example.test/maps/demo-roads-tiles/manifest.json';
const manifest = JSON.parse(
  readFileSync(new URL('../public/maps/demo-roads-tiles/manifest.json', import.meta.url), 'utf8'),
);
const encode = (value: unknown): ArrayBuffer =>
  new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;
const response = (data: ArrayBuffer): Response =>
  ({ ok: true, arrayBuffer: async () => data }) as Response;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('道路 MVT 瓦片图层', () => {
  it('按清单范围生成版本化瓦片地址，并解码实际瓦片', async () => {
    const fetcher = vi.fn(async () => response(encode(manifest)));
    const changed = vi.fn();
    const road = createRoadLayerPool(fetcher as typeof fetch, manifestUrl)(changed);
    road.layer.setVisible(true);
    await vi.waitFor(() => expect(road.layer.getSource()).not.toBeNull());
    expect(changed).toHaveBeenCalledWith('loading');
    expect(changed).toHaveBeenLastCalledWith('ready');
    const source = road.layer.getSource()!;
    const projection = getProjection('EPSG:3857')!;
    const address = source.getTileUrlFunction()([0, 0, 0], 1, projection);
    expect(address).toBe(
      'https://example.test/maps/demo-roads-tiles/' + manifest.version + '/0/0/0.mvt',
    );
    expect(source.getTileUrlFunction()([5, 0, 0], 1, projection)).toBeUndefined();
    const tile = readFileSync(
      new URL('../public/maps/demo-roads-tiles/' + manifest.version + '/0/0/0.mvt', import.meta.url),
    );
    const buffer = tile.buffer.slice(tile.byteOffset, tile.byteOffset + tile.byteLength) as ArrayBuffer;
    expect(new MVT({ layers: ['roads'] }).readFeatures(buffer).length).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledOnce();
    road.dispose();
  });

  it('清单无效时明确失败，不创建道路源', async () => {
    const fetcher = vi.fn(async () => response(encode({ ...manifest, layer: 'invalid' })));
    const changed = vi.fn();
    const road = createRoadLayerPool(fetcher as typeof fetch, manifestUrl)(changed);
    road.layer.setVisible(true);
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith('error'));
    expect(road.layer.getSource()).toBeNull();
    road.dispose();
  });

  it('复访复用清单缓存，但每张地图拥有独立瓦片源', async () => {
    const fetcher = vi.fn(async () => response(encode(manifest)));
    const create = createRoadLayerPool(fetcher as typeof fetch, manifestUrl);
    const first = create();
    first.layer.setVisible(true);
    await vi.waitFor(() => expect(first.layer.getSource()).not.toBeNull());
    const firstSource = first.layer.getSource();
    first.dispose();
    const second = create();
    second.layer.setVisible(true);
    await vi.waitFor(() => expect(second.layer.getSource()).not.toBeNull());
    expect(second.layer.getSource()).not.toBe(firstSource);
    expect(fetcher).toHaveBeenCalledOnce();
    second.dispose();
  });

  it('隐藏时取消读取，迟到清单不得重新挂载', async () => {
    let finish!: (value: Response) => void;
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => { finish = resolve; }),
    );
    const changed = vi.fn();
    const road = createRoadLayerPool(fetcher as typeof fetch, manifestUrl)(changed);
    road.layer.setVisible(true);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    road.layer.setVisible(false);
    expect((fetcher.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
    finish(response(encode(manifest)));
    await Promise.resolve();
    expect(road.layer.getSource()).toBeNull();
    expect(changed).toHaveBeenLastCalledWith('idle');
    road.dispose();
  });
});

describe('道路 Worker 与原始数据保真', () => {
  it('只解析一次并按确认分批输出，完整坐标及属性与原加载方式一致', async () => {
    const text = readFileSync(
      new URL('../public/maps/demo-roads.geojson', import.meta.url),
      'utf8',
    );
    const raw = JSON.parse(text),
      original = JSON.stringify(raw);
    const expected = new GeoJSON().readFeatures(raw, {
      dataProjection: 'EPSG:4326',
      featureProjection: 'EPSG:3857',
    });
    const json = vi.fn(async () => raw),
      replies: RoadReply[] = [];
    const fetcher = vi.fn(async () => ({ ok: true, json }) as unknown as Response);
    const handle = createRoadWorkerHandler((message) => replies.push(message), fetcher);
    await handle({ type: 'load', url: '/maps/demo-roads.geojson' });
    expect(replies).toHaveLength(1);
    const received: RoadRecord[] = [];
    while (true) {
      const reply = replies.at(-1)!;
      expect(reply.type).toBe('batch');
      if (reply.type !== 'batch') throw new Error('道路批次失败');
      expect(reply.roads.length).toBeLessThanOrEqual(128);
      received.push(...reply.roads);
      if (reply.done) break;
      await handle({ type: 'next' });
    }
    expect(json).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(received).toHaveLength(15600);
    for (let index = 0; index < received.length; index++) {
      expect(received[index].coordinates).toEqual(
        (expected[index].getGeometry() as LineString).getCoordinates(),
      );
      expect(received[index].properties).toEqual(raw.features[index].properties);
    }
    expect(JSON.stringify(raw) === original).toBe(true);
  });

  it('取消中断下载，过期请求失败不回传', async () => {
    let signal: AbortSignal | undefined, reject!: (reason: Error) => void;
    const fetcher = vi.fn((_url, options) => {
      signal = options?.signal as AbortSignal;
      return new Promise<Response>((_resolve, fail) => {
        reject = fail;
      });
    }) as unknown as typeof fetch;
    const send = vi.fn(),
      handle = createRoadWorkerHandler(send, fetcher);
    const pending = handle({ type: 'load', url: '/roads' });
    await handle({ type: 'cancel' });
    expect(signal!.aborted).toBe(true);
    reject(new Error('已取消'));
    await pending;
    expect(send).not.toHaveBeenCalled();
  });

  it('旧请求的迟到失败不覆盖当前请求，已取消的迟到响应不再解析', async () => {
    const send = vi.fn(),
      json = vi.fn(async () => ({ type: 'FeatureCollection', features: [] }));
    let reject!: (reason: Error) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValueOnce({ ok: true, json } as unknown as Response);
    const handle = createRoadWorkerHandler(send, fetcher);
    const old = handle({ type: 'load', url: '/old' });
    await handle({ type: 'load', url: '/current' });
    reject(new Error('旧请求失败'));
    await old;
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'batch', roads: [], done: true });
    let finish!: (response: Response) => void;
    const pending = createRoadWorkerHandler(
      send,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const request = pending({ type: 'load', url: '/cancelled' });
    await pending({ type: 'cancel' });
    finish({ ok: true, json } as unknown as Response);
    await request;
    expect(json).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('错误 HTTP 或几何明确失败，不静默漏掉道路', async () => {
    const send = vi.fn();
    const unavailable = createRoadWorkerHandler(
      send,
      vi.fn(async () => ({ ok: false, status: 404 }) as Response),
    );
    await unavailable({ type: 'load', url: '/roads' });
    expect(send).toHaveBeenLastCalledWith({ type: 'error', message: '道路读取失败：404' });
    const invalid = createRoadWorkerHandler(
      send,
      vi.fn(
        async () =>
          ({
            ok: true,
            json: async () => ({
              type: 'FeatureCollection',
              features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } }],
            }),
          }) as Response,
      ),
    );
    await invalid({ type: 'load', url: '/roads' });
    expect(send).toHaveBeenLastCalledWith({ type: 'error', message: '道路几何格式无效' });
  });
});

// 已停用：生产道路改为离线 MVT；保留旧 Worker 和保真测试供历史实现核对。
import { fromLonLat } from 'ol/proj';

export interface RoadRecord {
  coordinates: number[][];
  properties: Record<string, unknown> | null;
  id?: string | number;
}
export type RoadRequest = { type: 'load'; url: string } | { type: 'next' } | { type: 'cancel' };
export type RoadReply =
  | { type: 'batch'; roads: RoadRecord[]; done: boolean }
  | { type: 'error'; message: string };
interface RoadFeature {
  type: 'Feature';
  properties: Record<string, unknown> | null;
  id?: string | number;
  geometry: { type: 'LineString'; coordinates: number[][] };
}

// 每批同时限制道路和坐标数量；收到主线程确认后才继续，避免消息堆积。
export function createRoadWorkerHandler(
  send: (message: RoadReply) => void,
  fetcher: typeof fetch = fetch,
) {
  let features: RoadFeature[] = [],
    index = 0,
    controller: AbortController | undefined;
  function batch() {
    const roads: RoadRecord[] = [];
    let points = 0;
    while (index < features.length && roads.length < 128 && points < 4096) {
      const feature = features[index++];
      if (feature.type !== 'Feature' || feature.geometry?.type !== 'LineString')
        throw new Error('道路几何格式无效');
      const coordinates = feature.geometry.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length < 2) throw new Error('道路坐标无效');
      roads.push({
        properties: feature.properties,
        id: feature.id,
        coordinates: coordinates.map((point) => {
          if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))
            throw new Error('道路坐标无效');
          // 原始文件保持 WGS84；仅后台生成地图显示使用的投影坐标。
          return fromLonLat(point);
        }),
      });
      points += coordinates.length;
    }
    const done = index === features.length;
    if (done) features = [];
    send({ type: 'batch', roads, done });
  }
  return async (message: RoadRequest) => {
    if (message.type === 'cancel') {
      controller?.abort();
      features = [];
      return;
    }
    let current = controller;
    try {
      if (message.type === 'load') {
        controller?.abort();
        current = controller = new AbortController();
        const response = await fetcher(message.url, { signal: current.signal });
        if (current !== controller || current.signal.aborted) return;
        if (!response.ok) throw new Error(`道路读取失败：${response.status}`);
        // JSON 仅在 Worker 解析一次，主线程不接收整份原始文本。
        const data = await response.json();
        if (current !== controller || current.signal.aborted) return;
        if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features))
          throw new Error('道路数据格式无效');
        features = data.features;
        index = 0;
      }
      if (current && !current.signal.aborted) batch();
    } catch (error) {
      if (current === controller && current && !current.signal.aborted) {
        features = [];
        send({ type: 'error', message: error instanceof Error ? error.message : '道路读取失败' });
      }
    }
  };
}

// 测试可直接调用处理器；浏览器仅在独立 Worker 上安装消息入口。
if (typeof self !== 'undefined' && typeof document === 'undefined') {
  const worker = self as unknown as {
    onmessage: (event: MessageEvent<RoadRequest>) => void;
    postMessage: (message: RoadReply) => void;
  };
  const handle = createRoadWorkerHandler((message) => worker.postMessage(message));
  worker.onmessage = (event) => {
    void handle(event.data);
  };
}

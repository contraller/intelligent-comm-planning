import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Fill, RegularShape, Stroke, Style, Text } from 'ol/style';
import { projectCoordinate } from './layers';
import type { CandidateMapFrame, CandidateSelection } from '../types/planning-candidates';

// 候选用菱形及文字结论，与正式站点和设备状态图标分开。
export function createPlanningCandidateLayer() {
  const source = new VectorSource<Feature<Point>>(), layer = new VectorLayer({ source, zIndex: 65 });
  let current: CandidateMapFrame | undefined;
  function update(frame?: CandidateMapFrame) {
    current = frame; source.clear(); layer.setVisible(!!frame?.visible);
    if (!frame) return;
    for (const row of frame.points) {
      if (!row.coordinate) continue;
      const selected = frame.selectedId === row.siteId;
      const feature = new Feature({ geometry: new Point(projectCoordinate(row.coordinate)), kind: 'planning-candidate-point',
        selection: { owner: frame.owner, epoch: frame.epoch, siteId: row.siteId } satisfies CandidateSelection });
      feature.setStyle(new Style({ image: new RegularShape({ points: 4, radius: selected ? 12 : 9,
        fill: new Fill({ color: row.isDeployable === true ? '#256d80' : '#25384b' }), stroke: new Stroke({ color: selected ? '#ffffff' : '#9acbd5', width: selected ? 3 : 2 }) }),
        text: new Text({ text: row.isDeployable === true ? '可' : row.isDeployable === false ? '×' : '?', fill: new Fill({ color: '#fff' }), font: 'bold 11px sans-serif' }) }));
      source.addFeature(feature);
    }
  }
  function pick(feature: Feature): CandidateSelection | undefined {
    if (!current?.visible || !layer.getVisible() || !source.hasFeature(feature as Feature<Point>)) return;
    const event = feature.get('selection') as CandidateSelection;
    if (event.owner === current.owner && event.epoch === current.epoch) return { ...event };
  }
  return { layer, update, pick, dispose: () => { current = undefined; source.clear(); layer.setVisible(false); } };
}

import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import VectorSource from 'ol/source/Vector';
import VectorLayer from 'ol/layer/Vector';
import { Circle, Fill, Stroke, Style, Text } from 'ol/style';
import type { ApiPlanningNode } from '../types/planning-api';
import type { PlanningDemand } from '../types/planning';
import type { NetworkLink } from '../types/domain';
import type { PlanningCoverage } from '../types/coverage';
import { projectCoordinate } from './layers';

export interface PlanningMapOverlay { nodes: ApiPlanningNode[]; links?: NetworkLink[]; demands?: PlanningDemand[]; coverage?: PlanningCoverage; snapshotId?: string; selectedDemandId?: string }
// 只用稳定对象 ID 关联图层；未知告警保持未知，不映射成正常。
export function planningApiLayer(overlay: PlanningMapOverlay, selectedId = '', selectedLink = '', highlights: string[] = []) {
  const positions = new Map(overlay.nodes.map(n => [n.id, n.coordinate])), features: Feature[] = [];
  for (const link of overlay.links ?? []) {
    const a = positions.get(link.a), b = positions.get(link.b); if (!a || !b) continue;
    const feature = new Feature({ geometry: new LineString([projectCoordinate(a), projectCoordinate(b)]), kind: 'api-planned-link', objectId: link.id });
    feature.setStyle(new Style({ stroke: new Stroke({ color: link.id === selectedLink || highlights.includes(link.id) ? '#ffe08a' : '#4bb4db', width: link.id === selectedLink ? 4 : 2, lineDash: link.backup ? [6, 5] : undefined }) })); features.push(feature);
  }
  for (const demand of overlay.demands ?? []) {
    const a = positions.get(demand.sourceId), b = positions.get(demand.targetId); if (!a || !b) continue;
    const feature = new Feature({ geometry: new LineString([projectCoordinate(a), projectCoordinate(b)]), kind: 'task-demand', objectId: demand.id });
    // 选中需求保留紫色语义，以线宽和文字共同强调。
    const selected = demand.id === overlay.selectedDemandId;
    feature.setStyle(new Style({ stroke: new Stroke({ color: '#c79bef', width: selected ? 5 : 2, lineDash: [8, 6] }), text: new Text({ text: demand.id, font: selected ? 'bold 13px Microsoft YaHei' : undefined, fill: new Fill({ color: '#e7d2ff' }), stroke: new Stroke({ color: '#102132', width: 3 }) }) })); features.push(feature);
  }
  for (const node of overlay.nodes) {
    const feature = new Feature({ geometry: new Point(projectCoordinate(node.coordinate)), kind: 'api-planning-node', objectId: node.id });
    const color = node.id === selectedId || highlights.includes(node.id) ? '#ffe08a' : node.status === 'FAULT' ? '#ef788b' : node.alert === true ? '#efa84c' : node.alert === null ? '#a9b8ca' : '#60ccbb';
    feature.setStyle(new Style({ image: new Circle({ radius: node.id === selectedId ? 8 : 6, fill: new Fill({ color }), stroke: new Stroke({ color: '#14273e', width: 2 }) }), text: new Text({ text: node.name, offsetY: -15, fill: new Fill({ color: '#d9e8f6' }), stroke: new Stroke({ color: '#112033', width: 3 }) }) })); features.push(feature);
  }
  return new VectorLayer({ source: new VectorSource({ features }), zIndex: 40 });
}

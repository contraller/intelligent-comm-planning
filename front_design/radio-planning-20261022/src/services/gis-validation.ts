import type { Coordinate, ResourcesData } from '../types/domain';
import type { EditForm, ResourceIssue } from '../types/resource-edit';
import { DEMO_BBOX } from '../config/demo';

export interface GisValidationIssue extends ResourceIssue { source: 'resource' | 'task' }
export interface GisResourceTarget { kind: EditForm['kind']; id: string; field: string; coordinate?: Coordinate }
export interface GisFieldFocus { id: string; field: string; serial: number }

// 仅解释现有错误数据，不改变校验规则或接口传输格式。
export function gisIssues(value: unknown, source: GisValidationIssue['source']): GisValidationIssue[] {
  if (!Array.isArray(value)) return [];
  return value.map(row => {
    if (!row || typeof row.objectId !== 'string' || typeof row.field !== 'string' || typeof row.message !== 'string')
      return { source, objectId: '', field: '', message: '错误明细格式无法识别，请查看失败说明。' };
    return { source, objectId: row.objectId, field: row.field, message: row.message,
      ...(typeof row.sheet === 'string' ? { sheet: row.sheet } : {}), ...(typeof row.row === 'number' ? { row: row.row } : {}) };
  });
}

function validPoint(value: unknown): value is Coordinate {
  return Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'number' && Number.isFinite(v))
    && value[0] >= DEMO_BBOX[0] && value[0] <= DEMO_BBOX[2] && value[1] >= DEMO_BBOX[1] && value[1] <= DEMO_BBOX[3];
}

export function gisResourceTarget(issue: ResourceIssue, resources: ResourcesData, form: EditForm | null): GisResourceTarget | null {
  const candidates: GisResourceTarget[] = [];
  const kinds = [['station', 'nodes'], ['device', 'devices'], ['interference', 'interference_sources'], ['candidate', 'topology_links']] as const;
  for (const [kind, sheet] of kinds) {
    if (issue.sheet && issue.sheet !== sheet) continue;
    const rows = kind === 'station' ? resources.stations : kind === 'device' ? resources.devices : kind === 'candidate' ? resources.candidateLinks ?? [] : resources.interferences ?? [];
    const matches = rows.filter(row => row.id === issue.objectId);
    const current = form?.kind === kind && form.id === issue.objectId ? form : null;
    if (matches.length > 1) return null;
    if (!matches.length && !current?.creating) continue;
    let point: unknown = kind === 'device'
      ? resources.stations.find(row => row.id === (current?.fields.stationId || resources.devices.find(d => d.id === issue.objectId)?.stationId))?.coordinate
      : (matches[0] as { coordinate?: Coordinate } | undefined)?.coordinate;
    // 未应用的坐标错误只去表单，不能偷偷退回旧坐标定位。
    if (current && kind !== 'device' && kind !== 'candidate') point = current.fields.longitude?.trim() && current.fields.latitude?.trim()
      ? [Number(current.fields.longitude), Number(current.fields.latitude)] : undefined;
    // 候选只定位已有端点，未知引用不回退到旧配置，也不计算中点或距离。
    if(kind==='candidate'){
      const link=resources.candidateLinks?.find(row=>row.id===issue.objectId);
      const sideB=['nodeBId','deviceBId'].includes(issue.field);
      const nodeId=current ? current.fields[sideB?'nodeBId':'nodeAId'] : sideB?link?.nodeBId:link?.nodeAId;
      point=resources.stations.find(row=>row.id===nodeId)?.coordinate;
    }
    candidates.push({ kind, id: issue.objectId, field: issue.field === 'coordinate' ? 'longitude' : issue.field,
      ...(validPoint(point) ? { coordinate: point } : {}) });
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

// 在组件自己的容器内找字段；未知字段退到分组，不拼接任意 CSS 选择器。
export function focusGisField(root: HTMLElement | null, field: string): boolean {
  if (!root) return false;
  const target = Array.from(root.querySelectorAll<HTMLElement>('[data-validation-field]'))
    .find(el => el.getAttribute('data-validation-field') === field && !el.matches(':disabled'));
  const element = target ?? root;
  element.focus({ preventScroll: true }); element.scrollIntoView({ block: 'center' });
  return !!target;
}

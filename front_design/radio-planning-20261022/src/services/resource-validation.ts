// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from './random-uuid';
import { env } from '../config/env';
import type { Device, InterferenceSource, ResourcesData, Station } from '../types/domain';
import type { EditForm, ResourceChanges, ResourceIssue, ResourceKind } from '../types/resource-edit';
import { ApiError } from './types';
import { stationTypes } from '../config/resource-options';
import type { CandidateLink, CandidateLinkPatch } from '../types/candidate-link';
import { candidateConfigFields, emptyCandidateAssessment, validateCandidateLinks } from './candidate-link';
import { maintenanceIssues } from './device-maintenance';
import { coordinateInBounds, validCoordinate, validPlanningBounds } from './resource-geography';

export const stationFields = ['name', 'coordinate', 'elevationM', 'region', 'remark'] as const;
export const deviceFields = ['antennaHeightM', 'txPowerDbm', 'workFreqKhz', 'currentWorkMode', 'ports'] as const;
// 对象键顺序不影响差异，NaN 不能被序列化成空值后误认一致。
export function resourceSignature(value: unknown): string {
  if(typeof value==='number'&&!Number.isFinite(value))return 'INVALID:'+value;
  if(Array.isArray(value))return '['+value.map(resourceSignature).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+resourceSignature(v)).join(',')+'}';
  return JSON.stringify(value)??'undefined';
}
export const same = (a: unknown, b: unknown) => resourceSignature(a)===resourceSignature(b);
// 候选含完整参考，直接按键比较可免去每次读取的深排序与字符串分配。
// 保留原签名语义：对象忽略 undefined，NaN 不等于 null。
function sameCandidateValue(a:unknown,b:unknown):boolean {
  if(a===b)return true;
  if(typeof a==='number'&&typeof b==='number')return Number.isNaN(a)&&Number.isNaN(b);
  if(Array.isArray(a)||Array.isArray(b)){
    if(!Array.isArray(a)||!Array.isArray(b))return false;
    // 稀疏数组不属于候选契约，但差异判断仍沿用旧签名对空洞的处理。
    if(Object.keys(a).length<a.length||Object.keys(b).length<b.length)return same(a,b);
    if(a.length!==b.length)return false;
    for(let index=0;index<a.length;index++)if((index in a)!==(index in b)||!sameCandidateValue(a[index],b[index]))return false;
    return true;
  }
  if(a&&b&&typeof a==='object'&&typeof b==='object'){
    const left=a as Record<string,unknown>,right=b as Record<string,unknown>;
    const keys=Object.keys(left).filter(key=>left[key]!==undefined),other=Object.keys(right).filter(key=>right[key]!==undefined);
    return keys.length===other.length&&keys.every(key=>Object.hasOwn(right,key)&&sameCandidateValue(left[key],right[key]));
  }
  // 正常候选仅有 JSON 值；意外类型仍交原签名处理，避免放宽差异含义。
  return same(a,b);
}
export const resourceIdValid=(id:unknown):id is string=>typeof id==='string'&&id.trim()===id&&id.length>0&&id.length<=120&&!/[\u0000-\u001f\u007f]/.test(id);
export const interferenceFields=['name','coordinate','elevationM','antennaHeightM','centerFreqKhz','bandwidthKhz','txPowerDbm','antennaGainDbi','interferenceType','patternType','azimuthDeg','dutyCycle','active'] as const;
export const changesPresent=(c:ResourceChanges)=>Object.values(c).some(rows=>Array.isArray(rows)&&rows.length>0);
// 候选是独立输入资料，只有原资源变化才暂停已有正式结果展示。
export const resourceResultsChanged=(c:ResourceChanges)=>Object.entries(c).some(([key,rows])=>!['newCandidateLinks','candidateLinks','importedCandidateLinks'].includes(key)&&Array.isArray(rows)&&rows.length>0);
export function validResourceTime(s:unknown) {
  if(s==='')return true;
  return typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)===s.slice(0,10);
}
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export function validateResources(
  candidate: ResourcesData,
  previous: ResourcesData,
  source: ResourcesData,
) {
  // 同一读取快照仍完整校验结构与引用，只免去必然为空的候选变化提示比较。
  const sameCandidateSnapshot=candidate===previous;
  // 校验仅复制调用方的基线，缺失字段不能按 Mock 样例 ID 补值。
  candidate=structuredClone(candidate);previous=structuredClone(previous);source=structuredClone(source);
  const issues: ResourceIssue[] = [];
  const warnings: ResourceIssue[] = [];
  let sheet:ResourceKind|undefined;
  const issue = (objectId: string, field: string, message: string) =>
    issues.push({ objectId, field, message, ...(sheet?{sheet}:{}) });
  if (
    !same(candidate.models, source.models) ||
    !same(candidate.antennas, source.antennas) ||
    candidate.version !== source.version ||
    candidate.source !== source.source ||
    !same(candidate.planningBounds, source.planningBounds)
  ) {
    issue('resources', 'dictionary', '字典与来源版本不可修改');
  }
  for (const kind of ['stations', 'devices'] as const) {
    sheet=kind==='stations'?'nodes':'devices';
    const rows = candidate[kind];
    if (!Array.isArray(rows)) {
      issue(kind, 'structure', '资源集合格式无效');
      continue;
    }
    const allowed: readonly string[] = kind === 'stations' ? stationFields : deviceFields;
    const originals = new Map<string, Record<string, unknown>>(
      previous[kind].map((row) => [row.id, row as unknown as Record<string, unknown>]),
    );
    const seen = new Set<string>();
    if ([...originals.keys(),...source[kind].map(row=>row.id)].some(id=>!rows.some(row=>row?.id===id))) issue(kind, 'id', '不允许移除已保存资源');
    for (const row of rows) {
      if (!row || !resourceIdValid(row.id)) {
        issue(kind, 'id', '资源 ID 无效');
        continue;
      }
      const original = source[kind].find(item=>item.id===row.id) as unknown as Record<string,unknown> | undefined ?? originals.get(row.id);
      if (seen.has(row.id)) {
        issue(row.id, 'id', '资源不存在或 ID 重复');
        continue;
      }
      seen.add(row.id);
      const record = row as unknown as Record<string, unknown>;
      const supported = kind==='stations'
        ? ['id','name','echelon','parentIds','coordinate','elevationM','region','classes','status','alert','relayCapable','key','mobility','subtype','role','remark','origin']
        : ['id','stationId','modelId','antennaId','status','alert','antennaHeightM','txPowerDbm','workFreqKhz','installedAt','tiltDeg','azimuthDeg','availability','origin','currentWorkMode','ports'];
      if(Object.keys(record).some(key=>!supported.includes(key)))issue(row.id,'structure','包含未知资源字段');
      if(!['SOURCE','MANUAL','IMPORT'].includes(String(record.origin))||(record.status!==null&&!['NORMAL','FAULT','OFFLINE'].includes(String(record.status)))||(record.alert!==null&&typeof record.alert!=='boolean'))
        issue(row.id,'status','来源、运行状态或告警格式无效');
      if(!original)continue;
      for (const key of new Set([...Object.keys(original), ...Object.keys(record)])) {
        if (!allowed.includes(key) && !(kind==='devices'&&key==='availability') && !same(record[key], original[key]))
          issue(row.id, key, '只读字段或关联不可修改');
      }
    }
  }
  // 结构非法时停止字段访问，避免损坏存储触发不明确的运行时异常。
  if (issues.length) return { issues, warnings };
  const stationIds = new Set(candidate.stations.map((s) => s.id));
  function checkCoordinate(id: string, value: unknown, original: unknown) {
    if (!validCoordinate(value)) issue(id, 'coordinate', '经纬度须为有效有限数，经度在前、纬度在后');
    else if (!same(value, original)) {
      if (!validPlanningBounds(source.planningBounds)) issue(id, 'coordinate', '当前 DEM 范围缺失或无效，不能新增或修改坐标');
      else if (!coordinateInBounds(value, source.planningBounds)) issue(id, 'coordinate', '经纬度须位于当前 DEM 覆盖范围内');
    }
  }
  sheet='nodes';
  for (const station of candidate.stations) {
    if (
      typeof station.name !== 'string' ||
      !station.name.trim() ||
      station.name.trim().length > 60 ||
      station.name !== station.name.trim()
    )
      issue(station.id, 'name', '名称去除首尾空白后须为 1–60 字符');
    if (typeof station.region !== 'string' || station.region.length > 60)
      issue(station.id, 'region', '所属区域最多 60 字符');
    const c = station.coordinate;
    checkCoordinate(station.id, c, previous.stations.find(row => row.id === station.id)?.coordinate);
    if (station.elevationM !== null && !finite(station.elevationM))
      issue(station.id, 'elevationM', '高程须为有限数或留空');
    if(typeof station.remark!=='string'||station.remark.length>500)issue(station.id,'remark','备注最多 500 字符');
    const definition=stationTypes[station.subtype??''];
    if(!definition||station.echelon!==definition.echelon||station.mobility!==definition.mobility||
      !Array.isArray(station.classes)||!same([...station.classes].sort(),[...definition.classes].sort())||
      !['TASK','FIXED_STATION','RELAY'].includes(station.role??'')||typeof station.key!=='boolean'||typeof station.relayCapable!=='boolean')
      issue(station.id,'subtype','节点子类型、层级、能力、移动类型或角色组合无效');
    if (!Array.isArray(station.parentIds)||new Set(station.parentIds).size!==station.parentIds.length||!station.parentIds.every((id) => stationIds.has(id)&&id!==station.id))
      issue(station.id, 'parentIds', '上级节点不存在');
  }
  const visited=new Set<string>(),visiting=new Set<string>(),nodes=new Map(candidate.stations.map(s=>[s.id,s]));
  const visit=(id:string):boolean=>{
    if(visiting.has(id))return false;if(visited.has(id))return true;visiting.add(id);
    const parents=nodes.get(id)?.parentIds;
    if(Array.isArray(parents))for(const parent of parents)if(nodes.has(parent)&&!visit(parent))return false;
    visiting.delete(id);visited.add(id);return true;
  };
  for(const station of candidate.stations)if(!visit(station.id)){issue(station.id,'parentIds','上级节点形成循环引用');break;}
  const models = new Map(candidate.models.map((m) => [m.id, m]));
  const antennas = new Set(candidate.antennas.map((a) => a.id));
  const originals = new Map(source.devices.map((d) => [d.id, d]));
  const previousDevices = new Map(previous.devices.map((d) => [d.id, d]));
  sheet='devices';
  for (const device of candidate.devices) {
    if(!['ACTIVE','OFF_SHELF'].includes(device.availability??''))issue(device.id,'availability','在架状态无效');
    if(!validResourceTime(device.installedAt))issue(device.id,'installedAt','安装时间需为有效带时区 ISO 日期或留空');
    if(device.tiltDeg!==null&&(!finite(device.tiltDeg)||device.tiltDeg < -90||device.tiltDeg>90))issue(device.id,'tiltDeg','倾角需为空或 -90–90 度');
    if(device.azimuthDeg!==null&&(!finite(device.azimuthDeg)||device.azimuthDeg<0||device.azimuthDeg>=360))issue(device.id,'azimuthDeg','方位角需为空或 0–小于 360 度');
    const model = models.get(device.modelId);
    if (!stationIds.has(device.stationId) || !model || !antennas.has(device.antennaId)) {
      issue(device.id, 'association', '节点、型号或天线引用无效');
      continue;
    }
    // 端口整批校验，失败不应用部分修改。
    const previousDevice = previousDevices.get(device.id);
    // HTTP来源中的未改模式只是只读值，不能按Mock教学字典反向限制设备参数。
    const maintenanceDevice = env.mode === 'http' && same(device.currentWorkMode, previousDevice?.currentWorkMode)
      ? { ...device, currentWorkMode: null } : device;
    for (const message of maintenanceIssues(maintenanceDevice, previousDevice, model)) issue(device.id, 'maintenance', message);
    if (
      !candidate.stations
        .find((s) => s.id === device.stationId)!
        .classes.includes(model.deviceClass)
    )
      issue(device.id, 'stationId', '设备类别与节点能力不一致');
    if (!finite(device.antennaHeightM) || device.antennaHeightM < 0)
      issue(device.id, 'antennaHeightM', '天线高度必填且须为不小于 0 的有限数');
    if (!finite(device.txPowerDbm)) issue(device.id, 'txPowerDbm', '发射功率必填且须为有限数');
    else if (device.txPowerDbm > model.txPowerMaxDbm) {
      // 仅允许来源中已知且本次未改动的超限值，不扩大型号上限。
      const sourcePower = originals.get(device.id)?.txPowerDbm;
      const unchanged =
        device.txPowerDbm === sourcePower &&
        device.txPowerDbm === previousDevices.get(device.id)?.txPowerDbm;
      const message = `型号上限为 ${model.txPowerMaxDbm} dBm；来源功率 ${sourcePower} dBm 存在差异`;
      if (unchanged && device.txPowerDbm - model.txPowerMaxDbm <= 0.040001)
        warnings.push({
          objectId: device.id,
          field: 'txPowerDbm',
          message: `${message}，本次未改动予以保留`,
        });
      else issue(device.id, 'txPowerDbm', `修改后的功率不得超过 ${model.txPowerMaxDbm} dBm`);
    }
    if (
      device.workFreqKhz !== null &&
      (!finite(device.workFreqKhz) ||
        device.workFreqKhz < model.freqMinKhz ||
        device.workFreqKhz > model.freqMaxKhz)
    )
      issue(
        device.id,
        'workFreqKhz',
        `频率须为空或位于 ${model.freqMinKhz}–${model.freqMaxKhz} kHz`,
      );
  }
  sheet='interference_sources';
  const interferenceIds=new Set<string>();
  if(!Array.isArray(candidate.interferences))issue('interferences','structure','干扰源集合格式无效');
  else for(const row of candidate.interferences){
    if(!row||!resourceIdValid(row.id)||interferenceIds.has(row.id)){issue('interferences','id','干扰源 ID 无效或重复');continue;}
    interferenceIds.add(row.id);
    const original=previous.interferences?.find(item=>item.id===row.id);
    if(Object.keys(row).some(k=>!['id','origin',...interferenceFields].includes(k as never))||
      !['SOURCE','MANUAL','IMPORT'].includes(row.origin)||original&&original.origin!==row.origin)issue(row.id,'origin','未知字段或来源不可修改');
    if(typeof row.name!=='string'||!row.name.trim()||row.name!==row.name.trim()||row.name.length>60)issue(row.id,'name','名称需为 1–60 字符');
    checkCoordinate(row.id, row.coordinate, original?.coordinate);
    for(const key of ['centerFreqKhz','bandwidthKhz'] as const)if(!finite(row[key])||row[key]<=0)issue(row.id,key,'必填且须大于 0');
    for(const key of ['txPowerDbm','antennaHeightM'] as const)if(!finite(row[key])||key==='antennaHeightM'&&row[key]<0)issue(row.id,key,'必填有限数，天线高度不得小于 0');
    for(const key of ['elevationM','antennaGainDbi'] as const)if(row[key]!==null&&!finite(row[key]))issue(row.id,key,'须为有限数或空值');
    if(row.dutyCycle!==null&&(!finite(row.dutyCycle)||row.dutyCycle<0||row.dutyCycle>1))issue(row.id,'dutyCycle','占空比需为 0–1 或空值');
    if(!['NARROWBAND','BROADBAND','SWEEP','PULSE','NOISE'].includes(row.interferenceType))issue(row.id,'interferenceType','干扰类型无效');
    if(row.patternType!==null&&!['OMNI','DIRECTIONAL'].includes(row.patternType))issue(row.id,'patternType','方向图无效');
    if(row.azimuthDeg!==null&&(!finite(row.azimuthDeg)||row.azimuthDeg<0||row.azimuthDeg>=360)||row.patternType==='DIRECTIONAL'&&row.azimuthDeg===null)issue(row.id,'azimuthDeg','定向需填写 0–小于 360 度方位角');
    if(typeof row.active!=='boolean')issue(row.id,'active','生效标记必须为布尔值');
  }
  if(previous.interferences?.some(row=>!interferenceIds.has(row.id)))issue('interferences','id','不允许移除已保存干扰源');
  const candidates=validateCandidateLinks(candidate.candidateLinks,candidate,previous.candidateLinks);
  issues.push(...candidates.issues);
  // 既有三类资源的无关操作不刷出整本候选参考提示，详情可随时单独查看。
  if(!sameCandidateSnapshot){
    const previousCandidates=new Map((previous.candidateLinks??[]).map(row=>[row.id,row]));
    const changedCandidates=new Set((candidate.candidateLinks??[]).filter(row=>!sameCandidateValue(row,previousCandidates.get(row.id))).map(row=>row.id));
    warnings.push(...candidates.warnings.filter(warning=>changedCandidates.has(warning.objectId)));
  }
  return { issues, warnings };
}

export function assertValid(
  candidate: ResourcesData,
  previous: ResourcesData,
  source: ResourcesData,
) {
  const result = validateResources(candidate, previous, source);
  if (result.issues.length)
    throw new ApiError('资源校验失败，请检查对象与字段', 'VALIDATION_ERROR', {
      issues: result.issues,
    });
  return result.warnings;
}

export function applyChanges(base: ResourcesData, changes: ResourceChanges, allowAvailability=false): ResourcesData {
  // 草稿保留传入字段及缺失含义，不引入演示资料。
  const candidate = structuredClone(base);
  if(!changes||typeof changes!=='object')throw new ApiError('变更格式无效','VALIDATION_ERROR');
  // 草稿只应用字段与服务已给出的导入行；这里不切换评估状态。
  const seenCandidates=new Set<string>();
  for(const key of ['newCandidateLinks','importedCandidateLinks','candidateLinks'] as const){
    const rows=changes[key]??[];
    if(!Array.isArray(rows))throw new ApiError('候选变更集合无效','VALIDATION_ERROR');
    if(rows.length)candidate.candidateLinks??=[];
    for(const row of rows){
      if(!row||!resourceIdValid(row.id)||seenCandidates.has(row.id))throw new ApiError('候选 ID 无效或重复','VALIDATION_ERROR');
      seenCandidates.add(row.id);
      const index=candidate.candidateLinks!.findIndex(item=>item.id===row.id);
      if(key==='candidateLinks'){
        if(index<0||Object.keys(row).some(field=>field!=='id'&&!candidateConfigFields.includes(field as never)))throw new ApiError('候选不存在或包含只读评估字段','VALIDATION_ERROR');
        Object.assign(candidate.candidateLinks![index],row);
      }else{
        const full=row as CandidateLink;
        if(key==='newCandidateLinks'?index>=0||!['MANUAL','IMPORT'].includes(full.source?.kind):index<0||full.source?.kind!=='IMPORT')throw new ApiError('候选新增/导入对象或来源无效','VALIDATION_ERROR');
        if(index<0)candidate.candidateLinks!.push(structuredClone(full));else candidate.candidateLinks![index]=structuredClone(full);
      }
    }
  }
  for(const [field,kind] of [['newStations','stations'],['newDevices','devices'],['newInterferences','interferences']] as const){
    const rows=changes[field]??[];
    if(!Array.isArray(rows))throw new ApiError('新增集合无效','VALIDATION_ERROR');
    const target=candidate[kind] as {id:string}[];
    // 缺失集合不能由样例补出；有新增请求时沿用集合校验错误。
    if(rows.length&&!Array.isArray(target))throw new ApiError('新增集合无效','VALIDATION_ERROR');
    for(const row of rows){
      if(!row||!resourceIdValid(row.id)||target.some(item=>item.id===row.id)||!['MANUAL','IMPORT'].includes(row.origin??''))
        throw new ApiError('新对象 ID 重复或来源无效','VALIDATION_ERROR');
      if(field==='newDevices'&&(row as Device).availability!=='ACTIVE')throw new ApiError('新设备必须初始在架','VALIDATION_ERROR');
      target.push(structuredClone(row));
    }
  }
  const interferencePatches=changes.interferences??[];
  if(!Array.isArray(interferencePatches)||new Set(interferencePatches.map(r=>r?.id)).size!==interferencePatches.length)throw new ApiError('干扰源变更格式无效或 ID 重复','VALIDATION_ERROR');
  for(const row of interferencePatches){
    const target=candidate.interferences?.find(item=>item.id===row?.id);
    if(!target||Object.keys(row).some(key=>key!=='id'&&!interferenceFields.includes(key as never)))
      throw new ApiError('干扰源不存在或包含只读字段','VALIDATION_ERROR');
    Object.assign(target,row);
  }
  if(changes.availability?.length&&!allowAvailability)throw new ApiError('上下架必须使用专门操作','VALIDATION_ERROR');
  for(const row of changes.availability??[]){
    const target=candidate.devices.find(d=>d.id===row.id);
    if(!target||!['ACTIVE','OFF_SHELF'].includes(row.availability))throw new ApiError('设备或在架状态无效','VALIDATION_ERROR');
    target.availability=row.availability;
  }
  for (const kind of ['stations', 'devices'] as const) {
    const fields: readonly string[] = kind === 'stations' ? stationFields : deviceFields;
    const seen = new Set<string>();
    if (!Array.isArray(changes[kind])) throw new ApiError('变更集合格式无效', 'VALIDATION_ERROR');
    for (const patch of changes[kind]) {
      const row = patch && candidate[kind].find((row) => row.id === patch.id);
      const invalid =
        !row ||
        seen.has(patch.id) ||
        Object.keys(patch).some((key) => key !== 'id' && !fields.includes(key));
      if (invalid)
        throw new ApiError('变更包含未知对象、重复对象或只读字段', 'VALIDATION_ERROR', {
          issues: [
            { objectId: patch?.id ?? kind, field: 'id', message: '仅允许修改已有对象的开放字段' },
          ],
        });
      seen.add(patch.id);
      Object.assign(row, patch);
      if (kind === 'stations') {
        const station = row as ResourcesData['stations'][number];
        if (typeof station.name === 'string') station.name = station.name.trim();
      }
    }
  }
  for(const row of [...candidate.stations,...(candidate.interferences??[])]){
    if(typeof row.name==='string')row.name=row.name.trim();
    const old = ('echelon' in row ? base.stations : base.interferences ?? []).find(item => item.id === row.id);
    if (!same(row.coordinate, old?.coordinate) && coordinateInBounds(row.coordinate, base.planningBounds)) {
      const rounded = row.coordinate.map(value => Number(value.toFixed(6))) as [number, number];
      if (coordinateInBounds(rounded, base.planningBounds)) row.coordinate = rounded;
    }
  }
  return candidate;
}

export function diffResources(base: ResourcesData, candidate: ResourcesData): ResourceChanges {
  const newCandidateLinks:CandidateLink[]=[],candidateLinks:CandidateLinkPatch[]=[],importedCandidateLinks:CandidateLink[]=[];
  const candidateIndex=new Map((base.candidateLinks??[]).map(row=>[row.id,row]));
  for(const row of candidate.candidateLinks??[]){
    const old=candidateIndex.get(row.id);
    if(!old){newCandidateLinks.push(row);continue;}if(sameCandidateValue(old,row))continue;
    // 导入响应的元数据和结果随行传递，避免统一保存误清空新的外部参考。
    const metadata=(item:CandidateLink)=>Object.fromEntries(Object.entries(item).filter(([key])=>key!=='id'&&!candidateConfigFields.includes(key as never)));
    if(!sameCandidateValue(metadata(old),metadata(row)))importedCandidateLinks.push(row);
    else candidateLinks.push({id:row.id,...Object.fromEntries(candidateConfigFields.map(key=>[key,row[key]]))});
  }
  const addedStations=candidate.stations.filter(row=>!base.stations.some(item=>item.id===row.id));
  const addedDevices=candidate.devices.filter(row=>!base.devices.some(item=>item.id===row.id));
  const addedInterferences=(candidate.interferences??[]).filter(row=>!base.interferences?.some(item=>item.id===row.id));
  const interferenceChanges=(candidate.interferences??[]).flatMap(row=>{
    const previous=base.interferences?.find(item=>item.id===row.id);
    if(!previous||same(previous,row))return [];
    const {origin:_origin,...fields}=row;return [fields];
  });
  const availability=candidate.devices.flatMap(row=>{
    const old=base.devices.find(item=>item.id===row.id);
    return old&&(old.availability??'ACTIVE')!==(row.availability??'ACTIVE')?[{id:row.id,availability:row.availability!}]:[];
  });
  return {
    ...(newCandidateLinks.length?{newCandidateLinks}:{}),
    ...(candidateLinks.length?{candidateLinks}:{}),
    ...(importedCandidateLinks.length?{importedCandidateLinks}:{}),
    ...(addedStations.length?{newStations:addedStations}:{}),
    ...(addedDevices.length?{newDevices:addedDevices}:{}),
    ...(addedInterferences.length?{newInterferences:addedInterferences}:{}),
    ...(interferenceChanges.length?{interferences:interferenceChanges}:{}),
    ...(availability.length?{availability}:{}),
    stations: candidate.stations.flatMap((row) => {
      const original = base.stations.find((s) => s.id === row.id);
      return !original || same(original, row)
        ? []
        : [
            {
              id: row.id,
              name: row.name,
              coordinate: [...row.coordinate] as [number, number],
              elevationM: row.elevationM,
              region: row.region,
              remark: row.remark,
            },
          ];
    }),
    devices: candidate.devices.flatMap((row) => {
      const original = base.devices.find((d) => d.id === row.id);
      // 老记录缺新字段时保持未知，不把兼容读取算成业务修改。
      const comparable = original && { ...original, ...(row.ports === undefined ? { ports: undefined } : {}), ...(row.currentWorkMode === undefined ? { currentWorkMode: undefined } : {}) };
      return !original || same(comparable, row)
        ? []
        : [
            {
              id: row.id,
              antennaHeightM: row.antennaHeightM,
              txPowerDbm: row.txPowerDbm,
              workFreqKhz: row.workFreqKhz,
              ...(!same(row.currentWorkMode, original.currentWorkMode) ? { currentWorkMode: row.currentWorkMode } : {}),
              // 草稿可能是 Vue 代理；端口只含标量，逐项复制后再交给服务。
              ...(row.ports !== undefined ? { ports: row.ports?.map(port=>({...port})) ?? null } : {}),
            },
          ];
    }),
  };
}

export function createForm(resources: ResourcesData, kind: EditForm['kind'], id: string): EditForm {
  const row = (resources[kind === 'station' ? 'stations' : kind==='device'?'devices':kind==='candidate'?'candidateLinks':'interferences']??[]).find((item) => item.id === id);
  if (!row) throw new ApiError('要编辑的对象不存在', 'NOT_FOUND');
  const fields: Record<string, string> = {};
  for (const key of kind === 'station' ? stationFields : kind==='device'?deviceFields:kind==='candidate'?candidateConfigFields:interferenceFields) {
    const value = (row as unknown as Record<string, unknown>)[key];
    if (key === 'coordinate') {
      fields.longitude = String((value as number[])[0]);
      fields.latitude = String((value as number[])[1]);
    } else if (key === 'ports') fields[key] = value == null ? '' : JSON.stringify(value);
    else fields[key] = value == null ? '' : String(value);
  }
  return { kind, id, fields, initial: { ...fields } };
}

export function formChanges(form: EditForm): ResourceChanges {
  const f = form.fields;
  // 空必填数值用 NaN 进入统一校验，不能被 Number('') 转换为 0。
  const number = (key: string, nullable = false) =>
    f[key].trim() === '' ? (nullable ? null : NaN) : Number(f[key]);
  if(form.kind==='candidate'){
    if(Object.keys(f).some(key=>!candidateConfigFields.includes(key as never))||!['','true','false'].includes(f.isBackup))throw new ApiError('候选表单包含只读字段或无效备用标识','VALIDATION_ERROR');
    const row={id:form.id,nodeAId:f.nodeAId,nodeBId:f.nodeBId,deviceAId:f.deviceAId,deviceBId:f.deviceBId,deviceClass:f.deviceClass as 'HF'|'VUHF',freqKhz:number('freqKhz',true),bandwidthKhz:number('bandwidthKhz',true),isBackup:f.isBackup===''?null:f.isBackup==='true'};
    return form.creating?{stations:[],devices:[],newCandidateLinks:[{...row,...emptyCandidateAssessment(),assessmentState:'PENDING',source:{kind:'MANUAL',file:null,row:null},reference:null}]}:{stations:[],devices:[],candidateLinks:[row]};
  }
  if(form.creating) {
    if(form.kind==='station'){
      const definition=stationTypes[f.subtype];
      if(!definition||!['I_FIXED','II_FIXED'].includes(f.subtype))throw new ApiError('请选择固定站类型','VALIDATION_ERROR');
      const station:Station={id:form.id,name:f.name,coordinate:[number('longitude')!,number('latitude')!],elevationM:number('elevationM',true),region:f.region,
        ...structuredClone(definition),subtype:f.subtype,role:'FIXED_STATION',parentIds:f.parentIds.split(';').map(v=>v.trim()).filter(Boolean),
        key:f.key==='true',relayCapable:f.relayCapable==='true',status:null,alert:null,remark:f.remark,origin:'MANUAL'};
      return {stations:[],devices:[],newStations:[station]};
    }
    if(form.kind==='device'){
      const device:Device={id:form.id,stationId:f.stationId,modelId:f.modelId,antennaId:f.antennaId,antennaHeightM:number('antennaHeightM'),txPowerDbm:number('txPowerDbm'),
        workFreqKhz:number('workFreqKhz',true),tiltDeg:number('tiltDeg',true),azimuthDeg:number('azimuthDeg',true),installedAt:f.installedAt,
        status:null,alert:null,origin:'MANUAL',availability:'ACTIVE',...(f.currentWorkMode?{currentWorkMode:f.currentWorkMode}:{})};
      return {stations:[],devices:[],newDevices:[device]};
    }
  }
  if(form.kind==='interference'){
    const row={id:form.id,name:f.name,coordinate:[number('longitude')!,number('latitude')!] as [number,number],elevationM:number('elevationM',true),
      antennaHeightM:number('antennaHeightM')!,centerFreqKhz:number('centerFreqKhz')!,bandwidthKhz:number('bandwidthKhz')!,txPowerDbm:number('txPowerDbm')!,
      antennaGainDbi:number('antennaGainDbi',true),interferenceType:f.interferenceType,patternType:f.patternType||null,azimuthDeg:number('azimuthDeg',true),
      dutyCycle:number('dutyCycle',true),active:f.active==='true'};
    return form.creating?{stations:[],devices:[],newInterferences:[{...row,origin:'MANUAL'}]}:{stations:[],devices:[],interferences:[row]};
  }
  return form.kind === 'station'
    ? {
        stations: [
          {
            id: form.id,
            name: f.name,
            region: f.region,
            remark: f.remark??'',
            coordinate: [number('longitude')!, number('latitude')!],
            elevationM: number('elevationM', true),
          },
        ],
        devices: [],
      }
    : {
        stations: [],
        devices: [
          {
            id: form.id,
            antennaHeightM: number('antennaHeightM'),
            txPowerDbm: number('txPowerDbm'),
            workFreqKhz: number('workFreqKhz', true),
            ...(f.currentWorkMode || form.initial.currentWorkMode ? { currentWorkMode: f.currentWorkMode || null } : {}),
            ...(f.ports ? { ports: JSON.parse(f.ports) } : {}),
          },
        ],
      };
}

export function createNewForm(kind:EditForm['kind'],resources:ResourcesData,stationId=''):EditForm {
  const fields:Record<string,string>=kind==='station'
    ? {name:'',longitude:'',latitude:'',elevationM:'',region:'',remark:'',subtype:'I_FIXED',parentIds:'',key:'false',relayCapable:'true'}
    :kind==='device'?{stationId,modelId:'',antennaId:'',antennaHeightM:'',txPowerDbm:'',workFreqKhz:'',currentWorkMode:'',tiltDeg:'',azimuthDeg:'',installedAt:''}
    :kind==='candidate'?{nodeAId:stationId,nodeBId:'',deviceAId:'',deviceBId:'',deviceClass:'HF',freqKhz:'',bandwidthKhz:'',isBackup:''}
    :{name:'',longitude:'',latitude:'',elevationM:'',antennaHeightM:'',centerFreqKhz:'',bandwidthKhz:'',txPowerDbm:'',antennaGainDbi:'',interferenceType:'NOISE',patternType:'OMNI',azimuthDeg:'',dutyCycle:'',active:'true'};
  // ID 在表单创建时冻结，失败重试和撤销重做不会生成另一个对象。
  return {kind,id:randomUuid(),creating:true,fields,initial:{...fields}};
}

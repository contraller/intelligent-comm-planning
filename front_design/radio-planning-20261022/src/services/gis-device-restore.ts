import type { RestoreProposal } from '../types/device-trace';

const fields={tx_power_dbm:'txPowerDbm',work_freq_khz:'workFreqKhz',antenna_height_m:'antennaHeightM'} as const;
type Field=keyof typeof fields;
export interface GisRestoreContext {
  deviceId:string; modelId:string; revision:string;
  values:Record<Field,number|null>;
}
export interface GisRestoreAccess {
  context:()=>GisRestoreContext|null;
  current:()=>boolean;
  open:()=>Promise<boolean>;
  form:()=>{kind:string;id:string;fields:Record<string,string>}|null;
}
// 历史候选只载入现有表单；资源保存、回执和前态校验仍由原工作区负责。
export async function loadGisRestoreCandidate(value:RestoreProposal,access:GisRestoreAccess):Promise<boolean> {
  const target=access.context();
  if(!access.current()||!target||!value.compatible||value.device_id!==target.deviceId
    ||value.model_id!==target.modelId||value.base_revision!==target.revision) return false;
  const patch=value.patch,keys=Object.keys(patch) as Field[];
  if(!keys.length||keys.some(key=>!Object.hasOwn(fields,key))||value.changes.length!==keys.length) return false;
  const seen=new Set<string>();
  for(const change of value.changes) {
    if(!Object.hasOwn(fields,change.field)||seen.has(change.field)||!Object.hasOwn(patch,change.field)
      ||change.known!==true||!Number.isFinite(change.after)||patch[change.field]!==change.after
      ||target.values[change.field]!==change.before) return false;
    seen.add(change.field);
  }
  const anchor=JSON.stringify(target);
  if(!await access.open()||!access.current()||JSON.stringify(access.context())!==anchor) return false;
  const form=access.form();
  if(!form||form.kind!=='device'||form.id!==target.deviceId) return false;
  for(const key of keys) form.fields[fields[key]]=String(patch[key]);
  return true;
}

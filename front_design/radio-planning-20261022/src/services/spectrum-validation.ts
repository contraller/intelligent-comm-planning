import type { SpectrumSource, SpectrumWorkspace } from '../types/spectrum';
import { SPECTRUM_SCHEMA_VERSION } from '../config/demo';
import { resourceIdValid } from './resource-validation';
import { ApiError } from './types';

// 只检查配置结构，不访问 URL 或判断真实连通性。
export function spectrumIssues(source:SpectrumSource,allowIncomplete=false):string[]{
  const issues:string[]=[];
  if(!source||!resourceIdValid(source.id))return ['配置 ID 无效'];
  if(typeof source.name!=='string'||source.name!==source.name.trim()||!source.name||source.name.length>60)issues.push('名称需为 1–60 字符');
  if(!['HTTP_JSON','WEBSOCKET_JSON'].includes(source.protocol))issues.push('协议无效');
  try{
    if(typeof source.endpoint!=='string'||source.endpoint.length>500||!source.endpoint||/[\s\\]/.test(source.endpoint))throw Error();
    const relative=source.endpoint.startsWith('/')&&!source.endpoint.startsWith('//');
    const url=new URL(source.endpoint,relative?'https://spectrum.invalid':undefined);
    if(url.username||url.password||url.hash||!(source.protocol==='HTTP_JSON'?['http:','https:']:['ws:','wss:']).includes(url.protocol)||relative&&source.protocol!=='HTTP_JSON')throw Error();
  }catch{issues.push('地址须匹配协议，不含账号、密码、空白或片段');}
  if(!Number.isInteger(source.intervalSeconds)||source.intervalSeconds<1||source.intervalSeconds>3600)issues.push('采集周期须为 1–3600 整数秒');
  if(!(allowIncomplete&&source.revision==='initial'&&['SP-01','SP-02'].includes(source.id)&&source.minKhz===null&&source.maxKhz===null)&&
    (typeof source.minKhz!=='number'||!Number.isFinite(source.minKhz)||source.minKhz<=0||typeof source.maxKhz!=='number'||!Number.isFinite(source.maxKhz)||source.maxKhz<=source.minKhz))issues.push('请填写频段：0 < 下限 < 上限，单位 kHz');
  if(typeof source.enabled!=='boolean'||typeof source.revision!=='string'||!source.revision)issues.push('状态或配置版本无效');
  return issues;
}
export function assertSpectrum(w:SpectrumWorkspace){
  const bad=()=>{throw new ApiError('频谱配置损坏或版本不兼容，原记录已保留','SPECTRUM_CORRUPT');};
  if(!w||w.schemaVersion!==SPECTRUM_SCHEMA_VERSION||typeof w.revision!=='string'||!w.revision||!Array.isArray(w.sources)||!Array.isArray(w.checks)||!Array.isArray(w.receipts))bad();
  if(new Set(w.sources.map(s=>s.id)).size!==w.sources.length||w.sources.some(s=>spectrumIssues(s,true).length)||!['SP-01','SP-02'].every(id=>w.sources.some(s=>s.id===id)))bad();
  if(new Set(w.checks.map(c=>c.id)).size!==w.checks.length||w.checks.some(c=>!resourceIdValid(c.id)||!w.sources.some(s=>s.id===c.sourceId)||!c.configRevision||!Number.isFinite(Date.parse(c.checkedAt))||
    !['success','connection-failed','format-invalid'].includes(c.demo)||c.connection!==(c.demo==='connection-failed'?'FAILED':'SUCCESS')||c.validation!==(c.demo==='connection-failed'?'NOT_RUN':c.demo==='success'?'SUCCESS':'FAILED')||typeof c.message!=='string'))bad();
  if(new Set(w.receipts.map(r=>r.requestId)).size!==w.receipts.length||w.receipts.some(r=>!resourceIdValid(r.requestId)||!r.signature||!r.objectId||typeof r.changed!=='boolean'))bad();
}

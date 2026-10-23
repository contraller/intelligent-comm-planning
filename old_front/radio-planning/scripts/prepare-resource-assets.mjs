import { readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import Papa from 'papaparse';

// 只生成新的补充文件；已有文件禁止覆盖，保留原始资料与历史快照。
const root = new URL('../', import.meta.url);
const files = {
  nodes: 'docs/数据接口样例/04_联调数据/synthetic/nodes/nodes_v1.csv',
  devices: 'docs/数据接口样例/04_联调数据/synthetic/nodes/devices_v1.csv',
  interferences: 'docs/数据接口样例/04_联调数据/synthetic/interference/interference_sources_v1.csv',
};
const hashes = {}, data = {};
for (const [kind,path] of Object.entries(files)) {
  const bytes = await readFile(new URL(path,root));
  if(bytes[0]===239&&bytes[1]===187&&bytes[2]===191)throw new Error('来源含 BOM，请核对编码');
  const parsed = Papa.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes),{header:true,skipEmptyLines:true});
  if(parsed.errors.length)throw new Error(path+' CSV 解析失败');
  const key=kind==='nodes'?'node_id':kind==='devices'?'device_id':'interference_id';
  if(new Set(parsed.data.map(row=>row[key])).size!==parsed.data.length||parsed.data.some(row=>!row[key]))throw new Error(path+' ID 无效');
  data[kind]=parsed.data;hashes[path]=createHash('sha256').update(bytes).digest('hex');
}
const resources=JSON.parse(await readFile(new URL('src/mocks/resources.json',root),'utf8'));
for(const [kind,key,rows] of [['nodes','node_id',resources.stations],['devices','device_id',resources.devices]]) {
  if(data[kind].length!==rows.length||rows.some(row=>!data[kind].some(item=>item[key]===row.id)))throw new Error(kind+' 与页面基线 ID 不一致');
}
const nullable=v=>v===''?null:Number(v);
const result={
  hashes,
  stations:data.nodes.map(r=>({id:r.node_id,subtype:r.node_subtype,role:r.node_role,remark:r.remark})),
  devices:data.devices.map(r=>({id:r.device_id,tiltDeg:nullable(r.tilt_deg),azimuthDeg:nullable(r.azimuth_deg)})),
  interferences:data.interferences.map(r=>({id:r.interference_id,name:r.name,coordinate:[Number(r.lon),Number(r.lat)],elevationM:nullable(r.elevation_m),antennaHeightM:Number(r.antenna_height_m),centerFreqKhz:Number(r.center_freq_khz),bandwidthKhz:Number(r.bandwidth_khz),txPowerDbm:Number(r.tx_power_dbm),antennaGainDbi:nullable(r.antenna_gain_dbi),interferenceType:r.interference_type,patternType:r.pattern_type||null,azimuthDeg:nullable(r.azimuth_deg),dutyCycle:nullable(r.duty_cycle),active:r.active==='true',origin:'SOURCE'})),
};
const target=new URL('src/mocks/resource-supplement.json',root);
try { await access(target);throw new Error('补充文件已存在，禁止覆盖；需要修改时使用最小补丁'); }
catch(e) { if(e.code!=='ENOENT')throw e; }
await writeFile(target,JSON.stringify(result,null,2)+'\n',{encoding:'utf8',flag:'wx'});
console.log('来源补充生成：'+result.stations.length+' 节点，'+result.devices.length+' 设备，'+result.interferences.length+' 干扰源');

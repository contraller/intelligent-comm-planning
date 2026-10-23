import { describe,expect,it,vi } from 'vitest';
import { loadGisRestoreCandidate,type GisRestoreContext } from '../src/services/gis-device-restore';
import type { RestoreProposal } from '../src/types/device-trace';
function fixture() {
  let target:GisRestoreContext|null={deviceId:'D1',modelId:'M1',revision:'resource-current',values:{tx_power_dbm:30,work_freq_khz:null,antenna_height_m:8}};
  let alive=true;
  const form={kind:'device',id:'D1',fields:{txPowerDbm:'30',workFreqKhz:'',antennaHeightM:'8',currentWorkMode:'AM'}};
  const proposal:RestoreProposal={schema_version:'device-trace-a1',device_id:'D1',model_id:'M1',base_revision:'resource-current',source_revision:'resource-history',source_request_id:'real-operation',compatible:true,
    patch:{tx_power_dbm:32,work_freq_khz:7000},changes:[{field:'tx_power_dbm',before:30,after:32,known:true},{field:'work_freq_khz',before:null,after:7000,known:true}],blocked_fields:[],warnings:[]};
  const access={context:()=>target,current:()=>alive,form:()=>form,open:vi.fn(async()=>true)};
  return {form,proposal,access,replace:(value:GisRestoreContext|null)=>{target=value;},leave:()=>{alive=false;}};
}
describe('GIS三参数追溯候选',()=>{
  it('载入后端明确候选但不保存、不改端口和模式',async()=>{
    const f=fixture();expect(await loadGisRestoreCandidate(f.proposal,f.access)).toBe(true);
    expect(f.access.open).toHaveBeenCalledOnce();expect(f.form.fields).toEqual({txPowerDbm:'32',workFreqKhz:'7000',antennaHeightM:'8',currentWorkMode:'AM'});
  });
  it.each(['device_id','model_id','base_revision'] as const)('拒绝错%s，不打开表单',async field=>{
    const f=fixture();f.proposal[field]='other';expect(await loadGisRestoreCandidate(f.proposal,f.access)).toBe(false);expect(f.access.open).not.toHaveBeenCalled();
  });
  it.each(['incompatible','empty','unknown','nonfinite','duplicate','before','after','missing'] as const)('拒绝%s候选且保留当前参数',async kind=>{
    const f=fixture(),before=structuredClone(f.form);
    if(kind==='incompatible') f.proposal.compatible=false;
    if(kind==='empty'){f.proposal.patch={};f.proposal.changes=[];}
    if(kind==='unknown') Object.assign(f.proposal.patch,{ports:1});
    if(kind==='nonfinite'){f.proposal.patch.tx_power_dbm=Infinity;f.proposal.changes[0].after=Infinity;}
    if(kind==='duplicate') f.proposal.changes[1]={...f.proposal.changes[0]};
    if(kind==='before') f.proposal.changes[0].before=29;
    if(kind==='after') f.proposal.patch.tx_power_dbm=31;
    if(kind==='missing') delete f.proposal.patch.tx_power_dbm;
    expect(await loadGisRestoreCandidate(f.proposal,f.access)).toBe(false);expect(f.access.open).not.toHaveBeenCalled();expect(f.form).toEqual(before);
  });
  it.each(['revision','device','model','values','permission','gone','form','cancel'] as const)('异步打开时%s变化不污染新表单',async kind=>{
    const f=fixture(),before=structuredClone(f.form);
    f.access.open.mockImplementationOnce(async()=>{
      const target=f.access.context()!;
      if(kind==='revision') f.replace({...target,revision:'new'});
      if(kind==='device') f.replace({...target,deviceId:'D2'});
      if(kind==='model') f.replace({...target,modelId:'M2'});
      if(kind==='values') f.replace({...target,values:{...target.values,tx_power_dbm:31}});
      if(kind==='permission') f.leave();
      if(kind==='gone') f.replace(null);
      if(kind==='form') f.form.id='D2';
      return kind!=='cancel';
    });
    expect(await loadGisRestoreCandidate(f.proposal,f.access)).toBe(false);expect(f.form.fields).toEqual(before.fields);
  });
});

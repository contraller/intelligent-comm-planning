import { describe, expect, it } from 'vitest';
import { initialResources } from '../src/mocks/resource-presets';
import { planningPresets } from '../src/mocks/planning-presets';
import { createForm, createNewForm } from '../src/services/resource-validation';
import { gisIssues, gisResourceTarget, gisTaskTarget } from '../src/services/gis-validation';

// 使用真实资源与任务身份检查定位边界，不用编号前缀猜测对象。
describe('GIS 错误结构与定位目标', () => {
  const issue=(objectId:string,field='name')=>({objectId,field,message:'校验失败'});
  it('资源和任务保持来源，异常明细保留说明，未知载荷不冒充正常条目',()=>{
    expect(gisIssues([issue('TASK')],'task')[0]).toMatchObject({source:'task',objectId:'TASK'});
    expect(gisIssues([null,{},issue('ND-0001')],'resource')).toHaveLength(3);
    expect(gisIssues([null],'task')[0]!.message).toContain('无法识别');
    expect(gisIssues({issues:[]},'task')).toEqual([]);
  });
  it.each(['station','device','interference'] as const)('按现有 %s 身份匹配对象',kind=>{
    const resources=initialResources();
    const id=kind==='station'?resources.stations[0]!.id:kind==='device'?resources.devices[0]!.id:resources.interferences![0]!.id;
    expect(gisResourceTarget(issue(id),resources,null)).toMatchObject({kind,id});
  });
  it('未知或跨类重号不能误跳；明确 sheet 可以消除歧义',()=>{
    const r=initialResources();r.devices[0]!.id=r.stations[0]!.id;
    expect(gisResourceTarget(issue(r.stations[0]!.id),r,null)).toBeNull();
    expect(gisResourceTarget({...issue(r.stations[0]!.id),sheet:'nodes'},r,null)?.kind).toBe('station');
    expect(gisResourceTarget(issue('MISSING'),r,null)).toBeNull();
  });
  it('当前尚未应用的新建表单可定位，空坐标不退到旧对象',()=>{
    const r=initialResources(),form=createNewForm('station',r);
    expect(gisResourceTarget(issue(form.id,'coordinate'),r,form)).toMatchObject({id:form.id,field:'longitude'});
    expect(gisResourceTarget(issue(form.id),r,form)?.coordinate).toBeUndefined();
  });
  it.each(['','NaN','Infinity','200'])('未应用非法坐标 %s 不使用原站点位置',value=>{
    const r=initialResources(),form=createForm(r,'station',r.stations[0]!.id);form.fields.longitude=value;
    expect(gisResourceTarget(issue(form.id,'coordinate'),r,form)?.coordinate).toBeUndefined();
  });
  it('有效未应用坐标仅作为定位点，不写入资源',()=>{
    const r=initialResources(),before=structuredClone(r),form=createForm(r,'station',r.stations[0]!.id);
    form.fields.longitude='114.65';form.fields.latitude='37.5';
    expect(gisResourceTarget(issue(form.id),r,form)?.coordinate).toEqual([114.65,37.5]);expect(r).toEqual(before);
  });
  it('任务、需求、节点问题分别定位表单分组，不当作规划链路',()=>{
    const input=structuredClone(planningPresets[0]!.input),d=input.demands[0]!;
    expect(gisTaskTarget(issue('TASK','bbox'),input)).toEqual({kind:'task',field:'bbox'});
    expect(gisTaskTarget(issue(d.id,'endpoints'),input)).toEqual({kind:'demand',id:d.id,field:'sourceId'});
    expect(gisTaskTarget(issue(input.stationIds[0]!,'stationIds'),input)).toEqual({kind:'task',field:'stationIds'});
    expect(gisTaskTarget(issue('DEMAND','id'),input)).toEqual({kind:'task',field:'demands'});
    expect(gisTaskTarget(issue('MISSING'),input)).toBeNull();
    input.demands.push(structuredClone(d));expect(gisTaskTarget(issue(d.id),input)).toBeNull();
  });
  it('候选按独立类型定位端点字段，缺引用不退回旧端点',()=>{
    const r=initialResources(),link=r.candidateLinks![0]!,form=createForm(r,'candidate',link.id);
    const target=gisResourceTarget({...issue(link.id,'deviceBId'),sheet:'topology_links'},r,form);
    expect(target).toMatchObject({kind:'candidate',id:link.id,field:'deviceBId',coordinate:r.stations.find(row=>row.id===link.nodeBId)!.coordinate});
    form.fields.nodeBId='MISSING';
    expect(gisResourceTarget({...issue(link.id,'deviceBId'),sheet:'topology_links'},r,form)?.coordinate).toBeUndefined();
    link.id=r.stations[0]!.id;
    expect(gisResourceTarget(issue(link.id),r,null)).toBeNull();
    expect(gisResourceTarget({...issue(link.id,'unknown'),sheet:'topology_links'},r,null)).toMatchObject({kind:'candidate',field:'unknown'});
  });
  it('新候选没有端点时只打开表单，不臆造坐标',()=>{
    const r=initialResources(),form=createNewForm('candidate',r);
    const target=gisResourceTarget({...issue(form.id,'nodeAId'),sheet:'topology_links'},r,form);
    expect(target).toMatchObject({kind:'candidate',id:form.id});expect(target?.coordinate).toBeUndefined();
  });
});

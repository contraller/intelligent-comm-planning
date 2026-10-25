import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, defineComponent, ref, nextTick } from 'vue';
import { disposePinia } from 'pinia';
import { Style } from 'ol/style';
import { COVERAGE_VECTOR_ZOOM, coverageLayers, coverageVisibility } from '../src/maps/coverage-layers';
import { planningApiLayer } from '../src/maps/planning-api-layers';
import { readCoverage } from '../src/services/coverage-validation';
import { createCoverageHttp, coverageFilePath } from '../src/services/coverage-http';
import { usePlanningCoverage } from '../src/composables/usePlanningCoverage';
import { previewService } from '../src/services';
import { coverageDto, apiJob, httpFixture, storeFixture } from './fixtures/planning-api';
const png = () => new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=','base64')],{type:'image/png'});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('覆盖几何与图片',()=>{
  it('多面、内环及等级保留，显示投影转换不改外部坐标',()=>{
    const dto=coverageDto(),coverage=readCoverage(dto),before=JSON.stringify(coverage),layers=coverageLayers(coverage,'',9);
    const feature=layers.vector.getSource()!.getFeatures()[0],geometry=feature.getGeometry()!;
    expect(geometry.getType()).toBe('MultiPolygon');expect((geometry as import('ol/geom/MultiPolygon').default).getPolygons()).toHaveLength(2);expect((geometry as import('ol/geom/MultiPolygon').default).getPolygons()[0].getLinearRings()).toHaveLength(2);expect(feature.get('level')).toBe('STRONG');expect(JSON.stringify(coverage)).toBe(before);
  });
  it.each([['STRONG','#2e7d3266'],['MEDIUM','#9ccc6555'],['WEAK','#fdd83544']])('%s 无匹配色表时使用规范色及原 alpha，明确等级不依赖数值', (level,color)=>{
    for(const value of [40,null]) {
      const coverage=readCoverage(coverageDto());
      coverage.contour!.features[0].properties={level,field_strength_dbuvm_min:value};
      // 无图片或色表阈值无法匹配时，仅采用响应已经声明的等级。
      for(const raster of [null,{...coverage.rasterPng!,colormap:[{value_dbuvm:100,rgba:[1,2,3,255] as [number,number,number,number]}]}]) {
        coverage.rasterPng=raster;const before=JSON.stringify(coverage),layers=coverageLayers(coverage,'',9,0.4);
        const feature=layers.vector.getSource()!.getFeatures()[0],style=layers.vector.getStyleFunction()!(feature,1) as Style;
        expect(style.getFill()!.getColor()).toBe(color);expect(style.getStroke()!.getColor()).toBe('#8cb8cd');expect(style.getStroke()!.getWidth()).toBe(1);
        expect(layers.vector.getOpacity()).toBe(0.4);expect(JSON.stringify(coverage)).toBe(before);
      }
    }
  });
  it('HTTP 显式色表优先于三级回退，按服务数值匹配而不是按数组位置分级',()=>{
    const coverage=readCoverage(coverageDto());
    coverage.rasterPng!.colormap=[{value_dbuvm:0,rgba:[0,0,0,0]},{value_dbuvm:13,rgba:[11,22,33,127]},{value_dbuvm:47,rgba:[44,55,66,255]}];
    const feature=coverage.contour!.features[0];feature.properties={level:'STRONG',field_strength_dbuvm_min:40};
    const before=JSON.stringify(coverage),layers=coverageLayers(coverage,'',9);
    const rendered=layers.vector.getSource()!.getFeatures()[0],style=layers.vector.getStyleFunction()!(rendered,1) as Style;
    expect(style.getFill()!.getColor()).toBe(`rgba(11,22,33,${127/255})`);expect(JSON.stringify(coverage)).toBe(before);
  });
  it.each([['coverage','#55bb9955'],['UNKNOWN','#70a6ce55'],['blind','#a75e8055'],['uncalculated','#79839644']])('%s 独立区域或未分级范围不认作强中弱', (level,color)=>{
    const coverage=readCoverage(coverageDto());coverage.contour!.features[0].properties={level,field_strength_dbuvm_min:null};
    const layers=coverageLayers(coverage,'',9),feature=layers.vector.getSource()!.getFeatures()[0];
    expect((layers.vector.getStyleFunction()!(feature,1) as Style).getFill()!.getColor()).toBe(color);
    expect(feature.get('level')).toBe(level);expect(feature.get('field_strength_dbuvm_min')).toBeNull();
  });
  it('自动全域场强、放大叠边界，手工选择不被缩放覆盖',()=>{
    const coverage=readCoverage(coverageDto());
    expect(coverageVisibility(coverage,'blob:test',COVERAGE_VECTOR_ZOOM-1)).toMatchObject({raster:true,vector:false,outlineOnly:false});
    expect(coverageVisibility(coverage,'blob:test',COVERAGE_VECTOR_ZOOM)).toMatchObject({raster:true,vector:true,outlineOnly:true});
    for(const zoom of [6,17]) {
      expect(coverageVisibility(coverage,'blob:test',zoom,'raster')).toMatchObject({raster:true,vector:false});
      expect(coverageVisibility(coverage,'blob:test',zoom,'contour')).toMatchObject({raster:false,vector:true,outlineOnly:false});
    }
  });
  it('缺失数据与加载失败只回退已有轮廓，不推断不存在的覆盖',()=>{
    const coverage=readCoverage(coverageDto());
    expect(coverageVisibility(coverage,'',9)).toMatchObject({raster:false,vector:true});
    expect(coverageVisibility(coverage,'blob:test',9,'auto','loading')).toMatchObject({raster:true,vector:true,outlineOnly:false});
    expect(coverageVisibility(coverage,'blob:test',9,'raster','error')).toMatchObject({raster:false,vector:true});
    expect(coverageVisibility({...coverage,rasterPng:null},'',9,'raster')).toMatchObject({raster:false,vector:true});
    expect(coverageVisibility({...coverage,contour:null},'blob:test',14)).toMatchObject({raster:true,vector:false});
    expect(coverageVisibility({...coverage,contour:null},'blob:test',14,'contour')).toMatchObject({raster:false,vector:false});
    expect(coverageVisibility({contour:null,rasterPng:null},'',14)).toMatchObject({raster:false,vector:false});
    expect(coverageVisibility(coverage,'blob:test',14,'auto','ready',false)).toMatchObject({raster:false,vector:false});
  });
  it('叠加仅描边、轮廓模式恢复填充，模式和缩放不重建源或修改多面孔洞',()=>{
    const coverage=readCoverage(coverageDto()),before=JSON.stringify(coverage),layers=coverageLayers(coverage,'blob:test',14);
    const source=layers.raster!.getSource(),vectorSource=layers.vector.getSource(),feature=vectorSource!.getFeatures()[0];
    const style=()=>layers.vector.getStyleFunction()!(feature,1) as Style;
    expect(style().getFill()).toBeNull();expect(style().getStroke()).not.toBeNull();
    layers.setDisplay('contour',6);expect(style().getFill()).not.toBeNull();expect(layers.raster!.getVisible()).toBe(false);
    layers.setDisplay('auto',14,'loading');expect(style().getFill()).not.toBeNull();expect(layers.raster!.getVisible()).toBe(true);
    layers.setDisplay('auto',14,'ready',true,0.4);expect(style().getFill()).toBeNull();
    layers.setDisplay('raster',17);expect(layers.vector.getVisible()).toBe(false);
    expect(layers.raster!.getSource()).toBe(source);expect(layers.vector.getSource()).toBe(vectorSource);expect(JSON.stringify(coverage)).toBe(before);
  });
  it('PNG 模式保留明确盲区和未计算区域，不显示普通覆盖填充',()=>{
    const coverage=readCoverage(coverageDto()),feature=coverage.contour!.features[0];
    // 区域身份由响应显式提供，测试不根据图片透明度补造区域。
    coverage.contour!.features.push(...['blind','uncalculated'].map(level=>({...structuredClone(feature),id:level,properties:{level,field_strength_dbuvm_min:null}})));
    const layers=coverageLayers(coverage,'blob:test',9),features=layers.vector.getSource()!.getFeatures();
    const style=(i:number)=>layers.vector.getStyleFunction()!(features[i],1) as Style|undefined;
    expect(layers.vector.getVisible()).toBe(true);expect(style(0)).toBeUndefined();
    expect(style(1)!.getFill()).not.toBeNull();expect(style(2)!.getFill()).not.toBeNull();
    layers.setDisplay('auto',14);expect(style(0)!.getFill()).toBeNull();expect(style(1)!.getFill()).not.toBeNull();
    layers.setDisplay('raster',17);expect(style(0)).toBeUndefined();expect(style(2)!.getFill()).not.toBeNull();
    layers.setDisplay('raster',17,'ready',false);expect(layers.vector.getVisible()).toBe(false);
  });
  it('外部图片、目录穿越、非文件路径及非 PNG 被拒绝',()=>{
    for(const url of ['https://outside.example/x.png','/api/v1/files/%2e%2e/auth/a.png','/api/v1/auth/a.png','/api/v1/files/x.jpg','/api/v1/files/a.png?token=x'])expect(()=>coverageFilePath(url,'/api/v1','http://local')).toThrow();
    expect(coverageFilePath('/api/v1/files/a.png','/api/v1','http://local')).toBe('/files/a.png');
  });
  it('图片采用当前会话读取，验证 PNG 标识和服务端声明尺寸',async()=>{
    const f=httpFixture(()=>new Response(png(),{headers:{'Content-Type':'image/png'}})),read=createCoverageHttp(f.request,()=>'/api/v1'),raster=readCoverage(coverageDto()).rasterPng!;
    expect((await read({context:'planning',snapshotId:'S1',raster})).type).toBe('image/png');expect(f.calls.at(-1)!.init.credentials).toBe('same-origin');expect(new Headers(f.calls.at(-1)!.init.headers).get('X-Session-Id')).toBe('session1');
    await expect(read({context:'planning',snapshotId:'S1',raster:{...raster,width:2}})).rejects.toMatchObject({code:'INVALID_COVERAGE_IMAGE'});
    const invalid=httpFixture(()=>new Response('fake PNG',{headers:{'Content-Type':'image/png'}}));await expect(createCoverageHttp(invalid.request,()=>'/api/v1')({context:'planning',snapshotId:'S1',raster})).rejects.toMatchObject({code:'INVALID_COVERAGE_IMAGE'});
  });
  it('无效坐标、未闭合环、无尺寸与错误色带拒绝进入地图',()=>{
    const open=coverageDto();open.contour.features[0].geometry.coordinates[0][0].pop();expect(()=>readCoverage(open)).toThrow('closed ring');
    const bad=coverageDto();bad.raster_png.bbox=[180,0,181,1];expect(()=>readCoverage(bad)).toThrow('longitude');
    const colors=coverageDto();colors.raster_png.colormap[0].rgba[0]=256;expect(()=>readCoverage(colors)).toThrow('rgba');
  });
  it('需求与规划链路身份独立，节点和链路高亮可定位',()=>{
    const job=apiJob(),layer=planningApiLayer({nodes:job.result!.nodes,links:job.result!.links,demands:job.input.demands},'N1','L1');
    const features=layer.getSource()!.getFeatures();expect(features.filter(f=>f.get('kind')==='task-demand').map(f=>f.get('objectId'))).toEqual(['D1']);expect(features.filter(f=>f.get('kind')==='api-planned-link').map(f=>f.get('objectId'))).toEqual(['L1']);expect(features.filter(f=>f.get('kind')==='api-planning-node')).toHaveLength(2);
    // 需求点选消费现有身份，突出显示但不改写输入。
    const before=JSON.stringify(job.input.demands),selected=planningApiLayer({nodes:job.result!.nodes,demands:job.input.demands,selectedDemandId:'D1'});
    const demand=selected.getSource()!.getFeatures().find(f=>f.get('kind')==='task-demand')!;
    const style=demand.getStyle() as Style;
    expect(style.getStroke()!.getWidth()).toBe(5);expect(style.getText()!.getFont()).toContain('bold');
    expect(JSON.stringify(job.input.demands)).toBe(before);
  });
  it('规划文字原生避让不裁掉节点符号或改写需求和链路身份',()=>{
    const job=apiJob(),before=JSON.stringify(job),layer=planningApiLayer({nodes:job.result!.nodes,links:job.result!.links,demands:job.input.demands},'N1','L1');
    expect((layer as unknown as {getDeclutter():string}).getDeclutter()).toBe('planning-api-captions');
    const features=layer.getSource()!.getFeatures();expect(features).toHaveLength(4);
    for(const feature of features){
      const style=feature.getStyle() as Style,kind=feature.get('kind');
      if(kind==='api-planning-node'){
        expect(style.getImage()!.getDeclutterMode()).toBe('none');
        expect(style.getText()!.getDeclutterMode()).toBe('declutter');
        expect(style.getText()!.getText()).toBe(job.result!.nodes.find(node=>node.id===feature.get('objectId'))!.name);
      }else if(kind==='task-demand'){
        expect(style.getText()!.getDeclutterMode()).toBe('declutter');expect(style.getStroke()!.getLineDash()).toEqual([8,6]);
      }else{expect(style.getText()).toBeNull();expect(feature.get('objectId')).toBe('L1');}
    }
    expect(JSON.stringify(job)).toBe(before);layer.dispose();
  });
  it('切换快照取消旧图片，迟到结果不创建 URL，卸载释放当前 URL',async()=>{
    const f=await storeFixture(),snapshot=ref('S1');let resolve!:(blob:Blob)=>void;
    const read=vi.spyOn(previewService,'getPlanningCoverageImage').mockImplementationOnce(()=>new Promise(r=>resolve=r)).mockResolvedValue(png());
    const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:current'),revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
    const renderer=createRenderer<object,object>({insert(){},remove(){},createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null,patchProp(){}});
    let image!:ReturnType<typeof usePlanningCoverage>;
    const app=renderer.createApp(defineComponent({setup(){image=usePlanningCoverage(()=>readCoverage(coverageDto()),()=>snapshot.value,()=> 'planning');return()=>null;}}));app.use(f.pinia);app.mount({});
    snapshot.value='S2';await nextTick();await vi.waitFor(()=>expect(image.url.value).toBe('blob:current'));expect(read.mock.calls[0][0].signal!.aborted).toBe(true);resolve(png());await nextTick();expect(create).toHaveBeenCalledTimes(1);app.unmount();expect(revoke).toHaveBeenCalledWith('blob:current');disposePinia(f.pinia);
  });
});

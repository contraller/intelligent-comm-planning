import {describe,it,expect} from 'vitest';
import {readFrozenCoverageCache,readFrozenBandwidthOptions} from '../src/services/frozen-coverage-decode';
import {frozenCoverageLayer,coverageOutline} from '../src/maps/frozen-coverage-layers';
import {coverageV5Case} from './helpers/frozen-coverage';

describe('V5预测场强契约与地形格面',()=>{
  it('边界消去格面内部共享边并保留中间盲区，不用凸包抹平',()=>{
    const f=coverageV5Case(),sample=f.result.devices[0]!.computations[0]!.geojson.features[0]!;
    const cells=[];
    for(let x=0;x<3;x++)for(let y=0;y<3;y++){
      if(x===1&&y===1)continue;
      cells.push({...sample,geometry:{type:'Polygon' as const,coordinates:[[[x,y],[x+1,y],[x+1,y+1],[x,y+1],[x,y]]] as [number,number][][]}});
    }
    const outline=coverageOutline([...cells,cells[0]!]);
    expect(outline).toHaveLength(16); // 外圈12段、盲区内圈4段，重复频点不抹去边界
    expect(outline.filter(row=>row.geometry.coordinates.every(([x,y])=>x>=1&&x<=2&&y>=1&&y<=2))).toHaveLength(4);
  });
  it('接受带源锚的预算场强和冻结带宽选项',()=>{
    const f=coverageV5Case();
    expect(readFrozenCoverageCache(f.cache,f.query,f.parameters)).toEqual(f.cache);
    expect(readFrozenBandwidthOptions(f.options,f.query)).toEqual(f.options);
  });
  it.each(['field','units','power','grade','geometry','margin','missing'])('拒绝错误或冒名场强：%s',change=>{
    const f=coverageV5Case(),feature=f.result.devices[0]!.computations[0]!.geojson.features[0]!,p=feature.properties;
    if(change==='field')p.field_strength_dbuvm!+=1;
    if(change==='units')delete f.result.provenance.units.field_strength;
    if(change==='power')p.rx_power_dbm!+=1;
    if(change==='grade')p.strength_class='STRONG';
    if(change==='geometry')feature.geometry={type:'Point',coordinates:[114,37]};
    if(change==='margin')p.margin_db!+=1;
    if(change==='missing')delete p.field_strength_dbuvm;
    expect(()=>readFrozenCoverageCache(f.cache,f.query,f.parameters)).toThrow();
  });
  it('强中弱采用三种颜色且实际几何为面，显隐不生成任何新几何',()=>{
    const f=coverageV5Case(),layer=frozenCoverageLayer({anchor:f.anchor,result:f.result,deviceId:'D1'},f.query.snapshotId),features=layer.getSource()!.getFeatures();
    expect(features).toHaveLength(3);
    const style=layer.getStyleFunction()!;
    const colors=features.map(feature=>{const value=style(feature,1);if(!value||typeof value==='function'||Array.isArray(value))throw new Error('缺少样式');return value.getFill()!.getColor();});
    expect(new Set(colors).size).toBe(3);
    expect(features.every(feature=>feature.getGeometry()!.getType()==='Polygon')).toBe(true);
  });
  it('边界模式无填充；热力模式仍保存原场强数值',()=>{
    const f=coverageV5Case();
    for(const display of ['boundary','field'] as const){
      const layer=frozenCoverageLayer({anchor:f.anchor,result:f.result,deviceId:'D1',display},f.query.snapshotId),feature=layer.getSource()!.getFeatures()[0]!;
      const style=layer.getStyleFunction()!(feature,1);if(!style||Array.isArray(style))throw new Error('缺少样式');
      expect(!!style.getFill()).toBe(display==='field');expect(feature.get('field_strength_dbuvm')).toBe(f.result.devices[0]!.computations[0]!.geojson.features[0]!.properties.field_strength_dbuvm);
    }
  });
  it('热力图按绝对预测场强着色，相同余量不同场强不能显示同色',()=>{
    const f=coverageV5Case(),device=f.result.devices[0]!,first=device.computations[0]!;
    first.geojson.features=first.geojson.features.slice(0,1);
    const next=structuredClone(first),frequency=150000,offset=20*Math.log10(frequency/first.freq_khz);
    next.freq_khz=frequency;
    for(const feature of next.geojson.features){feature.properties.freq_khz=frequency;feature.properties.field_strength_dbuvm!+=offset;feature.properties.required_field_dbuvm!+=offset;}
    device.computations.push(next);
    const layer=frozenCoverageLayer({anchor:f.anchor,result:f.result,deviceId:'D1',display:'field'},f.query.snapshotId);
    const features=layer.getSource()!.getFeatures(),colors=features.map(feature=>{
      const style=layer.getStyleFunction()!(feature,1);if(!style||Array.isArray(style))throw new Error('缺少样式');return style.getFill()!.getColor();
    });
    expect(features[0]!.get('margin_db')).toBe(features[1]!.get('margin_db'));expect(colors[0]).not.toBe(colors[1]);
  });
});

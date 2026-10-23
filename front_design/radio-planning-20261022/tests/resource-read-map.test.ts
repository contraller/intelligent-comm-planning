import { describe, expect, it } from 'vitest';
import { resourceReadLayer, resourceViewport } from '../src/maps/resource-read-layers';
import { projectCoordinate } from '../src/maps/layers';
import type { ResourceMapFrame } from '../src/types/resource-read';

describe('资源只读 OpenLayers 图层',()=>{
  const frame:ResourceMapFrame={revision:'r1',bbox:[113,36,115,38],zoom:10,totalNodes:26,totalInterferences:1,
    points:[{kind:'node',id:'N1',name:'节点',coordinate:[114,37],status:'NORMAL',alert:null,active:null},{kind:'interference',id:'I1',name:'干扰',coordinate:[114,37],status:null,alert:null,active:false}],
    clusters:[{kind:'node',id:'C1',coordinate:[114.2,37.1],count:25,bounds:[114,37,114.5,37.5],expansionZoom:12}]};
  it('同坐标对象仍按服务端单点/聚合直接渲染，数量及标识不重算',()=>{
    const layer=resourceReadLayer(frame,'N1','node'),features=layer.getSource()!.getFeatures();
    expect(features).toHaveLength(3);expect(features.filter(f=>f.get('kind')==='resource-read-cluster')).toHaveLength(1);
    const group=features.find(f=>f.get('cluster'))!;expect(group.get('cluster').id).toBe('C1');
    const style=layer.getStyleFunction()!(group,1) as import('ol/style').Style;expect(style.getText()?.getText()).toBe('25');
    const selected=features.find(f=>f.get('object')?.id==='N1')!,selectedStyle=layer.getStyleFunction()!(selected,1) as import('ol/style').Style;
    expect(selectedStyle.getText()?.getText()).toContain('告警未提供');expect(selected.getGeometry()!.getCoordinates()).toEqual(projectCoordinate([114,37]));
  });
  it('空图层可安全显示，地图范围只做投影边界转换',()=>{
    expect(resourceReadLayer(null).getSource()!.getFeatures()).toHaveLength(0);
    expect(resourceViewport([...projectCoordinate([113,36]),...projectCoordinate([115,38])])).toEqual([113,36,115,38]);
    expect(resourceViewport([NaN,0,1,2])).toBeNull();expect(resourceViewport([0,0,0,0])).toBeNull();
  });
});

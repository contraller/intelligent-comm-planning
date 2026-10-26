import type { AuthenticatedRequest } from './auth-http';
import type { GisResourceServices, GisSceneRequest } from '../types/gis-workspace';
import { ApiError } from './types';
import { assertReadOptions } from './resource-read-validation';
import { decodeGisDirectory, decodeGisScene } from './gis-http-validation';

// GIS 只读入口只关联当前资源版本，不请求旧前端文件或回退本地演示快照。
export function createGisHttp(request:AuthenticatedRequest):Pick<GisResourceServices,'loadGisResourceDirectory'|'loadGisResourceScene'>{
  function read(part:string,input:GisSceneRequest){
    assertReadOptions(input,true);
    if(input.context!=='gis')throw new ApiError('GIS 上下文无效','INVALID_RESOURCE_QUERY');
    return request('/resource/gis-'+part+'?'+new URLSearchParams({context:'gis',revision:input.revision}),{signal:input.signal});
  }
  return {
    async loadGisResourceDirectory(input){return decodeGisDirectory(await read('directory',input),input.revision);},
    async loadGisResourceScene(input){return decodeGisScene(await read('scene',input),input.revision);},
  };
}

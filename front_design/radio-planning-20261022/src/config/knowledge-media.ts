import type { KnowledgeEntity, KnowledgeEntitySummary } from '../types/knowledge';

const root=`${import.meta.env.BASE_URL}images/knowledge/`;
const media={
  prc150:{url:root+'radio-prc150.png',name:'AN/PRC-150(C)',label:'AN/PRC-150 电台实拍',aspect:1233/429,author:'US Marine Corps',license:'Public Domain',sourceUrl:'https://commons.wikimedia.org/wiki/File:AN_PRC-150_radio_set.jpg',licenseUrl:'https://creativecommons.org/publicdomain/mark/1.0/',changes:'原照片去背景、裁切'},
  ft891:{url:root+'radio-ft891.png',name:'FT-891',label:'FT-891 电台实拍',aspect:1873/744,author:'Dr vulpes',license:'CC BY-SA 4.0',sourceUrl:'https://commons.wikimedia.org/wiki/File:FT-891.jpg',licenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/',changes:'原照片去背景、裁切'},
  feedline:{url:root+'antenna-feedline.png',name:'天线馈线',label:'同轴馈线及接头实拍（通用部件）',aspect:251/74,author:'Michał Klimek',license:'CC BY-SA 3.0',sourceUrl:'https://commons.wikimedia.org/wiki/File:Kabel_koncentryczny.jpg',licenseUrl:'https://creativecommons.org/licenses/by-sa/3.0/',changes:'原照片右上部分去背景、裁切'},
};
// 编号不代表型号；只接受实体原名或同版本详情中的明确型号，不从类别或关联设备猜测。
export function knowledgeMedia(entity:KnowledgeEntitySummary & Partial<Pick<KnowledgeEntity,'attributes'>>){
  if(entity.type==='DeviceModel'){
    const name=(entity.attributes?.find(attribute=>attribute.name==='model_name')?.value || entity.name).trim().toUpperCase();
    if(['AN/PRC-150(C)','AN/PRC-150'].includes(name))return {...media.prc150,name};
    if(name==='FT-891')return media.ft891;
  }
  if(entity.type==='Component'&&entity.name.trim()==='天线馈线')return media.feedline;
  return null;
}

import type { KnowledgeEntity, KnowledgeEntitySummary } from '../types/knowledge';
export { knowledgeIcon } from './knowledge-icons';

const root = `${import.meta.env.BASE_URL}images/knowledge/`;
const photos = {
  prc150: {
    url: root + 'radio-prc150.png',
    label: 'AN/PRC-150 电台实物参考',
    credit: 'US Marine Corps · Public Domain · 本地裁切图',
  },
  ft891: {
    url: root + 'radio-ft891.png',
    label: 'FT-891 电台实物参考',
    credit: 'Dr vulpes · CC BY-SA 4.0 · 本地裁切图',
  },
  feedline: {
    url: root + 'antenna-feedline.png',
    label: '天线同轴馈线及接头实物参考（通用部件）',
    credit: 'Michał Klimek · CC BY-SA 3.0 · 本地裁切图',
  },
};

// 仅用同版本的明确型号/名称匹配；泛称、设备编号与相近型号不借用照片。
export function knowledgeMedia(
  entity: KnowledgeEntitySummary & Partial<Pick<KnowledgeEntity, 'attributes'>>,
) {
  if (entity.type === 'DeviceModel') {
    const explicit = entity.attributes?.find((a) => ['model_name', '型号'].includes(a.name))?.value;
    const name = (entity.modelName ?? explicit ?? entity.name).trim().toUpperCase();
    if (['AN/PRC-150', 'AN/PRC-150(C)'].includes(name)) return photos.prc150;
    if (name === 'FT-891') return photos.ft891;
  }
  if (entity.type === 'Component' && entity.name.trim() === '天线馈线') return photos.feedline;
  return null;
}

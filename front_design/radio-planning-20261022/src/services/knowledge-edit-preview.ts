import type { KnowledgeDraft, KnowledgeSnapshot } from '../types/knowledge';
import { knowledgeEqual, type knowledgeDiff } from './knowledge-validation';

// 已发布基线只建立一次索引，输入时不复制、扫描整张知识图谱。
export function knowledgeEditIndex(base: KnowledgeSnapshot) {
  return {
    entities: new Map(base.entities.map((item, order) => [item.id, { item, order }])),
    relations: new Map(base.relations.map((item, order) => [item.id, { item, order }])),
  };
}

export function knowledgeEditDifferences(
  index: ReturnType<typeof knowledgeEditIndex>,
  draft: KnowledgeDraft,
): ReturnType<typeof knowledgeDiff> {
  return (['entities', 'relations'] as const).flatMap((kind) => {
    // 草稿为增改操作；基线顺序、重复ID的最后取值与原预览语义一致。
    const changed = new Map(draft[kind].map((item) => [item.id, item]));
    return [...changed.values()]
      .map((item, order) => ({ item, before: index[kind].get(item.id), order }))
      .filter(({ item, before }) => !before || !knowledgeEqual(before.item, item))
      .sort((a, b) =>
        (a.before?.order ?? index[kind].size + a.order) -
        (b.before?.order ?? index[kind].size + b.order),
      )
      .map(({ item, before }) => ({
        id: item.id, kind, action: before ? '修改' : '新增',
        before: before?.item ?? null, after: item,
      }));
  });
}

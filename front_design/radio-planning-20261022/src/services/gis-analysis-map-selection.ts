// 地图延迟回调只属于创建它的投影；清单选择不受地图透明度影响。
export function guardedAnalysisMapSelection(
  key: string,
  current: () => string,
  select: (kind: 'node' | 'link' | 'source', id: string) => void,
  linksVisible: () => boolean,
) {
  const choose = (kind: 'node' | 'link' | 'source', id: string) => {
    if (!key || key !== current() || (kind === 'link' && !linksVisible())) return;
    select(kind, id);
  };
  return {
    node: (id: string) => choose('node', id),
    link: (id: string) => choose('link', id),
    source: (id: string) => choose('source', id),
  };
}

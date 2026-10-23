import type { NetworkLink } from '../types/domain';

// 前端展示阈值，不参与主干判断、业务统计或规划计算。
export const LINK_DETAIL_ZOOM = 10;
export interface LinkDisplayState {
  zoom: number;
  selectedLinkId?: string;
  faultDimmed: boolean;
}

export function shouldDisplayLink(link: NetworkLink, zoom: number, retained = false) {
  // 只简化明确的非主干普通链路；未知缩放/身份、故障及关注对象保留。
  return !(zoom < LINK_DETAIL_ZOOM) || link.isBackbone !== false || link.state === 'FAULT' || retained;
}

export function createFaultPulse(
  update: (dimmed: boolean) => void,
  page: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document,
  motion: Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'> | undefined =
    window.matchMedia?.('(prefers-reduced-motion: reduce)'),
) {
  let enabled = false, disposed = false, dimmed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  function setDimmed(value: boolean) {
    if (dimmed === value) return;
    dimmed = value;
    update(value);
  }
  function sync() {
    if (disposed || !enabled || page.hidden || motion?.matches) {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      setDimmed(false);
      return;
    }
    // 600 ms 切换一次明暗，完整周期 1.2 s；重复更新不另起定时器。
    timer ??= setInterval(() => setDimmed(!dimmed), 600);
  }
  page.addEventListener('visibilitychange', sync);
  motion?.addEventListener('change', sync);
  return {
    setActive(value: boolean) { enabled = value; sync(); },
    dispose() {
      disposed = true;
      sync();
      page.removeEventListener('visibilitychange', sync);
      motion?.removeEventListener('change', sync);
    },
  };
}

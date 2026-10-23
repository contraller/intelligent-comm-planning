import { ref, watch, onBeforeUnmount } from 'vue';
import { previewService } from '../services';
import { useAuthStore } from '../stores/auth';
import type { MaintenanceQuery } from '../types/device-maintenance';
import type { DeviceNetworkContext, DeviceNetworkDetail } from '../types/device-network';
// 独立的局部下钻状态，不改变原设备选择和知识检索。
export function useDeviceNetworkDetail(
  query: () => MaintenanceQuery | null,
  network?: () => DeviceNetworkContext | undefined,
) {
  const auth = useAuthStore(),
    data = ref<DeviceNetworkDetail | null>(null),
    parentLink = ref<DeviceNetworkDetail | null>(null),
    busy = ref(false),
    error = ref(''),
    active = ref(false);
  let serial = 0,
    abort: AbortController | undefined,
    alive = true;
  const readable = () => {
    const q = query();
    return (
      alive &&
      !!q &&
      !auth.blocked &&
      auth.can(q.context === 'ledger' ? 'resources.view' : 'situation.view')
    );
  };
  function stop() {
    serial++;
    abort?.abort();
    busy.value = false;
  }
  function close() {
    stop();
    data.value = null;
    parentLink.value = null;
    error.value = '';
    active.value = false;
  }
  watch(
    [
      () => query()?.deviceId,
      () => query()?.revision,
      () => query()?.context,
      () => auth.generation,
      readable,
      () => network?.()?.state,
      () => network?.()?.snapshotId,
    ],
    close,
    { flush: 'sync' },
  );
  onBeforeUnmount(() => {
    alive = false;
    close();
  });
  const current = (token: number, owner: number) =>
    token === serial && owner === auth.generation && readable();
  function matchingLink(value: DeviceNetworkDetail | null) {
    const source = network?.(),
      q = query();
    return (
      !!q &&
      !!value?.link &&
      value.kind === 'link' &&
      source?.state === 'ready' &&
      source.snapshotId === value.snapshotId &&
      source.links.some(
        (link) =>
          link.id === value.link!.id &&
          (link.deviceA === q.deviceId || link.deviceB === q.deviceId),
      )
    );
  }
  async function open(kind: 'link' | 'service', id: string, snapshotId: string) {
    const q = query(),
      source = network?.();
    if (
      !q ||
      !readable() ||
      (network && (source?.state !== 'ready' || source.snapshotId !== snapshotId))
    )
      return false;
    close();
    active.value = true;
    busy.value = true;
    const token = serial,
      owner = auth.generation;
    abort = new AbortController();
    try {
      const value = await previewService.getDeviceNetworkDetail({
        ...q,
        kind,
        id,
        snapshotId,
        signal: abort.signal,
      });
      if (current(token, owner)) {
        data.value = value;
        return true;
      }
    } catch (e) {
      if (current(token, owner)) error.value = e instanceof Error ? e.message : '网络详情读取失败';
    } finally {
      if (token === serial) busy.value = false;
    }
    return false;
  }
  async function openRelatedService(id: string, linkId: string, snapshotId: string) {
    const q = query(),
      origin = data.value,
      source = network?.();
    if (
      !q ||
      !readable() ||
      busy.value ||
      !active.value ||
      !matchingLink(origin) ||
      origin!.link!.id !== linkId ||
      origin!.snapshotId !== snapshotId ||
      !source!.services.some((service) => service.id === id) ||
      !source!.routes.some((route) => route.demandId === id && route.linkIds.includes(linkId))
    )
      return false;
    // 本次只保留一个父链路；读取失败继续显示原链路，不能混入另一业务的旧详情。
    stop();
    busy.value = true;
    error.value = '';
    const token = serial,
      owner = auth.generation;
    abort = new AbortController();
    try {
      const value = await previewService.getDeviceNetworkDetail({
        ...q,
        kind: 'service',
        id,
        snapshotId,
        signal: abort.signal,
      });
      if (!current(token, owner)) return false;
      if (
        value.kind !== 'service' ||
        value.snapshotId !== snapshotId ||
        value.service?.id !== id ||
        !value.routes.some((route) => route.demandId === id && route.linkIds.includes(linkId))
      )
        throw new Error('业务详情与当前链路或网络快照不匹配，请重试读取');
      parentLink.value = origin;
      data.value = value;
      return true;
    } catch (e) {
      if (current(token, owner))
        error.value = e instanceof Error ? e.message : '业务详情读取失败，请重试';
    } finally {
      if (token === serial) busy.value = false;
    }
    return false;
  }
  function backToLink() {
    if (
      !readable() ||
      !active.value ||
      data.value?.kind !== 'service' ||
      !matchingLink(parentLink.value) ||
      data.value.snapshotId !== parentLink.value!.snapshotId
    )
      return false;
    // 返回复用本次已读父详情；关闭、换对象或失权会清空，不能复活旧快照。
    stop();
    data.value = parentLink.value;
    parentLink.value = null;
    error.value = '';
    return true;
  }
  return { data, parentLink, busy, error, active, open, openRelatedService, backToLink, close };
}

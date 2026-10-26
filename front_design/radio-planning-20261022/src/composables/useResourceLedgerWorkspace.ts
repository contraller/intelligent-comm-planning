import { computed, onMounted, onBeforeUnmount } from 'vue';
import { useResourceReadStore } from '../stores/resource-read';
import { useAuthStore } from '../stores/auth';
import { projectReadLedgerRows, readLedgerCounts } from '../services/resource-ledger-workspace';

// 页面只绑定统一服务结果，不判断数据来源，也不把本页当作完整资源库。
export function useResourceLedgerWorkspace() {
  const read = useResourceReadStore(), auth = useAuthStore();
  const rows = computed(() => projectReadLedgerRows(read.ledger?.items ?? []));
  const counts = computed(() => readLedgerCounts(read.ledger?.stats ?? read.workspace?.stats));
  const ready = computed(() => !!read.workspace);
  const frozen = computed(() => auth.blocked || read.frozen);
  const selected = computed(() => read.detail?.object.kind === 'device' ? projectReadLedgerRows([read.detail.object])[0] : null);
  // 详情直接使用服务返回的同版关联上下文。
  const detailContext = computed(() => ({ node: read.detail?.node ?? null, model: read.detail?.model ?? null,
    antenna: read.detail?.antenna ?? null, knowledgeAvailable: true }));
  // 所属节点随设备详情按同版关联返回，不向页面开放任意节点读取。
  onMounted(async () => { await read.activate('ledger'); });
  onBeforeUnmount(() => { read.stop(); });
  return { read, rows, counts, ready, frozen, selected, detailContext };
}

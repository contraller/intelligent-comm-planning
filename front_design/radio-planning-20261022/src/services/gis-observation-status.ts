import type { ObservationDeviceStatusRefInput } from '../types/observation';

interface Anchor {
  snapshotId: string;
  snapshotRevision: string;
  resourceRevision: string;
}
interface MemberRef extends Anchor {
  deviceId: string;
}
interface Header {
  snapshot_id: string;
  snapshot_revision: string;
  resource_revision: string;
}
// 成员只能来自用户勾选的已读记录；状态/告警未知不影响真实引用有效性。
export function selectedObservationStatusRef(
  anchor: Anchor | null,
  ids: readonly string[],
  rows: Record<string, { ref: MemberRef | null }>,
): ObservationDeviceStatusRefInput | null {
  if (!anchor || !ids.length || ids.length > 1000 || new Set(ids).size !== ids.length) return null;
  if (
    !ids.every((id) => {
      const row = rows[id]?.ref;
      return (
        row &&
        row.deviceId === id &&
        row.snapshotId === anchor.snapshotId &&
        row.snapshotRevision === anchor.snapshotRevision &&
        row.resourceRevision === anchor.resourceRevision
      );
    })
  )
    return null;
  return { ...anchor, deviceIds: [...ids].sort() };
}

export async function readObservationStatusHeader<T extends Header>(
  client: {
    getSnapshot(
      input: { context: 'ledger'; snapshot_id: string; snapshot_revision: string },
      options: { signal: AbortSignal },
    ): Promise<T>;
  },
  ref: ObservationDeviceStatusRefInput,
  resourceRevision: string,
  signal: AbortSignal,
): Promise<T | null> {
  const expected = { ...ref, deviceIds: [...ref.deviceIds] };
  if (signal.aborted) return null;
  if (expected.resourceRevision !== resourceRevision)
    throw new Error('该观测引用属于其他资源版本，请先打开对应版本的方案。');
  const header = await client.getSnapshot(
    {
      context: 'ledger',
      snapshot_id: expected.snapshotId,
      snapshot_revision: expected.snapshotRevision,
    },
    { signal },
  );
  if (signal.aborted) return null;
  if (
    header.snapshot_id !== expected.snapshotId ||
    header.snapshot_revision !== expected.snapshotRevision ||
    header.resource_revision !== expected.resourceRevision
  )
    throw new Error('返回状态快照与观测冻结引用不一致');
  return header;
}

import { describe, expect, it, vi } from 'vitest';
import {
  readObservationStatusHeader,
  selectedObservationStatusRef,
} from '../src/services/gis-observation-status';

const anchor = { snapshotId: 'status-1', snapshotRevision: 'S1', resourceRevision: 'R1' };
const ref = { ...anchor, deviceIds: ['D1'] };
const header = { snapshot_id: 'status-1', snapshot_revision: 'S1', resource_revision: 'R1' };
const rows = {
  D1: { ref: { ...anchor, deviceId: 'D1' }, status: null, alert: null },
  D2: { ref: { ...anchor, deviceId: 'D2' }, status: null, alert: null },
};

describe('GIS显式观测状态引用', () => {
  it('初始不默认选择全网或已读取成员', () => {
    expect(selectedObservationStatusRef(anchor, [], rows)).toBeNull();
    expect(selectedObservationStatusRef(null, ['D1'], rows)).toBeNull();
  });
  it('未知状态仍可按真实身份引用，只返回勾选成员且不修改输入', () => {
    const ids = ['D2', 'D1'];
    expect(selectedObservationStatusRef(anchor, ids, rows)).toEqual({
      ...anchor,
      deviceIds: ['D1', 'D2'],
    });
    expect(ids).toEqual(['D2', 'D1']);
    expect(selectedObservationStatusRef(anchor, ['D2'], rows)?.deviceIds).toEqual(['D2']);
  });
  it('拒绝未读取、重复或超限成员', () => {
    expect(selectedObservationStatusRef(anchor, ['D3'], rows)).toBeNull();
    expect(selectedObservationStatusRef(anchor, ['D1', 'D1'], rows)).toBeNull();
    expect(
      selectedObservationStatusRef(
        anchor,
        Array.from({ length: 1001 }, (_, i) => `D${i}`),
        rows,
      ),
    ).toBeNull();
    expect(selectedObservationStatusRef(anchor, ['D1'], { D1: { ref: null } })).toBeNull();
  });
  it.each(['snapshotId', 'snapshotRevision', 'resourceRevision', 'deviceId'] as const)(
    '拒绝%s错版投影',
    (key) => {
      expect(
        selectedObservationStatusRef(anchor, ['D1'], {
          D1: { ref: { ...rows.D1.ref, [key]: 'other' } },
        }),
      ).toBeNull();
    },
  );
  it('通过真实服务方法读取冻结头，不伪造状态或告警', async () => {
    const getSnapshot = vi.fn(async () => ({ ...header, marker: 'actual-header' }));
    const signal = new AbortController().signal;
    expect(await readObservationStatusHeader({ getSnapshot }, ref, 'R1', signal)).toEqual({
      ...header,
      marker: 'actual-header',
    });
    expect(getSnapshot).toHaveBeenCalledExactlyOnceWith(
      { context: 'ledger', snapshot_id: 'status-1', snapshot_revision: 'S1' },
      { signal },
    );
  });
  it('外版引用明确失败，不读取或套用当前资源', async () => {
    const getSnapshot = vi.fn(async () => header);
    await expect(
      readObservationStatusHeader({ getSnapshot }, ref, 'R2', new AbortController().signal),
    ).rejects.toThrow('其他资源版本');
    expect(getSnapshot).not.toHaveBeenCalled();
  });
  it.each(['snapshot_id', 'snapshot_revision', 'resource_revision'] as const)(
    '拒绝服务返回的%s错版身份',
    async (key) => {
      const getSnapshot = vi.fn(async () => ({ ...header, [key]: 'other' }));
      await expect(
        readObservationStatusHeader({ getSnapshot }, ref, 'R1', new AbortController().signal),
      ).rejects.toThrow('不一致');
    },
  );
  it('取消前后均不返回晚响应，未开始时不发请求', async () => {
    const before = new AbortController();
    before.abort();
    const getSnapshot = vi.fn(async () => header);
    expect(await readObservationStatusHeader({ getSnapshot }, ref, 'R1', before.signal)).toBeNull();
    expect(getSnapshot).not.toHaveBeenCalled();
    const during = new AbortController();
    expect(
      await readObservationStatusHeader(
        {
          getSnapshot: async () => {
            during.abort();
            return header;
          },
        },
        ref,
        'R1',
        during.signal,
      ),
    ).toBeNull();
  });
  it('发起时冻结身份，外部输入改变不能接受错版回执', async () => {
    const input = { ...ref, deviceIds: [...ref.deviceIds] };
    const getSnapshot = async () => {
      input.snapshotRevision = 'S2';
      input.deviceIds.push('D2');
      return { ...header, snapshot_revision: 'S2' };
    };
    await expect(
      readObservationStatusHeader({ getSnapshot }, input, 'R1', new AbortController().signal),
    ).rejects.toThrow('不一致');
  });
  it('服务失败保留错误，不转为未绑定或成功', async () => {
    const getSnapshot = async () => {
      throw new Error('FORBIDDEN');
    };
    await expect(
      readObservationStatusHeader({ getSnapshot }, ref, 'R1', new AbortController().signal),
    ).rejects.toThrow('FORBIDDEN');
  });
});

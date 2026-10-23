import { describe, expect, it, vi } from 'vitest';
import { guardedAnalysisMapSelection } from '../src/services/gis-analysis-map-selection';

describe('冻结分析地图回调所有权', () => {
  it('当前投影回调可选择节点、链路与源', () => {
    const select = vi.fn();
    const events = guardedAnalysisMapSelection(
      'before',
      () => 'before',
      select,
      () => true,
    );
    events.node('N1');
    events.link('L1');
    events.source('IF1');
    expect(select.mock.calls).toEqual([
      ['node', 'N1'],
      ['link', 'L1'],
      ['source', 'IF1'],
    ]);
  });
  it.each(['preview', 'other-run', 'other-plan', ''])('切到%s后拒绝旧地图所有回调', (next) => {
    let current = 'before';
    const select = vi.fn();
    const events = guardedAnalysisMapSelection(
      current,
      () => current,
      select,
      () => true,
    );
    current = next;
    events.node('N1');
    events.link('L1');
    events.source('IF1');
    expect(select).not.toHaveBeenCalled();
  });
  it('隐藏或透明拓扑仅阻止地图选线，不影响节点与源', () => {
    let visible = false;
    const select = vi.fn();
    const events = guardedAnalysisMapSelection(
      'before',
      () => 'before',
      select,
      () => visible,
    );
    events.link('L1');
    events.node('N1');
    events.source('IF1');
    visible = true;
    events.link('L2');
    expect(select.mock.calls).toEqual([
      ['node', 'N1'],
      ['source', 'IF1'],
      ['link', 'L2'],
    ]);
  });
  it('没有投影身份时不接受地图事件', () => {
    const select = vi.fn();
    guardedAnalysisMapSelection(
      '',
      () => '',
      select,
      () => true,
    ).link('L1');
    expect(select).not.toHaveBeenCalled();
  });
});

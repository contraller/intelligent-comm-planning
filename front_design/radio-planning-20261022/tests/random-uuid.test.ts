import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUuid } from '../src/services/random-uuid';

afterEach(() => vi.unstubAllGlobals());

describe('HTTP 环境 UUID v4', () => {
  // 使用固定随机字节，核对补零、分组以及版本位和变体位的覆盖规则。
  it.each([
    { bytes: new Uint8Array(16), expected: '00000000-0000-4000-8000-000000000000' },
    { bytes: new Uint8Array(16).fill(255), expected: 'ffffffff-ffff-4fff-bfff-ffffffffffff' },
    { bytes: Uint8Array.from({ length: 16 }, (_, index) => index * 17), expected: '00112233-4455-4677-8899-aabbccddeeff' },
  ])('仅有 getRandomValues 时生成 $expected', ({ bytes, expected }) => {
    const getRandomValues = vi.fn((array: Uint8Array) => {
      array.set(bytes);
      return array;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    expect(randomUuid()).toBe(expected);
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(getRandomValues.mock.calls[0][0]).toHaveLength(16);
  });

  it('原生 UUID 方法存在时仍使用统一随机源，每次生成读取新随机值', () => {
    let sequence = 0;
    const getRandomValues = vi.fn((array: Uint8Array) => array.fill(++sequence));
    const randomUUID = vi.fn(() => { throw new Error('不应调用原生 UUID 方法'); });
    vi.stubGlobal('crypto', { getRandomValues, randomUUID });
    expect(randomUuid()).not.toBe(randomUuid());
    expect(getRandomValues).toHaveBeenCalledTimes(2);
    expect(randomUUID).not.toHaveBeenCalled();
  });

  // 缺少安全随机数能力时明确失败，不改用可预测的编号。
  it.each([undefined, {}, { getRandomValues: null }])('随机源不可用时提示更换浏览器：%j', crypto => {
    vi.stubGlobal('crypto', crypto);
    expect(() => randomUuid()).toThrow('当前浏览器不支持安全随机数生成，请升级或更换浏览器');
  });
});

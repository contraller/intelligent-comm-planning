// 使用同一随机源生成 UUID，兼容 HTTP 环境且不依赖 randomUUID。
export function randomUuid(): string {
  const random = globalThis.crypto;
  if (typeof random?.getRandomValues !== 'function') {
    throw new Error('当前浏览器不支持安全随机数生成，请升级或更换浏览器');
  }

  const bytes = random.getRandomValues(new Uint8Array(16));
  // 固定 UUID v4 的版本位和变体位，其余位保留随机值。
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

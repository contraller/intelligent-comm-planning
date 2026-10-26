import type { ResourceStorage } from '../../src/types/resource-edit';

// 仅供测试显式注入，可模拟拒绝读取/配额耗尽；生产没有此降级路径。
export class TestStorage implements ResourceStorage {
  entries = new Map<string, string>();
  failRead = false;
  failWrite = false;
  writes = 0;
  failReadKeys = new Set<string>();
  failWriteKeys = new Set<string>();
  readHistory: string[] = [];
  writeHistory: string[] = [];
  getItem(key: string) {
    this.readHistory.push(key);
    if (this.failRead || this.failReadKeys.has(key)) throw new Error('SecurityError');
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrite || this.failWriteKeys.has(key)) throw new Error('QuotaExceededError');
    this.writeHistory.push(key);
    this.entries.set(key, value);
    this.writes += 1;
  }
}

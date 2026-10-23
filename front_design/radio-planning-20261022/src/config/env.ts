import { ApiError } from '../services/types';

// 配置错误应可见，不能静默降级为 Mock。
export const env = {
  mode: import.meta.env.VITE_DATA_MODE ?? 'mock',
  // 示例数据标识独立于传输协议，HTTP 示例环境也可显式开启。
  sampleData: import.meta.env.VITE_SAMPLE_DATA === 'true' ||
    (import.meta.env.VITE_SAMPLE_DATA !== 'false' && (import.meta.env.VITE_DATA_MODE ?? 'mock') === 'mock'),
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '/api/v1',
} as const;

// 认证只允许同源 API；根相对路径可在隔离测试中校验，不猜测真实后端地址。
export function resolveAuthApiBaseUrl(value: string, origin?: string): string {
  const fail = () => new ApiError('认证 API 必须配置为同源根相对路径或同源 HTTP(S) 地址', 'INVALID_AUTH_BASE_URL');
  if (!value || value !== value.trim() || value.includes('\\') || value.startsWith('//')) throw fail();
  if (!value.startsWith('/') && !origin) throw fail();
  let parsed: URL;
  const expectedOrigin = origin ?? 'http://same-origin.invalid';
  try { parsed = new URL(value, expectedOrigin); } catch { throw fail(); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== expectedOrigin || parsed.username || parsed.password || parsed.search || parsed.hash) throw fail();
  if (!value.startsWith('/') && !/^https?:\/\//.test(value)) throw fail();
  return parsed.pathname.replace(/\/$/, '');
}

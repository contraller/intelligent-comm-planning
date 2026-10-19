import type { AuthenticatedRequest } from './auth-http';
import type { PlanningApiServices } from '../types/planning-api';
import { resolveAuthApiBaseUrl } from '../config/env';
import { assertTaskOptions, apiId } from './task-api-validation';
import { readCoverageRaster } from './coverage-validation';
import { ApiError } from './types';

// 图片地址只允许同源 API 文件路径，不携带身份访问外部图片地址。
export function coverageFilePath(value: string, baseUrl: string, origin = globalThis.location?.origin ?? 'http://same-origin.invalid'): string {
  const base = resolveAuthApiBaseUrl(baseUrl, origin);
  let url: URL; try { url = new URL(value, origin); } catch { throw new ApiError('覆盖图片地址无效', 'INVALID_COVERAGE_URL'); }
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || value.includes('\\') || /%(?:2e|2f|5c)/i.test(value) || !url.pathname.startsWith(base + '/files/') || !url.pathname.endsWith('.png')) throw new ApiError('覆盖图片必须位于同源 API 文件目录', 'INVALID_COVERAGE_URL');
  return url.pathname.slice(base.length);
}
export function createCoverageHttp(request: AuthenticatedRequest, baseUrl: () => string): PlanningApiServices['getPlanningCoverageImage'] {
  return async input => {
    assertTaskOptions(input); apiId(input.snapshotId); const raster = readCoverageRaster(input.raster);
    const blob = await request<Blob>(coverageFilePath(raster.url, baseUrl()), { signal: input.signal, headers: { Accept: 'image/png' } }, 'blob');
    const bytes = new Uint8Array(await blob.slice(0, 24).arrayBuffer()), signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length !== 24 || signature.some((n, i) => bytes[i] !== n) || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') throw new ApiError('覆盖图片不是有效 PNG', 'INVALID_COVERAGE_IMAGE');
    const view = new DataView(bytes.buffer);
    if (view.getUint32(16) !== raster.width || view.getUint32(20) !== raster.height) throw new ApiError('覆盖图片尺寸与元数据不符', 'INVALID_COVERAGE_IMAGE');
    return blob;
  };
}

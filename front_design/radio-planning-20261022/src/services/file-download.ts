import type { ResourceFile } from '../types/resource-edit';

// 只处理文件字节副本；权限、请求归属及错误反馈由调用入口负责。
export function downloadFile(file: ResourceFile, revokeDelayMs: number): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(file.bytes)], { type: file.mime })),
    a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  // 点击成功后按入口原有延迟回收，同步异常仍交原调用点处理。
  setTimeout(() => URL.revokeObjectURL(url), revokeDelayMs);
}

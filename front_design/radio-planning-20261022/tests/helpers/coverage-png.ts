import { inflateSync } from 'node:zlib';

// 教学 PNG 使用无滤波 RGBA 行；保留每行滤波字节，供资产测试独立核对像素。
export function pngPixels(png: Buffer) {
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  return inflateSync(Buffer.concat(chunks));
}

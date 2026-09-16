"""最小 TIFF/GeoTIFF 读取器，纯标准库。

只实现本项目用到的子集：单波段、PlanarConfig=1、uint8/int16、
无压缩与 LZW（Predictor=1）、条带(strip)与分块(tile)两种布局。
不追求通用，够用且可验证即可。
"""
import struct

TAG = {256: "width", 257: "height", 258: "bits", 259: "compression",
       262: "photometric", 273: "strip_offsets", 277: "samples",
       278: "rows_per_strip", 279: "strip_counts", 284: "planar",
       317: "predictor", 322: "tile_width", 323: "tile_height",
       324: "tile_offsets", 325: "tile_counts", 339: "sample_format",
       33550: "pixel_scale", 33922: "tiepoint", 42113: "nodata"}
TYPESIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}


class TiffError(Exception):
    pass


def read_tags(f):
    f.seek(0)
    head = f.read(8)
    bo = "<" if head[:2] == b"II" else ">"
    if struct.unpack(bo + "H", head[2:4])[0] != 42:
        raise TiffError("仅支持经典 TIFF（非 BigTIFF）")
    f.seek(struct.unpack(bo + "I", head[4:8])[0])
    n = struct.unpack(bo + "H", f.read(2))[0]
    entries = f.read(12 * n)
    out = {}
    for i in range(n):
        e = entries[12 * i:12 * i + 12]
        tag, typ, cnt = struct.unpack(bo + "HHI", e[:8])
        size = TYPESIZE.get(typ, 1) * cnt
        if size <= 4:
            raw = e[8:8 + size]
        else:
            pos = struct.unpack(bo + "I", e[8:12])[0]
            cur = f.tell(); f.seek(pos); raw = f.read(size); f.seek(cur)
        if typ == 3:
            val = struct.unpack(bo + "%dH" % cnt, raw)
        elif typ == 4:
            val = struct.unpack(bo + "%dI" % cnt, raw)
        elif typ == 12:
            val = struct.unpack(bo + "%dd" % cnt, raw)
        elif typ == 2:
            val = (raw.rstrip(b"\0").decode("ascii", "replace"),)
        else:
            val = raw
        out[TAG.get(tag, tag)] = val
    out["_bo"] = bo
    return out


def lzw_decode(data, expected=None):
    """TIFF 变体 LZW 解码。

    与 GIF 的差别：TIFF 使用 early change（码长提前一码递增），
    清除码 256、结束码 257、新码从 258 起、起始码长 9 位、最大 12 位。
    """
    CLEAR, EOI = 256, 257
    out = bytearray()
    table = None
    prev = None
    bitpos = 0
    nbits = 9
    total_bits = len(data) * 8
    get = int.from_bytes

    while bitpos + nbits <= total_bits:
        byte_i = bitpos >> 3
        chunk = data[byte_i:byte_i + 3]
        if len(chunk) < 3:
            chunk = chunk + b"\0" * (3 - len(chunk))
        val = get(chunk, "big")
        code = (val >> (24 - (bitpos & 7) - nbits)) & ((1 << nbits) - 1)
        bitpos += nbits

        if code == EOI:
            break
        if code == CLEAR:
            table = [bytes([i]) for i in range(256)] + [b"", b""]
            nbits = 9
            prev = None
            continue
        if table is None:                      # 容错：未见清除码也能起步
            table = [bytes([i]) for i in range(256)] + [b"", b""]

        if code < len(table):
            entry = table[code]
            if prev is not None:
                table.append(prev + entry[:1])
        elif prev is not None:
            entry = prev + prev[:1]
            table.append(entry)
        else:
            raise TiffError("LZW 码流损坏：首码越界")

        out += entry
        prev = entry
        if len(table) + 1 >= (1 << nbits) and nbits < 12:
            nbits += 1
        if expected is not None and len(out) >= expected:
            break
    return bytes(out)


class Tiff:
    """按需读取像素块，不把整幅影像load进内存。"""

    def __init__(self, path):
        self.path = path
        self.f = open(path, "rb")
        t = read_tags(self.f)
        self.tags = t
        self.bo = t["_bo"]
        self.width = t["width"][0]
        self.height = t["height"][0]
        self.bits = t["bits"][0]
        self.samples = t.get("samples", (1,))[0]
        self.compression = t.get("compression", (1,))[0]
        self.predictor = t.get("predictor", (1,))[0]
        self.sample_format = t.get("sample_format", (1,))[0]
        if self.samples != 1:
            raise TiffError("仅支持单波段")
        if t.get("planar", (1,))[0] != 1:
            raise TiffError("仅支持 PlanarConfig=1")
        if self.compression not in (1, 5):
            raise TiffError("仅支持无压缩与 LZW，实际 compression=%d" % self.compression)
        if self.predictor != 1:
            raise TiffError("暂不支持 Predictor=%d" % self.predictor)

        self.tiled = "tile_width" in t
        if self.tiled:
            self.tw = t["tile_width"][0]
            self.th = t["tile_height"][0]
            self.offsets = t["tile_offsets"]
            self.counts = t["tile_counts"]
            self.tiles_across = (self.width + self.tw - 1) // self.tw
            self.tiles_down = (self.height + self.th - 1) // self.th
        else:
            self.rows_per_strip = t.get("rows_per_strip", (self.height,))[0]
            self.offsets = t["strip_offsets"]
            self.counts = t["strip_counts"]

        ps = t.get("pixel_scale", (0, 0, 0))
        tp = t.get("tiepoint", (0, 0, 0, 0, 0, 0))
        self.pixel_lon = ps[0]
        self.pixel_lat = ps[1]
        self.origin_lon = tp[3]
        self.origin_lat = tp[4]
        nd = t.get("nodata", (None,))[0]
        self.nodata = float(nd) if nd not in (None, "") else None
        self.dtype = ("int%d" if self.sample_format == 2 else "uint%d") % self.bits

    @property
    def bbox(self):
        return (self.origin_lon, self.origin_lat - self.height * self.pixel_lat,
                self.origin_lon + self.width * self.pixel_lon, self.origin_lat)

    def _block(self, idx):
        self.f.seek(self.offsets[idx])
        raw = self.f.read(self.counts[idx])
        if self.compression == 5:
            raw = lzw_decode(raw)
        return raw

    def rows(self, step=1):
        """逐行产出像素字节，行内不做下采样。step 控制隔行读取。"""
        bpp = self.bits // 8
        if not self.tiled:
            rps = self.rows_per_strip
            cache_i, cache = -1, b""
            for y in range(0, self.height, step):
                si = y // rps
                if si != cache_i:
                    cache_i, cache = si, self._block(si)
                r = y % rps
                yield cache[r * self.width * bpp:(r + 1) * self.width * bpp]
        else:
            row_bytes = self.tw * bpp
            cache_row, cache = -1, None
            for y in range(0, self.height, step):
                ty = y // self.th
                if ty != cache_row:
                    cache = [self._block(ty * self.tiles_across + tx)
                             for tx in range(self.tiles_across)]
                    cache_row = ty
                r = y % self.th
                buf = bytearray()
                for tx in range(self.tiles_across):
                    buf += cache[tx][r * row_bytes:(r + 1) * row_bytes]
                yield bytes(buf[:self.width * bpp])

    def close(self):
        self.f.close()

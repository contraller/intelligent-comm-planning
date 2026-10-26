"""最小 Shapefile 读取器，纯标准库。

只实现本项目用到的子集：PolyLine(3) / PolyLineZ(13) 几何 + DBF 属性。
参考 ESRI Shapefile Technical Description (1998)。
"""
import struct


class Dbf:
    """DBF 属性表读取。"""

    def __init__(self, path, encoding="utf-8"):
        self.f = open(path, "rb")
        h = self.f.read(32)
        self.count = struct.unpack("<I", h[4:8])[0]
        self.header_len = struct.unpack("<H", h[8:10])[0]
        self.record_len = struct.unpack("<H", h[10:12])[0]
        self.fields = []
        pos = 32
        while True:
            d = self.f.read(32)
            if d[:1] in (b"\r", b"", b"\x1a"):
                break
            name = d[:11].rstrip(b"\0").decode("ascii", "replace")
            ftype = d[11:12].decode("ascii")
            flen = d[16]
            self.fields.append((name, ftype, flen))
            pos += 32
        self.encoding = encoding

    def record(self, i):
        self.f.seek(self.header_len + i * self.record_len)
        raw = self.f.read(self.record_len)
        out, p = {}, 1                         # 首字节为删除标记
        for name, ftype, flen in self.fields:
            v = raw[p:p + flen]
            p += flen
            try:
                s = v.decode(self.encoding).strip()
            except UnicodeDecodeError:
                s = v.decode("latin-1").strip()
            out[name] = s
        return out

    def close(self):
        self.f.close()


class Shp:
    """SHP 几何读取。只解析 PolyLine 系列。"""

    def __init__(self, path):
        self.f = open(path, "rb")
        h = self.f.read(100)
        self.shape_type = struct.unpack("<i", h[32:36])[0]
        self.bbox = struct.unpack("<4d", h[36:68])
        self.f.seek(0, 2)
        self.size = self.f.tell()

    def __iter__(self):
        """产出 (记录序号从0起, [[(lon,lat),...], ...])，每条记录可含多段。"""
        self.f.seek(100)
        idx = 0
        while self.f.tell() < self.size:
            hdr = self.f.read(8)
            if len(hdr) < 8:
                break
            _, clen = struct.unpack(">ii", hdr)
            body = self.f.read(clen * 2)
            st = struct.unpack("<i", body[:4])[0]
            if st == 0:                        # Null shape
                idx += 1
                continue
            if st not in (3, 13, 23):
                idx += 1
                continue
            nparts, npoints = struct.unpack("<ii", body[36:44])
            parts = struct.unpack("<%di" % nparts, body[44:44 + 4 * nparts])
            po = 44 + 4 * nparts
            coords = struct.unpack("<%dd" % (2 * npoints), body[po:po + 16 * npoints])
            lines = []
            for k in range(nparts):
                a = parts[k]
                b = parts[k + 1] if k + 1 < nparts else npoints
                lines.append([(coords[2 * j], coords[2 * j + 1]) for j in range(a, b)])
            yield idx, lines
            idx += 1

    def close(self):
        self.f.close()


def clip_line(line, bbox):
    """按 bbox 粗裁：保留落在框内的点，跨界处保留相邻点以免线段断开。
    用于减体积，不做严格的 Cohen-Sutherland 交点计算。"""
    lo0, la0, lo1, la1 = bbox
    inside = [lo0 <= x <= lo1 and la0 <= y <= la1 for x, y in line]
    if not any(inside):
        return []
    out, cur = [], []
    for i, (p, ins) in enumerate(zip(line, inside)):
        near = ins or (i > 0 and inside[i - 1]) or (i + 1 < len(inside) and inside[i + 1])
        if near:
            cur.append(p)
        elif cur:
            if len(cur) >= 2:
                out.append(cur)
            cur = []
    if len(cur) >= 2:
        out.append(cur)
    return out

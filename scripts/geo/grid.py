"""网格栅格读取，纯标准库。

读取 prepare_geodata.py 产出的「JSON 头 + gzip 原始网格」，
整幅载入内存后按经纬度 O(1) 采样。
"""
import array, gzip, json, os

_DTYPE = {"int16": ("h", 2), "uint8": ("B", 1), "int32": ("i", 4), "float32": ("f", 4)}


class GridRaster:
    def __init__(self, header_path):
        with open(header_path, encoding="utf-8") as f:
            self.meta = json.load(f)
        m = self.meta
        self.width = m["width"]
        self.height = m["height"]
        self.origin_lon = m["origin_lon"]
        self.origin_lat = m["origin_lat"]
        self.pixel_lon = m["pixel_lon"]
        self.pixel_lat = m["pixel_lat"]
        self.nodata = m.get("nodata")
        code, size = _DTYPE[m["dtype"]]
        path = os.path.join(os.path.dirname(header_path), m["data_file"])
        with gzip.open(path, "rb") as f:
            raw = f.read()
        self.data = array.array(code)
        self.data.frombytes(raw)
        if self.data.itemsize != size:
            raise ValueError("平台 %s 宽度不符" % m["dtype"])
        import sys
        if sys.byteorder != m.get("byteorder", "little"):
            self.data.byteswap()
        if len(self.data) != self.width * self.height:
            raise ValueError("网格尺寸与头部不符：%d != %d x %d"
                             % (len(self.data), self.width, self.height))

    @property
    def bbox(self):
        return tuple(self.meta["bbox"])

    def index(self, lon, lat):
        """经纬度 -> (列, 行)；越界返回 None。行自北向南。"""
        col = int((lon - self.origin_lon) / self.pixel_lon)
        row = int((self.origin_lat - lat) / self.pixel_lat)
        if col < 0 or col >= self.width or row < 0 or row >= self.height:
            return None
        return col, row

    def sample(self, lon, lat, default=None):
        ij = self.index(lon, lat)
        if ij is None:
            return default
        col, row = ij
        v = self.data[row * self.width + col]
        if self.nodata is not None and v == self.nodata:
            return default
        return v

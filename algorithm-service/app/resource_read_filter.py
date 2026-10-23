"""设备分页与文件导出共用的纯筛选；不读库、不改资源。"""
from .resource_export_schemas import ResourceDeviceFilter


def filter_device_items(items, query: ResourceDeviceFilter):
    def matches(item):
        for field in ("device_class", "mobility", "node_role", "relay_capable"):
            expected = getattr(query, field)
            if expected is not None and item.get(field) != expected:
                return False
        for field in ("status", "availability"):
            if getattr(query, field) is not None and (item.get(field) or "UNKNOWN") != getattr(query, field):
                return False
        if query.alert is not None and item.get("alert") is not {"YES": True, "NO": False, "UNKNOWN": None}[query.alert]:
            return False
        term = query.search.strip().lower()
        if term and term not in " ".join(str(item.get(key, "")) for key in ("device_id", "model_name", "node_name")).lower():
            return False
        freq = query.frequency
        if freq is None or freq.mode == "ALL":
            return True
        lo = freq.min_khz if freq.min_khz is not None else float("-inf")
        hi = freq.max_khz if freq.max_khz is not None else float("inf")
        bounded = freq.min_khz is not None or freq.max_khz is not None
        if freq.mode == "MODEL":
            a, b = item.get("freq_min_khz"), item.get("freq_max_khz")
            return not bounded or a is not None and b is not None and 0 <= a <= b and a <= hi and b >= lo
        value = item.get("work_freq_khz")
        if freq.presence == "MISSING":
            return value is None
        return (not bounded and freq.presence == "ALL") or value is not None and 0 <= value and lo <= value <= hi

    return [item for item in items if matches(item)]


def sort_device_items(items, sort="id", order="asc"):
    field = {"id": "device_id", "name": "model_name", "status": "status", "workFreqKhz": "work_freq_khz"}[sort]
    ordered = sorted(items, key=lambda item: item["device_id"])
    present = [row for row in ordered if row.get(field) is not None and row.get(field) != ""]
    missing = [row for row in ordered if row.get(field) is None or row.get(field) == ""]
    # 缺失值无论正反序均排最后，同值保留 ID 升序。
    return sorted(present, key=lambda item: item[field], reverse=order == "desc") + missing

"""服务端静态权限目录；不依赖前端文件，不向任何角色自动授予权限。"""
from __future__ import annotations

_NAMES = {
    "situation.view": "查看 GIS 态势",
    "resources.view": "查看资源",
    "resources.edit": "维护资源及频谱配置",
    "resources.reset": "重置资源",
    "resources.device.edit": "维护已有设备基础参数",
    "resources.device.availability": "维护已有设备上下架",
    "resources.frequency.disable": "停用已有规划频点",
    "resources.import": "预检及整批导入构造资源",
    "resources.create": "新增构造资源",
    "resources.workspace.edit": "维护构造资源草稿",
    "resources.frequency.maintain": "维护构造规划频点",
    "resources.spectrum.edit": "维护频谱来源声明",
    "resources.device.status.import": "导入构造设备状态快照",
    "situation.observation.import": "导入构造观测数据集",
    "planning.view": "查看规划",
    "planning.execute": "维护任务、调整/提交/取消规划",
    "planning.save": "保存方案版本",
    "planning.confirm": "确认方案",
    "planning.reset": "重置规划",
    "diagnosis.view": "查看诊断及报告",
    "diagnosis.scenario": "维护/导入场景",
    "diagnosis.execute": "提交/取消诊断",
    "diagnosis.export": "导出诊断文件",
    "diagnosis.reset": "重置诊断",
    "knowledge.view": "查看图谱及型号知识",
    "knowledge.edit": "编辑/送审/撤回本人知识",
    "knowledge.review": "审核知识",
    "knowledge.publish": "发布知识",
    "knowledge.rollback": "回滚知识",
    "knowledge.reset": "重置知识",
    "system.view": "访问系统管理",
    "system.accounts": "维护账号",
    "system.roles": "维护角色权限",
    "system.logs": "查看操作日志",
    "system.parameters": "维护演示参数",
    "system.reset": "重置系统配置/日志",
}
_GROUPS = {"situation": "GIS 态势", "resources": "资源", "planning": "规划", "diagnosis": "诊断", "knowledge": "知识", "system": "系统"}


def _entry(code: str, name: str) -> dict:
    module = code.split(".", 1)[0]
    requires = [] if code == module + ".view" else [module + ".view"]
    if code in ("knowledge.publish", "knowledge.rollback", "knowledge.reset"):
        requires.append("knowledge.review")
    return {"code": code, "name": name, "group": _GROUPS[module], "requires": requires}


SERVER_PERMISSION_REGISTRY = [_entry(code, name) for code, name in _NAMES.items()]

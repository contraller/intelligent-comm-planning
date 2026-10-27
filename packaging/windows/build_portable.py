"""从交付源码和已锁定依赖构建离线便携包，不复制开发库、密钥或个人日志。"""
from __future__ import annotations

import argparse
import hashlib
from importlib.metadata import distributions
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
TEMPLATES = ROOT / "packaging/windows"
EMBED_SHA256 = "15fea3c9367653a85086fe37216b4d1a1c78688fa5e1587e1db0b0f658856564"
EMBED_URL = "https://www.python.org/ftp/python/3.12.4/python-3.12.4-embed-amd64.zip"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def same_source(left, right):
    if not right.is_file():
        return False
    if digest(left) == digest(right):
        return True
    # Git Windows 检出的 CRLF 与 LF 不改变源码；二进制不做文本转换。
    try:
        return left.read_text(encoding="utf-8") == right.read_text(encoding="utf-8")
    except UnicodeError:
        return False


def safe_member(name):
    path = PurePosixPath(name.replace("\\", "/"))
    return not path.is_absolute() and ".." not in path.parts and not any(":" in part for part in path.parts)


def source_files():
    values = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode("utf-8").split("\0")
    prefixes = ("algorithm-service/", "scripts/", "alt_steiner/", "data/")
    return [value for value in values if value.startswith(prefixes) and not value.endswith(".pyc")]


def copy_dependencies(site, target):
    from packaging.markers import default_environment
    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name
    available = {canonicalize_name(d.metadata["Name"]): d for d in distributions(path=[str(site)])}
    pending = [Requirement(value) for value in (
        "fastapi", "SQLAlchemy", "alembic", "psycopg[binary]", "python-docx", "openpyxl", "Pillow",
        "reportlab", "python-multipart", "uvicorn[standard]", "pydantic", "httpx",
    )]
    selected, visited = {}, set()
    while pending:
        requirement = pending.pop()
        name = canonicalize_name(requirement.name)
        identity = (name, tuple(sorted(requirement.extras)))
        if identity in visited:
            continue
        visited.add(identity)
        distribution = available.get(name)
        if distribution is None or not requirement.specifier.contains(distribution.version):
            raise RuntimeError("构建依赖缺失或版本不符：" + str(requirement))
        selected[name] = distribution
        for raw in distribution.requires or ():
            child = Requirement(raw)
            if child.marker is None or any(child.marker.evaluate({**default_environment(), "extra": extra})
                                           for extra in {"", *requirement.extras}):
                pending.append(child)
    copied = set()
    for distribution in selected.values():
        if not distribution.files:
            raise RuntimeError("依赖缺少分发文件清单：" + distribution.metadata["Name"])
        for record in distribution.files:
            name = str(record).replace("\\", "/")
            if not safe_member(name) or "__pycache__" in PurePosixPath(name).parts or name.endswith(".pyc"):
                continue
            source = Path(distribution.locate_file(record)).resolve()
            if not source.is_relative_to(site.resolve()) or name in copied:
                continue
            if not source.is_file():
                raise RuntimeError("依赖分发文件缺失：" + name)
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            copied.add(name)
    return sorted([{"name": d.metadata["Name"], "version": d.version} for d in selected.values()], key=lambda x: x["name"].lower())


def build(args):
    if sys.version_info[:2] != (3, 12) or os.name != "nt" or sys.maxsize <= 2 ** 32:
        raise RuntimeError("请使用 Windows x64 Python 3.12 构建，与嵌入式解释器 ABI 一致")
    target, embed, site = args.output.resolve(), args.python_embed.resolve(), args.site_packages.resolve()
    if target.exists() or target.with_suffix(".zip").exists():
        raise RuntimeError("输出已存在；请指定新的输出目录，不覆盖或删除已有包")
    if digest(embed) != EMBED_SHA256:
        raise RuntimeError("Python 官方嵌入包 SHA256 不匹配")
    if target.is_relative_to(ROOT / "front_design"):
        raise RuntimeError("不能把输出放在前端源目录")
    target.mkdir(parents=True)
    canonical_frontend = ROOT / "front_design/radio-planning-20261022"
    frontend = args.frontend_source.resolve() if args.frontend_source else canonical_frontend
    if frontend != canonical_frontend:
        # 不支持目录联接的磁盘允许复用完全相同的构建源和依赖，逐文件核对运行内容。
        names = subprocess.check_output(["git", "ls-files", "-z", "front_design/radio-planning-20261022"], cwd=ROOT).decode().split("\0")
        for name in filter(None, names):
            relative = (ROOT / name).relative_to(canonical_frontend)
            if relative.parts[0] in ("src", "public") or relative.name in ("package.json", "package-lock.json", "vite.config.ts", "index.html", ".env.integration") or relative.name.startswith("tsconfig"):
                other = frontend / relative
                if not same_source(ROOT / name, other):
                    raise RuntimeError("复用的前端构建源与交付分支不一致：" + str(relative))
    # 复用构建机 node_modules，不安装、不复制依赖；最终包只带静态产物。
    subprocess.run([str(args.node), str(frontend / "node_modules/vue-tsc/bin/vue-tsc.js"), "--noEmit"], cwd=frontend, check=True)
    static = target / "app/front_design/radio-planning-20261022/dist"
    subprocess.run([str(args.node), str(frontend / "node_modules/vite/bin/vite.js"), "build", "--mode", "integration",
                    "--outDir", str(static)], cwd=frontend, check=True)
    for name in source_files():
        source, destination = ROOT / name, target / "app" / name
        if not source.is_file() or source.is_symlink():
            raise RuntimeError("源码清单包含缺失文件或符号链接：" + name)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    # 后端影响图按既有只读路径使用中文字体，不依赖目标电脑的字体安装情况。
    font_source = canonical_frontend / "public/fonts"
    shutil.copytree(font_source, target / "app/front_design/radio-planning-20261022/public/fonts")
    # 只保留实际运行所需源码；不会打包测试数据库或本地配置。
    runtime = target / "runtime/python"
    runtime.mkdir(parents=True)
    with zipfile.ZipFile(embed) as archive:
        if any(not safe_member(value.filename) for value in archive.infolist()):
            raise RuntimeError("嵌入包包含非法成员路径")
        archive.extractall(runtime)
    (runtime / "python312._pth").write_text(
        "python312.zip\n.\nLib/site-packages\n../../app\n../../app/algorithm-service\n../../app/scripts\nimport site\n", encoding="utf-8")
    dependencies = copy_dependencies(site, runtime / "Lib/site-packages")
    for source, name in (("launcher.py", "launcher.py"), ("启动系统.cmd", "启动系统.cmd"),
                         ("停止系统.cmd", "停止系统.cmd"), ("使用说明.txt", "使用说明.txt")):
        shutil.copy2(TEMPLATES / source, target / name)
    licenses = target / "licenses"
    licenses.mkdir()
    shutil.copy2(runtime / "LICENSE.txt", licenses / "Python-LICENSE.txt")
    for path in (frontend / "public/fonts").rglob("*"):
        if path.is_file() and any(value in path.name.lower() for value in ("license", "ofl", "notice")):
            shutil.copy2(path, licenses / path.name)
    shutil.copy2(frontend / "public/maps/ATTRIBUTION.md", licenses / "地图与道路来源.md")
    notices = []
    lock = json.loads((frontend / "package-lock.json").read_text(encoding="utf-8"))
    for name, entry in sorted(lock["packages"].items()):
        if not name.startswith("node_modules/") or entry.get("dev"):
            continue
        folder = frontend / name
        if not folder.is_dir():
            continue
        texts = [path for path in folder.iterdir() if path.is_file() and path.name.upper().startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE"))]
        notices.append(name + " " + str(entry.get("version", "")) + "\n声明许可：" + str(entry.get("license", "见依赖文件")))
        notices.extend(path.name + "\n" + path.read_text(encoding="utf-8", errors="replace") for path in texts)
    (licenses / "Frontend-THIRD-PARTY.txt").write_text("\n\n".join(notices), encoding="utf-8")
    checks = subprocess.run([str(runtime / "python.exe"), "-B", "-c",
        "import fastapi,sqlalchemy,alembic,psycopg,docx,openpyxl,PIL,reportlab,multipart,uvicorn,pydantic,httpx,ssl,sqlite3; docx.Document(); openpyxl.Workbook(); print('RUNTIME_IMPORT_OK')"],
        cwd=target, check=True, capture_output=True, text=True)
    print(checks.stdout.strip())
    # 清单不包含运行时凭据；任何 user_data 都不进入 ZIP。
    files = {path.relative_to(target).as_posix(): digest(path) for path in sorted(target.rglob("*")) if path.is_file()}
    manifest = {"schema": 1, "platform": "Windows 10/11 x64", "source_commit": subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(), "python": {"version": "3.12.4", "url": EMBED_URL, "sha256": EMBED_SHA256},
        "database": "FIRST_START_NEW_DATABASE_NO_DEVELOPER_HISTORY", "data_origin": "SYNTHETIC_INTEGRATION",
        "dependencies": dependencies, "files": files}
    (target / "package-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    output_zip = target.with_suffix(".zip")
    with zipfile.ZipFile(output_zip, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(target.rglob("*")):
            if path.is_file():
                archive.write(path, target.name + "/" + path.relative_to(target).as_posix())
    output_zip.with_suffix(".zip.sha256").write_text(digest(output_zip) + "  " + output_zip.name + "\n", encoding="ascii")
    print(json.dumps({"zip": str(output_zip), "bytes": output_zip.stat().st_size, "files": len(files) + 1,
                      "dependencies": len(dependencies)}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--python-embed", type=Path, required=True)
    parser.add_argument("--site-packages", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--frontend-source", type=Path, help="可选：与交付分支内容逐文件一致、已有依赖的前端目录")
    build(parser.parse_args())

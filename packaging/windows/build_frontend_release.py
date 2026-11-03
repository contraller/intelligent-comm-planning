"""流式复用已核验ZIP生成完整离线包；缺省仅换前端，源码、例程和文档须显式选择。"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import stat
import tempfile
import unicodedata
from urllib.parse import unquote, urlsplit
import zipfile

from launcher import _CSS_REFERENCES, _FrontendHTML, check_frontend_assets, javascript_asset_references

PROJECT = Path(__file__).resolve().parents[2]
CACHE = PROJECT / "data/runtime/cache"
DEFAULT_BASE = PROJECT / "data/runtime/portable-delivery/releases/LOCAL-20261103-7298a2b8d328/RadioPlanning_Windows_x64_portable.zip"
DEFAULT_BASE_SHA256 = "f20c8e282ec9932f7636744a09fdffd9f69daaa12e5ab17547d9dda891633c14"
EXAMPLE_SHA256 = "d81b7e4daacb4d799e4d60c714e1552c892d322daa43bc4b1b85977a49336e0f"
EXAMPLE_PREFIX = "系统例程导入数据/"
EXAMPLE_CATALOG = EXAMPLE_PREFIX + "例程文件清单.json"
EXAMPLE_ENTRY = EXAMPLE_PREFIX + "导入使用指南.html"
PRIMARY_GUIDE = "首次使用演示.html"
LEGACY_GUIDE = "首次使用演示_旧流程.html"
DOCUMENT_MAP = {
    "docs/output/短波超短波智能规划系统用户手册.docx": "用户手册/用户手册.docx",
    "docs/output/短波超短波智能规划系统用户手册.pdf": "用户手册/用户手册.pdf",
    "docs/output/短波超短波智能规划系统软件研制总结报告.docx": "研制总结/软件研制总结报告.docx",
    "packaging/windows/使用说明.txt": "使用说明.txt",
}
PACKAGE_NAME = "RadioPlanning_Windows_x64_portable.zip"
DIST = "app/front_design/radio-planning-20261022/dist/"
INDEX = DIST + "index.html"
ASSETS = DIST + "assets/"
MANIFEST = "package-manifest.json"
BUFFER = 1024 * 1024


def digest(path):
    with Path(path).open("rb") as stream:
        return stream_digest(stream)


def stream_digest(stream):
    first = stream.read(16)
    if first == b"SQLite format 3\x00":
        raise RuntimeError("不允许数据库文件进入发行包")
    hashed = hashlib.sha256(first)
    while chunk := stream.read(BUFFER):
        hashed.update(chunk)
    return hashed.hexdigest()


def canonical(name):
    if (type(name) is not str or not name or "\\" in name or name.startswith("/")
            or any(ord(char) < 32 or ord(char) == 127 for char in name)):
        raise RuntimeError("ZIP成员路径无效")
    path = PurePosixPath(name)
    if path.as_posix() != name or any(part in ("", ".", "..") or ":" in part
                                    or part.endswith((".", " ")) for part in path.parts):
        raise RuntimeError("ZIP成员路径越界或不规范：" + name)
    return name


def folded(name):
    return unicodedata.normalize("NFC", name).casefold()


def reject_private(name):
    parts = folded(name).split("/")
    if (folded(name).startswith("app/data/runtime/") or folded(name) == "app/data/runtime"
            or any(part in ("user_data", "userdata", ".git", ".codex") for part in parts)
            or re.search(r"\.(?:db|db3|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$", parts[-1])):
        raise RuntimeError("不允许用户运行目录或数据库进入发行包：" + name)


def pairs_no_duplicates(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise RuntimeError("清单含重复键")
        value[key] = item
    return value


def snapshot_hash(files):
    # 与build_portable.py完全相同：按键排序、默认ASCII转义、紧凑JSON。
    return hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def validate_base(archive):
    infos = archive.infolist()
    by_name, seen = {}, set()
    for info in infos:
        canonical(info.filename)
        key = folded(info.filename)
        if key in seen:
            raise RuntimeError("ZIP含重复或大小写冲突成员：" + info.filename)
        seen.add(key)
        kind = stat.S_IFMT(info.external_attr >> 16)
        if info.is_dir() or kind not in (0, stat.S_IFREG) or info.flag_bits & 1:
            raise RuntimeError("ZIP只接受未加密普通文件：" + info.filename)
        by_name[info.filename] = info
    manifests = [name for name in by_name if name.endswith("/" + MANIFEST)]
    if len(manifests) != 1 or len(PurePosixPath(manifests[0]).parts) != 2:
        raise RuntimeError("ZIP必须只有一个包根清单")
    root = manifests[0].split("/", 1)[0] + "/"
    if any(not name.startswith(root) for name in by_name):
        raise RuntimeError("ZIP含包根目录之外的成员")
    manifest = json.loads(archive.read(by_name[manifests[0]]).decode("utf-8"), object_pairs_hook=pairs_no_duplicates)
    if type(manifest) is not dict or manifest.get("schema") != 1 or type(manifest.get("files")) is not dict:
        raise RuntimeError("基包清单结构无效")
    files, entries, folded_files = manifest["files"], {}, set()
    for name, expected in files.items():
        canonical(name)
        reject_private(name)
        key = folded(name)
        if key in folded_files or key == folded(MANIFEST):
            raise RuntimeError("清单路径重复或自引用")
        folded_files.add(key)
        if type(expected) is not str or re.fullmatch(r"[0-9a-f]{64}", expected) is None:
            raise RuntimeError("清单文件摘要无效：" + name)
        if root + name not in by_name:
            raise RuntimeError("清单成员缺失：" + name)
        info = by_name[root + name]
        with archive.open(info) as stream:
            actual = stream_digest(stream)
        if actual != expected:
            raise RuntimeError("基包成员摘要不符：" + name)
        entries[name] = info
    if set(by_name) != {root + name for name in files} | {root + MANIFEST}:
        raise RuntimeError("ZIP含未登记成员")
    content_hash = snapshot_hash(files)
    version = manifest.get("controlled_version")
    if (manifest.get("content_snapshot_sha256") != content_hash or type(version) is not str
            or re.fullmatch(r"LOCAL-[0-9]{8}-" + content_hash[:12], version) is None):
        raise RuntimeError("基包受控版本与内容清单不一致")
    if INDEX not in entries or not any(name.startswith(ASSETS) for name in entries):
        raise RuntimeError("基包缺少完整前端入口和编译资源")
    return root, manifest, entries


def frontend_files(directory):
    directory = Path(directory).absolute()
    if not directory.is_dir() or directory.is_symlink() or directory.is_junction():
        raise RuntimeError("前端dist必须是实际目录")
    files, seen, pending = {}, set(), [directory]
    while pending:
        folder = pending.pop()
        for path in sorted(folder.iterdir()):
            if path.is_symlink() or path.is_junction():
                raise RuntimeError("前端产物不允许链接目录或文件")
            if path.is_dir():
                pending.append(path)
                continue
            if not path.is_file():
                raise RuntimeError("前端产物只接受普通文件")
            relative = canonical(path.relative_to(directory).as_posix())
            if relative != "index.html" and not relative.startswith("assets/"):
                raise RuntimeError("新dist只能包含index.html和assets，不允许复制public资源：" + relative)
            reject_private(relative)
            if folded(relative) in seen:
                raise RuntimeError("前端产物大小写冲突")
            seen.add(folded(relative))
            files[DIST + relative] = path
    if INDEX not in files or not any(name.startswith(ASSETS) for name in files):
        raise RuntimeError("新dist缺少index.html或assets")
    return files


def runtime_source_files(paths, project_root):
    root = Path(project_root).absolute()
    result, seen = {}, set()
    forbidden = {"config", "configuration", "settings", "data", "runtime", "migrations", "migration", "alembic",
                 "dependencies", "site-packages", "node_modules", ".venv", "venv", "__pycache__"}
    for name in paths:
        canonical(name)
        parts = PurePosixPath(name).parts
        if (len(parts) < 3 or parts[:2] not in (("algorithm-service", "app"), ("scripts", "diagnosis"))
                or not name.endswith(".py") or any(folded(part) in forbidden for part in parts[2:])
                or folded(PurePosixPath(name).stem) in forbidden | {"database"}):
            raise RuntimeError("运行源码覆盖超出明确Python白名单：" + name)
        if folded(name) in seen:
            raise RuntimeError("运行源码覆盖路径重复")
        seen.add(folded(name))
        path = root.joinpath(*parts)
        for ancestor in (path, *path.parents):
            if ancestor.exists() and (ancestor.is_symlink() or ancestor.is_junction()):
                raise RuntimeError("运行源码覆盖不接受链接")
            if ancestor == root:
                break
        if not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
            raise RuntimeError("运行源码文件缺失或越界：" + name)
        result["app/"+name] = path
    return result


def document_source_files(project_root):
    """仅装配四份canonical文件原字节，不解析或编辑文档内容。"""
    root = Path(project_root).absolute()
    result = {}
    for relative, destination in DOCUMENT_MAP.items():
        path = root.joinpath(*PurePosixPath(relative).parts)
        for ancestor in (path, *path.parents):
            if ancestor.is_symlink() or ancestor.is_junction():
                raise RuntimeError("交付文档来源不接受链接")
            if ancestor == root:
                break
        if not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
            raise RuntimeError("canonical交付文档缺失或越界：" + relative)
        result[destination] = path
    return result


def validate_example_archive(archive):
    infos, seen = {}, set()
    for info in archive.infolist():
        canonical(info.filename)
        reject_private(info.filename)
        key = folded(info.filename)
        parts = PurePosixPath(info.filename).parts
        if (not info.filename.startswith(EXAMPLE_PREFIX) or key in seen or info.is_dir() or info.flag_bits & 1
                or stat.S_IFMT(info.external_attr >> 16) not in (0, stat.S_IFREG)
                or any(folded(part) in {"runtime", "logs", "evidence", "证据"} for part in parts[1:])
                or folded(parts[-1]) in {"settings.json", "service.json", "initialized.json", "首次登录账号.txt", "访问地址.txt"}):
            raise RuntimeError("例程成员范围、重复路径或文件类型无效")
        seen.add(key)
        infos[info.filename] = info
    if len(infos) != 22 or EXAMPLE_CATALOG not in infos or EXAMPLE_ENTRY not in infos:
        raise RuntimeError("受控例程必须完整包含22个文件及固定指南/清单")
    content = json.loads(archive.read(infos[EXAMPLE_CATALOG]).decode("utf-8-sig"), object_pairs_hook=pairs_no_duplicates)
    if type(content) is not dict or content.get("start") != "导入使用指南.html" or type(content.get("files")) is not list:
        raise RuntimeError("例程内部清单结构或入口无效")
    registered = set()
    for item in content["files"]:
        if type(item) is not dict or type(item.get("path")) is not str:
            raise RuntimeError("例程清单条目无效")
        relative = canonical(item["path"])
        name = EXAMPLE_PREFIX+relative
        if name in registered or name == EXAMPLE_CATALOG or name not in infos:
            raise RuntimeError("例程清单重复、自引用或缺失")
        registered.add(name)
        if type(item.get("bytes")) is not int or item["bytes"] != infos[name].file_size:
            raise RuntimeError("例程清单文件大小不符")
        with archive.open(infos[name]) as stream:
            actual = stream_digest(stream)
        if actual != item.get("sha256"):
            raise RuntimeError("例程清单文件摘要不符")
    if registered != set(infos)-{EXAMPLE_CATALOG}:
        raise RuntimeError("例程含未登记或遗漏文件")
    return {name: archive.read(info) for name, info in infos.items()}


def example_materials(path):
    path = Path(path).absolute()
    with path.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != EXAMPLE_SHA256:
            raise RuntimeError("只接受已确认SHA256的固定受控例程ZIP")
        stream.seek(0)
        with zipfile.ZipFile(stream) as archive:
            return validate_example_archive(archive)


def guide_page():
    return ('''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>系统例程导入指引</title><style>body{max-width:800px;margin:60px auto;padding:20px;background:#102132;color:#d9e7f1;font:17px/1.9 system-ui}a{color:#83d4ff}h1{font-size:28px}.primary{display:block;padding:20px;border:1px solid #6baccd;border-radius:8px;font-size:21px}small{color:#a9bdca}</style>
<h1>系统例程导入指引</h1><p>从下方新指南开始，按本机资源版本选择对应例程，依次完成规划、设备状态、故障场景及结构化知识导入。</p>
<a class="primary" href="./系统例程导入数据/导入使用指南.html">打开系统例程导入指南</a>
<p><small>例程为人工构造数据。导入与计算按指南分别执行，不能将输入文件视为已完成的计算结果。</small></p>
<p><a href="./首次使用演示_旧流程.html">查看旧版首次使用流程与原例程附件</a></p></html>''').encode("utf-8")


def update_order(name):
    return (2 if name == INDEX else 1 if name == PRIMARY_GUIDE else 0, name)


def copy_checked(source, target, expected):
    hashed = hashlib.sha256()
    while chunk := source.read(BUFFER):
        hashed.update(chunk)
        target.write(chunk)
    if hashed.hexdigest() != expected:
        raise RuntimeError("复制期间成员内容变化，未接受发行结果")


def verify_closure(archive, entries, sources, files, qa_root):
    qa_root = Path(qa_root).absolute()
    if not qa_root.resolve().is_relative_to(CACHE.resolve()):
        raise RuntimeError("QA临时目录必须位于本项目F盘缓存目录")
    for path in (qa_root, *qa_root.parents):
        if path.exists() and (path.is_symlink() or path.is_junction()):
            raise RuntimeError("QA临时目录不接受链接")
        if path == PROJECT:
            break
    qa_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="frontend-release-", dir=qa_root) as temporary:
        qa = Path(temporary).resolve()
        assert qa.parent == qa_root.resolve()
        pending, visited = [("index.html", "./index.html")], set()
        while pending:
            parent, reference = pending.pop()
            url = urlsplit(reference.replace("\\", "/"))
            if url.scheme or url.netloc or not url.path:
                continue
            decoded = unquote(url.path)
            relative = posixpath.normpath(decoded.lstrip("/") if decoded.startswith("/")
                                          else posixpath.join(posixpath.dirname(parent), decoded))
            canonical(relative)
            if relative in visited:
                continue
            name = DIST + relative
            if name not in files:
                raise RuntimeError("前端资源闭包缺失：" + relative)
            target = qa.joinpath(*PurePosixPath(relative).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with (sources[name].open("rb") if name in sources else archive.open(entries[name])) as stream, target.open("xb") as destination:
                copy_checked(stream, destination, files[name])
            visited.add(relative)
            if target.suffix.lower() not in (".html", ".js", ".mjs", ".css"):
                continue
            text = target.read_text(encoding="utf-8-sig")
            if target.suffix.lower() == ".html":
                html = _FrontendHTML()
                html.feed(text)
                references = html.references
            elif target.suffix.lower() == ".css":
                references = (next(value for value in match.groups() if value is not None)
                              for match in _CSS_REFERENCES.finditer(text) if any(value is not None for value in match.groups()))
            else:
                references = javascript_asset_references(text)
            pending.extend((relative, value) for value in references)
        checked = check_frontend_assets(qa)
        assert {path.relative_to(qa).as_posix() for path in checked} == visited
        return sorted(visited)


def build_release(*, base_zip, frontend_dist, output_dir, expected_base_sha256=DEFAULT_BASE_SHA256,
                  version_date="20261103", qa_root=None, runtime_sources=(), project_root=PROJECT, example_zip=None,
                  refresh_documents=False):
    base_zip, output_dir = Path(base_zip).absolute(), Path(output_dir).absolute()
    if output_dir.exists():
        raise RuntimeError("新发行目录必须不存在；不会覆盖旧包或已有成果")
    if type(expected_base_sha256) is not str or re.fullmatch(r"[0-9a-f]{64}", expected_base_sha256) is None:
        raise RuntimeError("必须指定有效基包SHA256")
    if datetime.strptime(version_date, "%Y%m%d").strftime("%Y%m%d") != version_date:
        raise RuntimeError("受控版本日期无效")
    frontend = frontend_files(frontend_dist)
    runtime = runtime_source_files(runtime_sources, project_root)
    documents = document_source_files(project_root) if refresh_documents else {}
    sources = {**frontend, **runtime, **documents}
    extra = example_materials(example_zip) if example_zip is not None else {}
    example_hashes = {name: hashlib.sha256(value).hexdigest() for name, value in extra.items()}
    with base_zip.open("rb") as base_stream:
        if hashlib.file_digest(base_stream, "sha256").hexdigest() != expected_base_sha256:
            raise RuntimeError("基包SHA256不符；未生成新包")
        base_stream.seek(0)
        with zipfile.ZipFile(base_stream) as archive:
            root, old_manifest, entries = validate_base(archive)
            old_files = old_manifest["files"]
            if example_zip is not None:
                if PRIMARY_GUIDE not in entries:
                    raise RuntimeError("基包缺少需保留的旧首次使用入口")
                if LEGACY_GUIDE not in old_files:
                    extra[LEGACY_GUIDE] = archive.read(entries[PRIMARY_GUIDE])
                extra[PRIMARY_GUIDE] = guide_page()
            retained = {name: value for name, value in old_files.items()
                        if name != INDEX and not name.startswith(ASSETS) and name not in sources and name not in extra}
            files = {**retained, **{name: digest(path) for name, path in sources.items()},
                     **{name: hashlib.sha256(value).hexdigest() for name, value in extra.items()}}
            files = dict(sorted(files.items()))
            if len({folded(name) for name in files}) != len(files):
                raise RuntimeError("新包文件路径存在大小写冲突")
            closure = verify_closure(archive, entries, sources, files, qa_root or CACHE / "frontend-release")
            content_hash = snapshot_hash(files)
            manifest = copy.deepcopy(old_manifest)
            manifest.update(controlled_version="LOCAL-"+version_date+"-"+content_hash[:12],
                            content_snapshot_sha256=content_hash, files=files)
            manifest_bytes = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
            replaced = sorted(name for name in old_files.keys() & files.keys() if old_files[name] != files[name])
            added = sorted(files.keys() - old_files.keys())
            removed = sorted(old_files.keys() - files.keys())
            if any(name != INDEX and not name.startswith(ASSETS) and name not in runtime and name not in documents and name not in extra
                   for name in replaced + added + removed):
                raise RuntimeError("变化清单超出本轮明确白名单")
            output_dir.mkdir(parents=True, exist_ok=False)
            output_zip = output_dir / PACKAGE_NAME
            pending_zip = output_dir / (PACKAGE_NAME + ".pending")
            try:
                with zipfile.ZipFile(pending_zip, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as result:
                    result.comment = archive.comment
                    for name in sorted(retained):
                        info = copy.copy(entries[name])
                        with archive.open(entries[name]) as source, result.open(info, "w", force_zip64=True) as target:
                            copy_checked(source, target, files[name])
                    # 明确源码和新资源先写，主指引/前端入口后写，清单最后。
                    for name in sorted(set(sources) | set(extra), key=update_order):
                        info = (zipfile.ZipInfo.from_file(sources[name], arcname=root+name)
                                if name in sources else zipfile.ZipInfo(root+name))
                        info.compress_type = zipfile.ZIP_DEFLATED
                        if name in sources:
                            with sources[name].open("rb") as source, result.open(info, "w", force_zip64=True) as target:
                                copy_checked(source, target, files[name])
                        else:
                            result.writestr(info, extra[name])
                    result.writestr(root+MANIFEST, manifest_bytes)
                pending_zip.rename(output_zip)
            except BaseException:
                pending_zip.unlink(missing_ok=True)
                raise
    (output_dir / MANIFEST).write_bytes(manifest_bytes)
    zip_hash = digest(output_zip)
    output_zip.with_suffix(".zip.sha256").write_text(zip_hash+"  "+output_zip.name+"\n", encoding="ascii")
    changed = sorted(set(replaced + added), key=update_order)
    changes = {"replace": replaced+[MANIFEST], "add": added, "remove": removed,
               "ordered_updates": changed+[MANIFEST]}
    (output_dir / "frontend-changes.json").write_text(json.dumps(changes, ensure_ascii=False, indent=2), encoding="utf-8")
    scope = (["FRONTEND_COMPILED"] + (["EXPLICIT_RUNTIME_SOURCES"] if runtime else [])
             + (["FIXED_CONTROLLED_EXAMPLES"] if example_zip is not None else []) + (["CANONICAL_DOCUMENTS"] if documents else []))
    metadata = {"schema": 1, "method": "FRONTEND_ONLY_FULL_CONTROLLED_PACKAGE" if len(scope) == 1 else "SCOPED_FULL_CONTROLLED_PACKAGE",
                "release_scope": scope,
                "runtime_source_overlays": sorted(runtime),
                "runtime_source_sha256": {name: files[name] for name in sorted(runtime)},
                "document_overlays": sorted(documents),
                "document_overlay_sha256": {name: files[name] for name in sorted(documents)},
                "document_source_paths": {destination: relative for relative, destination in DOCUMENT_MAP.items() if destination in documents},
                "example_materials": None if example_zip is None else {"source_zip": str(Path(example_zip).absolute()),
                    "zip_sha256": EXAMPLE_SHA256, "file_count": len(example_hashes), "content_sha256": snapshot_hash(example_hashes),
                    "files": example_hashes, "entry": EXAMPLE_ENTRY, "primary_entry": PRIMARY_GUIDE, "legacy_entry": LEGACY_GUIDE},
                "base_zip": str(base_zip), "base_zip_sha256": expected_base_sha256,
                "base_controlled_version": old_manifest["controlled_version"],
                "controlled_version": manifest["controlled_version"], "content_snapshot_sha256": content_hash,
                "zip": str(output_zip), "zip_sha256": zip_hash, "zip_bytes": output_zip.stat().st_size,
                "archive_root": root, "file_count": len(files)+1, "unchanged_files_preserved": len(retained),
                "files": {"changed": replaced, "added": added, "removed": removed},
                "frontend_compiled_files": len(frontend), "closure_files": closure, "closure_count": len(closure),
                "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(), "changes": changes,
                "changed_file_sha256": {name: files[name] for name in changed}}
    metadata_text = json.dumps(metadata, ensure_ascii=False, indent=2)
    (output_dir / "frontend-release.json").write_text(metadata_text, encoding="utf-8")
    (output_dir / "summary.json").write_text(metadata_text, encoding="utf-8")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-zip", type=Path, default=DEFAULT_BASE)
    parser.add_argument("--expected-base-sha256", default=DEFAULT_BASE_SHA256)
    parser.add_argument("--frontend-dist", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--version-date", default=datetime.now().strftime("%Y%m%d"))
    parser.add_argument("--runtime-source", action="append", default=[], help="明确覆盖的仓库相对.py路径，可重复")
    parser.add_argument("--example-zip", type=Path, help="固定受控的系统例程导入数据ZIP")
    parser.add_argument("--refresh-documents", action="store_true", help="只更新canonical手册DOCX/PDF、研制总结DOCX及使用说明")
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    for key in ("TEMP", "TMP", "TMPDIR"):
        os.environ[key] = str(CACHE)
    print(json.dumps(build_release(base_zip=args.base_zip, frontend_dist=args.frontend_dist, output_dir=args.output_dir,
                                  expected_base_sha256=args.expected_base_sha256, version_date=args.version_date,
                                  runtime_sources=args.runtime_source, example_zip=args.example_zip,
                                  refresh_documents=args.refresh_documents), ensure_ascii=False))


if __name__ == "__main__":
    main()

"""小型构造ZIP验证全包流式前端发行；不解压实际包、不访问网络或用户实例。"""
from copy import deepcopy
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import sys
import zipfile

import pytest

HERE = Path(__file__).resolve().parent


def module():
    sys.path.insert(0, str(HERE))
    spec = importlib.util.spec_from_file_location("frontend_release_contract", HERE / "build_frontend_release.py")
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write_base(path, files, *, extra=None, wrong_member=None, manifest_patch=None, link=None):
    hashes = dict(sorted((name, sha(data)) for name, data in files.items()))
    content_hash = sha(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode())
    manifest = {"schema": 1, "controlled_version": "LOCAL-20261103-"+content_hash[:12],
                "content_snapshot_sha256": content_hash, "files": hashes,
                "dependencies": {"fixture": "1"}, "public_notes": "保留原公开说明"}
    if manifest_patch:
        manifest.update(manifest_patch)
    with zipfile.ZipFile(path, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            if name == link:
                info = zipfile.ZipInfo("Package/"+name)
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(info, data)
            else:
                archive.writestr("Package/"+name, b"wrong" if name == wrong_member else data)
        archive.writestr("Package/package-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2).encode())
        for name, data in extra or []:
            archive.writestr(name, data)
    return sha(path.read_bytes()), manifest


@pytest.fixture
def inputs(tmp_path):
    release = module()
    files = {
        "launcher.py": b"preserve launcher exactly",
        "app/algorithm-service/app/main.py": b"preserve backend exactly",
        "app/algorithm-service/app/fault.py": b"old_fault=True\n",
        "runtime/python/python.exe": b"MZ-fixture-python",
        "用户手册/用户手册.pdf": b"%PDF-fixture-public-manual",
        "首次使用演示.html": b"legacy-first-use-guide",
        "首次使用演示/old-example.csv": b"preserve existing public attachment",
        release.INDEX: b'<script type="module" src="./assets/old.js"></script>',
        release.ASSETS+"old.js": b'export const old=true;',
        release.ASSETS+"orphan.css": b'.old{}',
        release.DIST+"maps/public.svg": b'<svg>unchanged public resource</svg>',
        release.DIST+"maps/tile1.pbf": b"preserve public tile bytes",
    }
    base = tmp_path / "base.zip"
    base_hash, manifest = write_base(base, files)
    dist = tmp_path / "compiled-dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text('<script type="module" src="./assets/new.js"></script><link rel="stylesheet" href="./assets/new.css">', encoding="utf-8")
    (dist / "assets/new.js").write_text('import("./lazy.js");', encoding="utf-8")
    (dist / "assets/lazy.js").write_text('export const ready=true;', encoding="utf-8")
    (dist / "assets/new.css").write_text('body{background:url("/maps/public.svg")}', encoding="utf-8")
    (dist / "assets/unused.js").write_text('export const included=true;', encoding="utf-8")
    return release, tmp_path, base, base_hash, files, manifest, dist


def build(inputs, **kwargs):
    release, tmp_path, base, expected, _, _, dist = inputs
    return release.build_release(base_zip=base, expected_base_sha256=expected, frontend_dist=dist,
                                 output_dir=tmp_path / "new-release", version_date="20261103", **kwargs)


def test_full_package_preserves_other_payload_and_replaces_only_complete_frontend(inputs, monkeypatch):
    release, tmp_path, base, base_hash, original, old_manifest, dist = inputs
    def no_extract(*args, **kwargs):
        pytest.fail("不允许整包解压")
    monkeypatch.setattr(zipfile.ZipFile, "extract", no_extract)
    monkeypatch.setattr(zipfile.ZipFile, "extractall", no_extract)
    metadata = build(inputs)
    with zipfile.ZipFile(metadata["zip"]) as archive:
        manifest = json.loads(archive.read("Package/package-manifest.json"))
        for name, data in original.items():
            if name != release.INDEX and not name.startswith(release.ASSETS):
                assert archive.read("Package/"+name) == data
        assert "Package/"+release.ASSETS+"old.js" not in archive.namelist()
        assert "Package/"+release.ASSETS+"orphan.css" not in archive.namelist()
        for path in dist.rglob("*"):
            if path.is_file():
                assert archive.read("Package/"+release.DIST+path.relative_to(dist).as_posix()) == path.read_bytes()
        assert archive.namelist()[-2:] == ["Package/"+release.INDEX, "Package/package-manifest.json"]
        assert len(archive.namelist()) == len(manifest["files"])+1
        for name, expected in manifest["files"].items():
            assert sha(archive.read("Package/"+name)) == expected
    expected_content = sha(json.dumps(manifest["files"], sort_keys=True, separators=(",", ":")).encode())
    assert manifest["content_snapshot_sha256"] == expected_content
    assert metadata["controlled_version"] == "LOCAL-20261103-"+expected_content[:12]
    assert metadata["release_scope"] == ["FRONTEND_COMPILED"]
    assert metadata["runtime_source_overlays"] == [] and metadata["example_materials"] is None
    assert metadata["document_overlays"] == [] and metadata["document_overlay_sha256"] == {}
    assert metadata["base_zip_sha256"] == base_hash and metadata["base_controlled_version"] == old_manifest["controlled_version"]
    assert set(metadata["files"]) == {"changed", "added", "removed"}
    assert all("package-manifest.json" not in values for values in metadata["files"].values())
    assert manifest["dependencies"] == old_manifest["dependencies"] and manifest["public_notes"] == old_manifest["public_notes"]
    assert sha(base.read_bytes()) == base_hash
    assert metadata["closure_count"] == 5
    assert metadata["frontend_compiled_files"] == 5
    assert "assets/unused.js" not in metadata["closure_files"]
    assert "maps/public.svg" in metadata["closure_files"]
    assert set(metadata["changes"]["remove"]) == {release.ASSETS+"old.js", release.ASSETS+"orphan.css"}
    assert metadata["changes"]["ordered_updates"][-2:] == [release.INDEX, "package-manifest.json"]
    output = Path(metadata["zip"])
    assert output.with_suffix(".zip.sha256").read_text().startswith(sha(output.read_bytes())+"  ")
    assert json.loads((output.parent / "frontend-changes.json").read_text(encoding="utf-8")) == metadata["changes"]
    assert json.loads((output.parent / "summary.json").read_text(encoding="utf-8")) == metadata


def test_wrong_known_base_hash_and_existing_output_never_overwrite(inputs):
    release, tmp_path, base, _, _, _, dist = inputs
    with pytest.raises(RuntimeError, match="SHA256不符"):
        release.build_release(base_zip=base, frontend_dist=dist, output_dir=tmp_path/"new-release", expected_base_sha256="0"*64)
    assert not (tmp_path/"new-release").exists()
    output = tmp_path/"new-release"
    output.mkdir()
    sentinel = output/"keep.zip"
    sentinel.write_bytes(b"keep old artifact")
    with pytest.raises(RuntimeError, match="不会覆盖"):
        build(inputs)
    assert sentinel.read_bytes() == b"keep old artifact"


@pytest.mark.parametrize("bad", ["Package/../escape.py", "Package/app\\data\\runtime\\r2.sqlite", "Outside/file.txt", "Package/app/Data/Runtime/settings.json", "Package/app/data/unexpected.db", "Package/app/data/disguised.bin"])
def test_unsafe_private_or_unregistered_base_members_rejected(inputs, bad):
    release, tmp_path, base, _, files, _, dist = inputs
    archive = tmp_path/"bad.zip"
    members = deepcopy(files)
    if bad.startswith("Package/") and bad not in ("Package/../escape.py", "Package/app\\data\\runtime\\r2.sqlite"):
        members[bad.removeprefix("Package/")] = b"SQLite format 3\x00payload" if bad.endswith("disguised.bin") else b"unsafe"
        expected, _ = write_base(archive, members)
    else:
        expected, _ = write_base(archive, members, extra=[(bad,b"unsafe")])
    with pytest.raises(RuntimeError):
        release.build_release(base_zip=archive, frontend_dist=dist, output_dir=tmp_path/"bad-output", expected_base_sha256=expected)
    assert not (tmp_path/"bad-output").exists()


@pytest.mark.parametrize("kind", ["duplicate", "case-collision", "wrong-digest", "missing-listed", "unlisted", "symlink", "wrong-content-version"])
def test_manifest_and_member_integrity_are_independently_verified(inputs, kind):
    release, tmp_path, _, _, files, _, dist = inputs
    archive = tmp_path/"integrity.zip"
    members = deepcopy(files)
    options = {}
    if kind == "duplicate":
        options["extra"] = [("Package/launcher.py",members["launcher.py"])]
    elif kind == "case-collision":
        members["Launcher.py"] = b"collision"
    elif kind == "wrong-digest":
        options["wrong_member"] = "launcher.py"
    elif kind == "missing-listed":
        # 清单仍列出源文件，实际ZIP删除该成员。
        expected, old = write_base(archive, members)
        missing = tmp_path/"missing.zip"
        with zipfile.ZipFile(archive) as source, zipfile.ZipFile(missing,"x") as target:
            for info in source.infolist():
                if info.filename != "Package/launcher.py":
                    target.writestr(info,source.read(info))
        archive = missing
        expected = sha(archive.read_bytes())
    elif kind == "unlisted":
        options["extra"] = [("Package/extra.py",b"extra")]
    elif kind == "symlink":
        options["link"] = "launcher.py"
    else:
        options["manifest_patch"] = {"content_snapshot_sha256":"0"*64}
    if kind != "missing-listed":
        if kind == "duplicate":
            with pytest.warns(UserWarning,match="Duplicate name"):
                expected, _ = write_base(archive,members,**options)
        else:
            expected, _ = write_base(archive,members,**options)
    with pytest.raises(RuntimeError):
        release.build_release(base_zip=archive, frontend_dist=dist, output_dir=tmp_path/"invalid-output", expected_base_sha256=expected)
    assert not (tmp_path/"invalid-output").exists()


def test_new_dist_rejects_public_copy_database_and_missing_closure(inputs):
    release, tmp_path, _, _, _, _, dist = inputs
    (dist/"maps").mkdir()
    (dist/"maps/copied.pbf").write_bytes(b"not a compiled asset")
    with pytest.raises(RuntimeError,match="不允许复制public资源"):
        build(inputs)
    (dist/"maps/copied.pbf").unlink()
    (dist/"assets/unexpected.sqlite").write_bytes(b"db")
    with pytest.raises(RuntimeError,match="数据库"):
        build(inputs)
    (dist/"assets/unexpected.sqlite").unlink()
    (dist/"assets/lazy.js").unlink()
    with pytest.raises(RuntimeError,match="闭包缺失"):
        build(inputs)
    assert not (tmp_path/"new-release").exists()


def runtime_repo(tmp_path, files):
    root = tmp_path / "repository"
    for relative, value in files.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(value)
    return root


def test_explicit_python_runtime_overlay_and_new_helper_are_hashed_and_other_payload_preserved(inputs):
    release, tmp_path, _, _, files, _, _ = inputs
    code = {"algorithm-service/app/fault.py": b"updated_fault=True\n",
            "algorithm-service/app/fault_catalog.py": b"new_catalog=True\n",
            "scripts/diagnosis/sr5.py": b"new_diagnosis=True\n"}
    repo = runtime_repo(tmp_path, code)
    metadata = build(inputs, runtime_sources=list(code), project_root=repo)
    assert metadata["release_scope"] == ["FRONTEND_COMPILED", "EXPLICIT_RUNTIME_SOURCES"]
    assert metadata["runtime_source_overlays"] == sorted("app/"+name for name in code)
    with zipfile.ZipFile(metadata["zip"]) as archive:
        for relative, content in code.items():
            path = "app/"+relative
            assert archive.read("Package/"+path) == content
            assert metadata["runtime_source_sha256"][path] == sha(content)
        assert archive.read("Package/runtime/python/python.exe") == files["runtime/python/python.exe"]
        assert archive.read("Package/用户手册/用户手册.pdf") == files["用户手册/用户手册.pdf"]
    assert "app/algorithm-service/app/fault.py" in metadata["files"]["changed"]
    assert "app/algorithm-service/app/fault_catalog.py" in metadata["files"]["added"]
    assert metadata["changes"]["ordered_updates"][-2:] == [release.INDEX, release.MANIFEST]


@pytest.mark.parametrize("relative", ["scripts/other.py", "algorithm-service/migrations/0024.py", "algorithm-service/app/config.py",
    "algorithm-service/app/data/input.py", "algorithm-service/app/runtime/state.py", "algorithm-service/app/database.py",
    "algorithm-service/app/node_modules/dependency.py", "algorithm-service/app/fault.sqlite", "../escape.py", "C:/fault.py", "algorithm-service\\app\\fault.py"])
def test_runtime_source_rejects_non_python_configuration_database_dependency_and_escape(inputs, relative):
    release, tmp_path, _, _, _, _, _ = inputs
    with pytest.raises(RuntimeError):
        build(inputs, runtime_sources=[relative], project_root=tmp_path/"missing-source")
    assert not (tmp_path/"new-release").exists()


def test_runtime_source_rejects_duplicates_links_and_changes_during_copy(inputs, monkeypatch):
    release, tmp_path, base, expected, _, _, _ = inputs
    relative = "algorithm-service/app/fault.py"
    repo = runtime_repo(tmp_path, {relative: b"first_content=True\n"})
    with pytest.raises(RuntimeError, match="重复"):
        build(inputs, runtime_sources=[relative, relative], project_root=repo)
    original_link = Path.is_symlink
    monkeypatch.setattr(Path, "is_symlink", lambda path: path == repo/relative or original_link(path))
    with pytest.raises(RuntimeError, match="链接"):
        build(inputs, runtime_sources=[relative], project_root=repo)
    monkeypatch.setattr(Path, "is_symlink", original_link)
    original_closure = release.verify_closure
    def mutate_after_validation(*args, **kwargs):
        result = original_closure(*args, **kwargs)
        (repo/relative).write_bytes(b"changed_during_copy=True\n")
        return result
    monkeypatch.setattr(release, "verify_closure", mutate_after_validation)
    with pytest.raises(RuntimeError, match="复制期间成员内容变化"):
        build(inputs, runtime_sources=[relative], project_root=repo)
    assert not (tmp_path/"new-release"/release.PACKAGE_NAME).exists()
    assert sha(base.read_bytes()) == expected


def test_fixed_examples_are_verbatim_primary_guide_is_replaced_and_legacy_attachments_remain(inputs):
    release, _, _, _, original, _, _ = inputs
    source = release.PROJECT / "docs/output/系统例程导入数据.zip"
    metadata = build(inputs, example_zip=source)
    examples = metadata["example_materials"]
    assert metadata["release_scope"] == ["FRONTEND_COMPILED", "FIXED_CONTROLLED_EXAMPLES"]
    assert examples["zip_sha256"] == release.EXAMPLE_SHA256 and examples["file_count"] == 22
    assert examples["entry"] == release.EXAMPLE_ENTRY
    with zipfile.ZipFile(source) as material, zipfile.ZipFile(metadata["zip"]) as archive:
        for name in material.namelist():
            assert archive.read("Package/"+name) == material.read(name)
            assert examples["files"][name] == sha(material.read(name))
        assert archive.read("Package/"+release.LEGACY_GUIDE) == original[release.PRIMARY_GUIDE]
        assert archive.read("Package/首次使用演示/old-example.csv") == original["首次使用演示/old-example.csv"]
        primary = archive.read("Package/"+release.PRIMARY_GUIDE).decode("utf-8")
        assert './'+release.EXAMPLE_ENTRY in primary and './'+release.LEGACY_GUIDE in primary
    assert metadata["changes"]["ordered_updates"][-3:] == [release.PRIMARY_GUIDE, release.INDEX, release.MANIFEST]


def test_fixed_examples_reject_other_zip_even_if_it_has_valid_files(inputs):
    release, tmp_path, base, _, _, _, _ = inputs
    with pytest.raises(RuntimeError, match="固定受控例程ZIP"):
        build(inputs, example_zip=base)
    assert not (tmp_path/"new-release").exists()


def test_runtime_and_fixed_examples_can_be_explicitly_combined_in_one_complete_package(inputs):
    release, tmp_path, _, _, original, _, _ = inputs
    relative = "algorithm-service/app/fault.py"
    repo = runtime_repo(tmp_path, {relative:b"authorized_fault_change=True\n"})
    metadata = build(inputs, runtime_sources=[relative], project_root=repo,
                     example_zip=release.PROJECT/"docs/output/系统例程导入数据.zip")
    assert metadata["release_scope"] == ["FRONTEND_COMPILED", "EXPLICIT_RUNTIME_SOURCES", "FIXED_CONTROLLED_EXAMPLES"]
    with zipfile.ZipFile(metadata["zip"]) as archive:
        manifest = json.loads(archive.read("Package/"+release.MANIFEST))
        for name, expected in manifest["files"].items():
            assert sha(archive.read("Package/"+name)) == expected
        assert archive.read("Package/"+release.LEGACY_GUIDE) == original[release.PRIMARY_GUIDE]
        assert archive.read("Package/app/algorithm-service/app/main.py") == original["app/algorithm-service/app/main.py"]
        assert archive.read("Package/runtime/python/python.exe") == original["runtime/python/python.exe"]
    assert metadata["changes"]["ordered_updates"][-3:] == [release.PRIMARY_GUIDE,release.INDEX,release.MANIFEST]


def document_repo(release, tmp_path):
    # 仅隔离装配夹具：不是可使用的Word/PDF，不写项目canonical文档。
    values = {relative: ("fixture-public-"+relative).encode("utf-8") for relative in release.DOCUMENT_MAP}
    values["docs/output/测试用例_保留.docx"] = b"must-not-ship-test-document"
    values["docs/input/original.docx"] = b"must-not-ship-input-document"
    return runtime_repo(tmp_path, values), values


def test_explicit_document_refresh_copies_exact_four_canonical_bytes_and_preserves_program(inputs):
    release, tmp_path, _, _, original, _, _ = inputs
    repo, values = document_repo(release, tmp_path)
    metadata = build(inputs, refresh_documents=True, project_root=repo)
    assert metadata["release_scope"] == ["FRONTEND_COMPILED", "CANONICAL_DOCUMENTS"]
    assert metadata["document_overlays"] == sorted(release.DOCUMENT_MAP.values())
    assert metadata["document_source_paths"] == {destination: relative for relative,destination in release.DOCUMENT_MAP.items()}
    with zipfile.ZipFile(metadata["zip"]) as archive:
        manifest = json.loads(archive.read("Package/"+release.MANIFEST))
        for relative, destination in release.DOCUMENT_MAP.items():
            assert archive.read("Package/"+destination) == values[relative]
            assert manifest["files"][destination] == metadata["document_overlay_sha256"][destination] == sha(values[relative])
        assert archive.read("Package/runtime/python/python.exe") == original["runtime/python/python.exe"]
        assert archive.read("Package/app/algorithm-service/app/main.py") == original["app/algorithm-service/app/main.py"]
        assert not any("测试用例" in name or "/docs/input/" in name for name in archive.namelist())
        assert len(archive.namelist()) == len(set(archive.namelist()))
    assert set(release.DOCUMENT_MAP.values()) <= set(metadata["files"]["changed"]+metadata["files"]["added"])


def test_default_does_not_read_canonical_document_sources(inputs, monkeypatch):
    release, _, _, _, _, _, _ = inputs
    def forbidden(*args, **kwargs):
        pytest.fail("默认发行不得读取待完成的canonical文档")
    monkeypatch.setattr(release, "document_source_files", forbidden)
    metadata = build(inputs)
    assert metadata["document_overlays"] == []


def test_refresh_after_complete_program_release_changes_only_four_document_targets(inputs):
    release, tmp_path, base, expected, _, _, dist = inputs
    repo, _ = document_repo(release, tmp_path)
    relative = "algorithm-service/app/fault.py"
    source = repo/relative
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"complete_authorized_program=True\n")
    arguments = dict(base_zip=base, expected_base_sha256=expected, frontend_dist=dist,
                     runtime_sources=[relative], project_root=repo, version_date="20261103",
                     example_zip=release.PROJECT/"docs/output/系统例程导入数据.zip")
    program = release.build_release(output_dir=tmp_path/"complete-program", **arguments)
    final = release.build_release(output_dir=tmp_path/"complete-program-with-docs", refresh_documents=True, **arguments)
    with zipfile.ZipFile(program["zip"]) as before, zipfile.ZipFile(final["zip"]) as after:
        previous = json.loads(before.read("Package/"+release.MANIFEST))["files"]
        latest = json.loads(after.read("Package/"+release.MANIFEST))["files"]
        changes = {name for name in previous.keys() | latest.keys() if previous.get(name) != latest.get(name)}
        assert changes == set(release.DOCUMENT_MAP.values())
        for name in previous.keys()-set(release.DOCUMENT_MAP.values()):
            assert after.read("Package/"+name) == before.read("Package/"+name)
    assert final["controlled_version"] != program["controlled_version"]
    assert final["release_scope"] == ["FRONTEND_COMPILED", "EXPLICIT_RUNTIME_SOURCES", "FIXED_CONTROLLED_EXAMPLES", "CANONICAL_DOCUMENTS"]


def test_document_refresh_rejects_missing_linked_and_changing_sources(inputs, monkeypatch):
    release, tmp_path, base, expected, _, _, _ = inputs
    with pytest.raises(RuntimeError, match="缺失或越界"):
        build(inputs, refresh_documents=True, project_root=tmp_path/"missing-documents")
    repo, _ = document_repo(release, tmp_path)
    source = repo / next(iter(release.DOCUMENT_MAP))
    original_link = Path.is_symlink
    monkeypatch.setattr(Path,"is_symlink",lambda path:path==source or original_link(path))
    with pytest.raises(RuntimeError, match="链接"):
        build(inputs, refresh_documents=True, project_root=repo)
    monkeypatch.setattr(Path,"is_symlink",original_link)
    original_closure = release.verify_closure
    def mutate_after_hash(*args, **kwargs):
        result = original_closure(*args, **kwargs)
        source.write_bytes(b"fixture-document-changed-during-build")
        return result
    monkeypatch.setattr(release,"verify_closure",mutate_after_hash)
    with pytest.raises(RuntimeError, match="复制期间成员内容变化"):
        build(inputs, refresh_documents=True, project_root=repo)
    assert not (tmp_path/"new-release"/release.PACKAGE_NAME).exists()
    assert sha(base.read_bytes()) == expected


@pytest.mark.parametrize("kind", ["escape", "private", "case-duplicate", "bad-digest", "unlisted", "wrong-entry"])
def test_example_catalog_checks_path_duplicates_and_every_registered_digest(tmp_path, kind):
    release = module()
    payload = {"导入使用指南.html": b"guide", **{f"file-{i:02d}.txt": b"public" for i in range(20)}}
    if kind == "escape":
        payload["../escape.txt"] = payload.pop("file-19.txt")
    elif kind == "private":
        payload["runtime/settings.json"] = payload.pop("file-19.txt")
    elif kind == "case-duplicate":
        payload["FILE-00.TXT"] = payload.pop("file-19.txt")
    registered = [{"path": path,"bytes":len(value),"sha256":"0"*64 if kind == "bad-digest" else sha(value)} for path,value in payload.items()]
    if kind == "unlisted":
        registered.pop()
    catalog = {"start":"other.html" if kind == "wrong-entry" else "导入使用指南.html", "files":registered}
    source = tmp_path / "examples.zip"
    with zipfile.ZipFile(source,"x") as archive:
        for relative, value in payload.items():
            archive.writestr(release.EXAMPLE_PREFIX+relative,value)
        archive.writestr(release.EXAMPLE_CATALOG,json.dumps(catalog,ensure_ascii=False).encode())
    with zipfile.ZipFile(source) as archive, pytest.raises(RuntimeError):
        release.validate_example_archive(archive)

"""回归Windows临时占用；失败时必须保留原有效快照。"""
from pathlib import Path
import sys
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'algorithm-service'))
from app import runtime_store


def test_temporary_windows_lock_preserves_old_snapshot_until_atomic_replace(monkeypatch, tmp_path):
    target = tmp_path / 'state.json'
    runtime_store.write_json(target, {'revision': 1})
    original = Path.replace
    waits = []
    attempts = []
    def replace(source, dest):
        attempts.append(source)
        if len(attempts) < 3:
            assert runtime_store.read_json(target) == {'revision': 1}
            error = PermissionError('目标暂时占用')
            error.winerror = 32
            raise error
        return original(source, dest)
    monkeypatch.setattr(Path, 'replace', replace)
    monkeypatch.setattr(runtime_store.time, 'sleep', waits.append)
    runtime_store.write_json(target, {'revision': 2})
    assert runtime_store.read_json(target) == {'revision': 2}
    assert waits == [.01, .02]
    assert len(attempts) == 3 and len(set(attempts)) == 1


@pytest.mark.parametrize('winerror', [5, 32, 33, None])
def test_persistent_lock_is_bounded_and_preserves_original(monkeypatch, tmp_path, winerror):
    target = tmp_path / 'state.json'
    runtime_store.write_json(target, {'revision': 1})
    calls = []
    def blocked(source, dest):
        calls.append(source)
        error = PermissionError('禁止替换')
        if winerror is not None:
            error.winerror = winerror
        raise error
    monkeypatch.setattr(Path, 'replace', blocked)
    monkeypatch.setattr(runtime_store.time, 'sleep', lambda _: None)
    with pytest.raises(PermissionError):
        runtime_store.write_json(target, {'revision': 2})
    assert len(calls) == (1 if winerror is None else 5)
    assert runtime_store.read_json(target) == {'revision': 1}

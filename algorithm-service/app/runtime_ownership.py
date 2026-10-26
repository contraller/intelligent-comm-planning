"""运行目录的进程级排他锁；锁文件保留，不以PID文件猜测进程是否退出。"""
from contextlib import contextmanager
import os
from pathlib import Path


@contextmanager
def exclusive_runtime_directory(directory):
    root = Path(directory).resolve()
    root.mkdir(parents=True, exist_ok=True)
    path = root / 'interference-worker.lock'
    if path.is_symlink() or path.resolve().parent != root:
        raise RuntimeError('运行目录锁路径不安全')
    handle = path.open('a+b')
    locked = False
    try:
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except OSError as exc:
            raise RuntimeError('该运行目录已被占用或不支持排他锁，未启动调度和恢复') from exc
        if handle.seek(0, os.SEEK_END) == 0:
            handle.write(b'\x00')
            handle.flush()
        yield
    finally:
        if locked:
            handle.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()

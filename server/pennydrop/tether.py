from __future__ import annotations

import contextlib
import os
import signal
import subprocess
import sys
import threading
from collections.abc import Iterator

TERMINATE_GRACE_SECONDS = 5


def tethered_argv(argv: list[str]) -> list[str]:
    return [sys.executable, "-m", "pennydrop.tether", *argv]


@contextlib.contextmanager
def lifeline() -> Iterator[int]:
    read, write = os.pipe()
    try:
        yield read
    finally:
        os.close(read)
        os.close(write)


def _stop(child: subprocess.Popen) -> None:
    if child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(TERMINATE_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        child.kill()


def _stop_when_parent_is_gone(child: subprocess.Popen) -> None:
    while os.read(sys.stdin.fileno(), 4096):
        pass
    _stop(child)


def main(argv: list[str]) -> int:
    try:
        child = subprocess.Popen(argv)
    except OSError as error:
        print(f"tether: cannot run {argv[0]}: {error}", file=sys.stderr)
        return 127
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, lambda *_: _stop(child))
    threading.Thread(target=_stop_when_parent_is_gone, args=(child,), daemon=True).start()
    return child.wait()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

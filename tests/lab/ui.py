"""Run with: uv run --with pexpect --with pyte tests/lab/ui.py LAB_DIR [v1|v2] [IMAGE]."""
import json
import os
from pathlib import Path
import sys
import time

import pexpect
import pyte

root = Path(sys.argv[1]) / "runtime"
version = sys.argv[2] if len(sys.argv) > 2 else "v2"
image = sys.argv[3] if len(sys.argv) > 3 else "dcp-lab:2.0.4"
scenario = f"{version}-http-range"
folder = root / scenario
session = json.loads((folder / "result.json").read_text())["sessions"][0]
home = f"/lab/{scenario}"
args = ["run", "--rm", "--init", "-it", "--user", f"{os.getuid()}:{os.getgid()}",
        "--mount", f"type=bind,source={root},target=/lab", "--workdir", f"{home}/project"]
env = {"HOME": home, "PWD": f"{home}/project", "TERM": "xterm-256color", "COLORTERM": "truecolor",
       "XDG_CONFIG_HOME": f"{home}/config", "XDG_DATA_HOME": f"{home}/data", "XDG_STATE_HOME": f"{home}/state",
       "XDG_CACHE_HOME": f"{home}/cache", "OPENCODE_CONFIG_DIR": f"{home}/config/opencode", "LAB_API_KEY": "lab"}
for key, value in env.items():
    args.extend(["-e", f"{key}={value}"])
args.extend([image, f"/opt/{version}/node_modules/.bin/{'opencode2' if version == 'v2' else 'opencode'}"])
if version == "v2":
    args.append("--standalone")
args.extend(["--session", session])
child = pexpect.spawn("docker", args, encoding="utf-8", codec_errors="replace", dimensions=(60, 130), timeout=1)
screen = pyte.Screen(130, 60)
stream = pyte.Stream(screen)
frames = {}
raw = open(folder / "ui.tty", "w")

def pump():
    try:
        text = child.read_nonblocking(65536, timeout=0.2)
    except pexpect.TIMEOUT:
        return False
    raw.write(text)
    raw.flush()
    stream.feed(text)
    if "\x1b[6n" in text:
        child.send("\x1b[1;1R")
    if "\x1b[c" in text:
        child.send("\x1b[?1;2c")
    return True

def wait(check, label):
    until = time.monotonic() + 30
    while time.monotonic() < until:
        # A frame can span several reads; wait for rendering to settle before clicking.
        if not pump() and check():
            frames[label] = screen.display.copy()
            return
    raise AssertionError(f"Timed out: {label}\n" + "\n".join(screen.display))

def visible(text):
    return any(text in line for line in screen.display)

def click(text):
    wait(lambda: visible(text), f"ready-{text}")
    for row, line in reversed(list(enumerate(screen.display))):
        if text in line:
            col = line.index(text) + 1
            child.send(f"\x1b[<0;{col};{row+1}M\x1b[<0;{col};{row+1}m")
            return
    raise AssertionError(f"Not visible: {text}")

def footer_row():
    for row, line in reversed(list(enumerate(screen.display))):
        if "close" in line:
            return row
    raise AssertionError("Dialog footer is outside the terminal")

def scroll_to(text, label, direction="down", back=False):
    until = time.monotonic() + 30
    while time.monotonic() < until:
        if pump():
            continue
        footer = footer_row()
        if back:
            assert "back" in screen.display[footer], "Back button is outside the terminal"
        # Ignore matching text in the session/sidebar behind the dialog.
        header = next(row for row, line in enumerate(screen.display[:footer]) if "esc" in line)
        if any(text in line for line in screen.display[header + 1:footer]):
            frames[label] = screen.display.copy()
            return
        col = screen.columns // 2
        row = (header + footer) // 2 + 1
        button = 65 if direction == "down" else 64
        child.send(f"\x1b[<{button};{col};{row}M")
    raise AssertionError(f"Could not scroll to {text}\n" + "\n".join(screen.display))

def resize(rows):
    screen.resize(lines=rows, columns=130)
    child.setwinsize(rows, 130)
    wait(lambda: visible("close"), f"resized-{rows}")

def check_scroll(rows):
    resize(rows)
    scroll_to("Compression command", f"panel-bottom-{rows}")
    scroll_to("Views", f"panel-top-{rows}", direction="up")
    scroll_to("Context", f"context-action-{rows}")
    click("Context")
    wait(lambda: visible("back"), f"context-open-{rows}")
    scroll_to("Tools (", f"context-bottom-{rows}", back=True)
    click("back")
    wait(lambda: not visible("back"), f"context-back-{rows}")
    scroll_to("Stats", f"stats-action-{rows}")
    click("Stats")
    wait(lambda: visible("back"), f"stats-open-{rows}")
    scroll_to("Sessions with DCP", f"stats-bottom-{rows}", back=True)
    click("back")
    wait(lambda: not visible("back"), f"stats-back-{rows}")
    resize(60)
    wait(lambda: visible("Views") and visible("Compression command"), f"full-panel-{rows}")

state_file = folder / "data/opencode/storage/plugin/dcp" / f"{session}.json"
def manual():
    return json.loads(state_file.read_text())["manualMode"]

try:
    wait(lambda: visible("MOCK_OK"), "session")
    child.send("/dcp")
    wait(lambda: visible("/dcp"), "typed")
    if version == "v2":
        wait(lambda: visible("Open DCP panel"), "registered")
    child.send("\r")
    if version == "v2":
        # Argument-taking slashes first complete the name; submitting then runs it.
        wait(lambda: not visible("Open DCP panel"), "completed")
        child.send("\r")
    wait(lambda: visible("Session State"), "panel")
    click("Context")
    wait(lambda: visible("Total in context") and visible("Breakdown"), "context")
    click("back")
    wait(lambda: visible("Session State"), "panel-back")
    click("Stats")
    wait(lambda: visible("Compression ratio") and visible("All time"), "stats")
    click("back")
    wait(lambda: visible("Manual mode"), "manual")
    initial = manual()
    click("■")
    wait(lambda: manual() != initial, "toggled")
    for rows in [43, 20]:
        check_scroll(rows)
    child.send("\x1b")
    wait(lambda: not visible("Session State"), "closed")
    print(json.dumps({"version": version, "image": image, "panel": True, "context": True, "stats": True, "manual": True, "scroll": True, "resize": True, "close": True}))
finally:
    (folder / "ui.frames.json").write_text(json.dumps(frames, indent=2))
    child.sendcontrol("c")
    child.sendcontrol("c")
    try:
        child.expect(pexpect.EOF, timeout=10)
    except pexpect.TIMEOUT:
        child.terminate(force=True)
    raw.close()

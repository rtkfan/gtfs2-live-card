#!/usr/bin/env python3
"""Photograph the stop card, page by page, from stop-harness.html.

Same machinery as shots.py (Chrome over DevTools, repo served over HTTP),
against docs/stop-harness.html: one gtfs2 local-stop sensor per the live
attribute shape, and a frozen positions file whose trip_ids join the board.

    python docs/stop_shots.py              every page, light and dark
    python docs/stop_shots.py board map    only those pages

Requires websocket-client: pip install websocket-client (or run under uv).
"""

import base64
import json
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import shots  # noqa: E402  (Chrome, serve, READY_TIMEOUT)

ROOT = HERE.parent
OUT = ROOT / "images" / "stop"
OUT.mkdir(parents=True, exist_ok=True)

# Edge headless drives Chrome's DevTools protocol fine (Page.captureScreenshot
# included); shots.py only bans it for its one-shot --screenshot mode, which
# this driver does not use. A Chrome install wins if it is there.
import os
_EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if os.path.exists(_EDGE):
    shots.CHROME_CANDIDATES.append(_EDGE)

PAGES = {
    "board":  (470, 900),
    "map":    (470, 900),
    "both":   (470, 1100),
    "nearby": (470, 900),
}

REPORT = """(() => {
  const cards = [...document.querySelectorAll("gtfs2-stop-card")].map((c) => c.shadowRoot);
  const n = (sel) => cards.reduce((s, r) => s + (r ? r.querySelectorAll(sel).length : 0), 0);
  return JSON.stringify({ errors: (document.getElementById("fatal").textContent || "").trim(),
    rows: n(".row"), badges: n(".mini-badge,.row-badge"), stops: n(".stop"),
    buses: n(".bus"), tables: n("table") });
})()"""


def shoot(chrome, port, page, mode, lang, size, scale, out, moving=False, settle=0):
    w, h = size
    url = (f"http://127.0.0.1:{port}/docs/stop-harness.html"
           f"?page={page}&mode={mode}&lang={lang}"
           + ("&moving=1" if moving else "") + (f"&settle={settle}" if settle else ""))
    tab = chrome.tab()
    try:
        tab.viewport(w, h, scale)
        tab.call("Page.navigate", url=url)
        deadline = time.time() + shots.READY_TIMEOUT
        m = None
        while time.time() < deadline:
            m = re.match(r"(ready|late) (\d+)x(\d+) ", tab.eval("document.title") or "")
            if m:
                break
            time.sleep(0.2)
        if not m:
            raise SystemExit(f"{page}/{mode}: harness never said ready "
                             f"(title: {tab.eval('document.title')!r}, "
                             f"errors: {tab.eval('document.getElementById(\"fatal\").textContent')!r})")
        hh = int(m.group(3))
        if hh != h:
            tab.viewport(w, hh, scale)
            time.sleep(0.4)
        data = tab.call("Page.captureScreenshot", format="png")["data"]
        out.write_bytes(base64.b64decode(data))
        report = json.loads(tab.eval(REPORT))
    finally:
        tab.close()
    return (w, hh), out.stat().st_size, report


def main():
    ap = shots.argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pages", nargs="*", help=f"pages to shoot (default: all of {', '.join(PAGES)})")
    ap.add_argument("--lang", default="en")
    ap.add_argument("--scale", type=float, default=2.0)
    ap.add_argument("--moving", action="store_true", help="let the fixture's buses move (?moving=1)")
    ap.add_argument("--settle", type=int, default=0, help="seconds to wait past ready (?settle=N)")
    ap.add_argument("--out", default=None, help="output filename stem (default stop-<page>)")
    args = ap.parse_args()
    pages = args.pages or list(PAGES)
    for p in pages:
        if p not in PAGES:
            raise SystemExit(f"unknown page {p!r}; known: {', '.join(PAGES)}")
    httpd, port = shots.serve(ROOT)
    chrome = shots.Chrome(shots.find_chrome())
    print(f"chrome: devtools on 127.0.0.1:{chrome.port}")
    try:
        for page in pages:
            for mode in ("light", "dark"):
                stem = args.out or f"stop-{page}"
                size, written, report = shoot(chrome, port, page, mode, args.lang,
                                              PAGES[page], args.scale,
                                              OUT / f"{stem}-{mode}.png",
                                              moving=args.moving, settle=args.settle)
                print(f"{page}/{mode}: {size[0]}x{size[1]} {written} B  {report}")
    finally:
        chrome.close()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""A minimal external UI: open a library card, send one line, print the streamed reply."""

import argparse
import json
import subprocess
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("card", help="character ID in library/characters")
    parser.add_argument("text", help="your message")
    parser.add_argument("--home", help="rp-core home (default: RP_CORE_HOME or ~/.rp-core)")
    parser.add_argument("--provider", help="optional script:/record:/replay: provider for this run")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    command = ["bun", str(root / "src/cli/main.ts"), "--stdio"]
    if args.home:
        command += ["--home", args.home]
    if args.provider:
        command += ["--provider", args.provider]

    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    next_id = 0
    events = []

    def read_frame():
        line = child.stdout.readline()
        if not line:
            raise RuntimeError(f"rp-core exited before replying (code {child.poll()})")
        return json.loads(line)

    def request(method, params=None):
        nonlocal next_id
        next_id += 1
        child.stdin.write(json.dumps({"jsonrpc": "2.0", "id": next_id, "method": method, "params": params or {}}) + "\n")
        child.stdin.flush()
        while True:
            frame = read_frame()
            if frame.get("method") == "event":
                events.append(frame["params"])
            elif frame.get("id") == next_id:
                if "error" in frame:
                    raise RuntimeError(f"{method}: {frame['error']}")
                return frame["result"]

    try:
        request("initialize", {"protocol": 1, "client": {"name": "stdio-demo", "version": "1"}})
        created = request("session/new", {"character": args.card})
        session_id = created["sessionId"]
        print(f"session: {session_id}", file=sys.stderr)
        admitted = request("turn/submit", {
            "sessionId": session_id, "text": args.text,
            "expectedVersion": created["snapshot"]["version"],
        })
        turn_id = admitted["turnId"]
        printed = False
        while True:
            event = events.pop(0) if events else read_frame().get("params", {})
            if event.get("turnId") != turn_id:
                continue
            if event.get("type") == "text":
                print(event["delta"], end="", flush=True)
                printed = True
            if event.get("type") in {"done", "stopped", "failed", "conflict"}:
                if not printed and event.get("message"):
                    print("".join(block.get("text", "") for block in event["message"]["blocks"] if block.get("k") == "text"), end="")
                print()
                if event["type"] in {"failed", "conflict"}:
                    print(f"turn ended: {event['type']}", file=sys.stderr)
                break
        request("shutdown")
        return child.wait()
    finally:
        if child.poll() is None:
            child.stdin.close()
            child.wait()


if __name__ == "__main__":
    raise SystemExit(main())

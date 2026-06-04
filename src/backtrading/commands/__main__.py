"""CLI: python -m backtrading"""

from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="backtrading", description="Backtrading operator CLI")
    sub = parser.add_subparsers(dest="command")

    cp = sub.add_parser("control-plane", help="Print control plane URL")
    cp.add_argument("--port", type=int, default=8000)

    live = sub.add_parser("live-engine", help="Print live engine module hint")
    live.add_argument("--fake", action="store_true")

    args = parser.parse_args(argv)
    if args.command == "control-plane":
        print(f"Run: uvicorn api.server:app --host 0.0.0.0 --port {args.port}")
        return 0
    if args.command == "live-engine":
        flag = " --fake" if args.fake else ""
        print(f"Run: python -m api.live_server{flag}")
        return 0
    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())

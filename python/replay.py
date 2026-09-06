"""Inspect, run and verify portable episodes without a graphics context."""

import argparse
import json
import math
import sys
from pathlib import Path
from episode_runtime import Runtime, load, save, verify


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("inspect", "run", "verify"):
        p = sub.add_parser(name)
        p.add_argument("episode", type=Path)
        if name == "run":
            p.add_argument("commands", type=Path)
            p.add_argument("-o", "--output", required=True, type=Path)
        if name == "verify":
            p.add_argument(
                "--mode", choices=["continuous", "operation"], default="continuous"
            )
            p.add_argument("--atol", type=float, default=0)
            p.add_argument("--rtol", type=float, default=0)
    args = parser.parse_args()
    stage = "archive"
    try:
        ep = load(args.episode)
        stage = "runtime"
        if args.command == "verify":
            if (
                not math.isfinite(args.atol)
                or not math.isfinite(args.rtol)
                or args.atol < 0
                or args.rtol < 0
            ):
                raise ValueError("Tolerances must be finite and nonnegative")
            report = verify(ep, args.mode, args.atol, args.rtol)
        else:
            runtime = Runtime(ep)
            if args.command == "run":
                for line in args.commands.read_text().splitlines():
                    if not line.strip():
                        continue
                    c = json.loads(line)
                    runtime.cancel_at_step = c.get("cancel_at_step")
                    try:
                        runtime.execute(
                            c["name"], c.get("arguments", {}), c.get("actor", "agent")
                        )
                    except Exception:
                        # A command failure is part of the episode; retain subsequent attempts.
                        if runtime.m["lifecycle"] == "ended":
                            raise
                save(runtime.episode, args.output)
                report = dict(
                    status="passed",
                    output=str(args.output),
                    calls=len(runtime.episode.get("calls", [])),
                )
            else:
                error = 0.0
                for frame in [ep["initial"], *ep["states"], *ep["trajectory"]]:
                    runtime.restore(frame)
                    actual = runtime.snapshot()["integration"]
                    error = max(
                        error,
                        max(
                            (abs(a - b) for a, b in zip(frame["integration"], actual)),
                            default=0,
                        ),
                    )
                report = dict(
                    status="passed" if error == 0 else "diverged",
                    engine=runtime.m["engine"],
                    lifecycle=runtime.m["lifecycle"],
                    calls=len(ep.get("calls", [])),
                    states=len(ep["states"]),
                    physics_frames=sum(
                        f["phase"] == "physics" for f in ep["trajectory"]
                    ),
                    max_restore_error=error,
                    capabilities=runtime.capabilities,
                )
    except Exception as e:
        report = dict(
            status="incompatible"
            if stage == "archive"
            or any(
                x in str(e).lower()
                for x in ("layout", "contract", "schema", "incompatible", "capability")
            )
            else "failed",
            failureKind="invalid_archive"
            if stage == "archive"
            else "capability"
            if "capability" in str(e).lower()
            else "invalid_archive"
            if any(
                x in str(e).lower()
                for x in ("schema", "checksum", "archive", "frame", "event")
            )
            else "execution",
            error=str(e),
        )
    print(json.dumps(report, allow_nan=False))
    return {"passed": 0, "diverged": 2, "incompatible": 3, "failed": 4}[
        report["status"]
    ]


if __name__ == "__main__":
    sys.exit(main())

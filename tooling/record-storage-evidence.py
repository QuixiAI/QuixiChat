#!/usr/bin/env python3
"""Summarize actual Playwright reports without treating skipped checks as passes."""
import argparse
import base64
from datetime import datetime, timezone
import json
from pathlib import Path
import platform

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--browser", action="append", required=True, metavar="HOST=REPORT_JSON")
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()


def cases(suites):
    for suite in suites:
        for spec in suite.get("specs", []):
            for test in spec["tests"]:
                results = []
                for run in test["results"]:
                    attachments = {}
                    for item in run.get("attachments", []):
                        if item["contentType"] == "application/json" and "body" in item:
                            attachments[item["name"]] = json.loads(base64.b64decode(item["body"]))
                    results.append({
                        "status": run["status"], "durationMs": run["duration"],
                        "errors": run.get("errors", []), "attachments": attachments,
                    })
                yield {
                    "file": spec["file"], "title": spec["title"],
                    "project": test["projectName"], "status": test["status"],
                    "annotations": test.get("annotations", []), "results": results,
                }
        yield from cases(suite.get("suites", []))


report = {
    "schemaVersion": 1, "recordedAt": datetime.now(timezone.utc).isoformat(),
    "recordingPlatform": platform.platform(),
    "sqliteDistribution": json.loads((ROOT / "packages/storage/sqlite/artifacts.json").read_text()),
    "runs": [],
    "limitations": "Reports establish only the named tests in the recorded engines and contexts. Skipped checks, installed Safari, other OS/WebViews, eviction, and product-scale workloads require separate evidence.",
}
failed = False
for argument in args.browser:
    host, path = argument.split("=", 1)
    source = json.loads(Path(path).read_text())
    report["runs"].append({"host": host, "stats": source["stats"], "tests": list(cases(source["suites"]))})
    failed |= bool(source["stats"]["unexpected"] or source.get("errors"))
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(report, indent=2) + "\n")
print(f"Recorded {len(report['runs'])} host reports in {args.output}")
raise SystemExit(1 if failed else 0)

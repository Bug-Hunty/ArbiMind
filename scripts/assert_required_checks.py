#!/usr/bin/env python3
"""Require successful, executed Actions steps from the exact PR head.

Workflow path + job name identifies evidence. Check names alone are ambiguous:
CI/test failed its audit on 6b7cfd2 while Bot Tests/test passed, and the old
assertion incorrectly returned success. Skipped/neutral and stale attempts are
not evidence. A workflow rerun must rerun all of its required jobs.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
import re
import subprocess
import sys
import time


@dataclass(frozen=True)
class Requirement:
    workflow: str
    job: str
    steps: tuple[str, ...]

    @property
    def label(self) -> str:
        return f"{self.workflow} / {self.job}"


REQUIRED = (
    Requirement("ci.yml", "test", (
        "Security audit (bot + backend surfaces)", "Audit gate self-test",
        "Typecheck all workspaces", "Test (parallel)", "Run pnpm build",
    )),
    Requirement("ci.yml", "powershell-smoke-tests", ("Run Pester suite",)),
    Requirement("secret-scan.yml", "Gitleaks Scan", (
        "Reject tracked env files", "Verify custom rules detect project secrets", "Run Gitleaks",
    )),
    Requirement("bot-tests.yml", "test", ("Lint bot code", "Run bot tests")),
    Requirement("bot-build-check.yml", "bot-build-check", ("Build bot", "Unit tests (identity)")),
    Requirement("codeql-analysis.yml", "Analyze (javascript-typescript)", ("Perform CodeQL Analysis",)),
    *(Requirement("codeql.yml", f"Analyze ({language})", ("Perform CodeQL Analysis",))
      for language in ("actions", "javascript-typescript", "python")),
)


def api_list(endpoint: str, key: str) -> list[dict]:
    output = subprocess.run(["gh", "api", endpoint, "--paginate"],
                            capture_output=True, text=True, check=True).stdout
    decoder = json.JSONDecoder()
    items = []
    remaining = output.strip()
    while remaining:
        page, end = decoder.raw_decode(remaining)
        if not isinstance(page, dict) or not isinstance(page.get(key), list):
            raise ValueError("Malformed Actions evidence")
        items.extend(page[key])
        remaining = remaining[end:].lstrip()
    return items


def newest_workflow(runs: list[dict], workflow: str) -> dict | None:
    matches = [run for run in runs if run.get("path") == f".github/workflows/{workflow}"
               and run.get("event") == "pull_request"]
    # IDs order newly scheduled runs. completed_at would prefer an old success
    # over a newly queued run (whose completion timestamp is null).
    return max(matches, key=lambda run: (int(run.get("id", 0)), int(run.get("run_attempt", 0))), default=None)


def collect(repo: str, sha: str) -> list[dict]:
    runs = api_list(f"repos/{repo}/actions/runs?head_sha={sha}&event=pull_request&per_page=100", "workflow_runs")
    for workflow in {required.workflow for required in REQUIRED}:
        run = newest_workflow(runs, workflow)
        if run and run.get("head_sha") == sha and run.get("status") == "completed":
            attempt = int(run.get("run_attempt", 0))
            run["jobs"] = api_list(
                f"repos/{repo}/actions/runs/{int(run['id'])}/attempts/{attempt}/jobs?per_page=100", "jobs")
    return runs


def classify(run: dict | None, required: Requirement, sha: str) -> str:
    if run is None:
        return "MISSING"
    if run.get("head_sha") != sha:
        return "wrong workflow SHA"
    if run.get("status") != "completed":
        return "PENDING"
    if run.get("conclusion") != "success":
        return f"workflow {run.get('conclusion') or 'incomplete'}"
    jobs = [job for job in run.get("jobs", []) if job.get("name") == required.job]
    if len(jobs) != 1:
        return "missing or ambiguous job evidence"
    job = jobs[0]
    if job.get("head_sha") != sha or job.get("run_id") != run.get("id"):
        return "wrong job SHA or workflow run"
    if job.get("run_attempt") != run.get("run_attempt"):
        return "stale job attempt; rerun all workflow jobs"
    if job.get("status") != "completed" or job.get("conclusion") != "success":
        return f"job {job.get('conclusion') or 'incomplete'}"
    if not job.get("started_at") or not job.get("completed_at"):
        return "job did not execute"
    for name in required.steps:
        steps = [step for step in job.get("steps", []) if step.get("name") == name]
        if len(steps) != 1:
            return f"missing or ambiguous step: {name}"
        step = steps[0]
        if (step.get("status") != "completed" or step.get("conclusion") != "success"
                or not step.get("started_at") or not step.get("completed_at")):
            return f"step did not succeed and execute: {name}"
    return "success"


def evaluate(runs: list[dict], sha: str, required=REQUIRED) -> tuple[list[str], list[str], list[str]]:
    missing, pending, failed = [], [], []
    for requirement in required:
        status = classify(newest_workflow(runs, requirement.workflow), requirement, sha)
        if status == "MISSING":
            missing.append(requirement.label)
        elif status == "PENDING":
            pending.append(requirement.label)
        elif status != "success":
            failed.append(f"{requirement.label}: {status}")
    return missing, pending, failed


def main() -> int:
    repo = os.environ.get("REPO") or os.environ.get("GITHUB_REPOSITORY", "")
    sha = os.environ.get("HEAD_SHA", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo) or not re.fullmatch(r"[a-f0-9]{40}", sha):
        print("ERROR: valid REPO and exact HEAD_SHA are required.")
        return 1
    deadline = time.monotonic() + float(os.environ.get("TIMEOUT_MINUTES", "20")) * 60
    poll_seconds = min(60, max(1, float(os.environ.get("POLL_SECONDS", "20"))))
    print(f"Asserting executed Actions evidence on {repo}@{sha}", flush=True)
    while True:
        try:
            runs = collect(repo, sha)
            missing, pending, failed = evaluate(runs, sha)
        except (subprocess.CalledProcessError, FileNotFoundError, ValueError, KeyError) as error:
            print(f"FAILED: could not retrieve trustworthy Actions evidence ({type(error).__name__}).")
            return 1
        if not missing and not pending and not failed:
            print("OK: every required workflow, job and step executed successfully on this exact head.")
            return 0
        print(json.dumps({"missing": missing, "pending": pending, "failed": failed}), flush=True)
        if failed or time.monotonic() >= deadline:
            print("FAILED: required Actions evidence is incomplete or unsuccessful.")
            return 1
        time.sleep(poll_seconds)


if __name__ == "__main__":
    sys.exit(main())

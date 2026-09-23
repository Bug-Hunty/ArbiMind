"""Dependency-free regression tests for the merge evidence gate."""
import contextlib
import copy
import importlib.util
import io
import os
from pathlib import Path
import sys
import unittest

spec = importlib.util.spec_from_file_location("required_checks", Path(__file__).resolve().parents[1] / "scripts/assert_required_checks.py")
gate = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = gate
spec.loader.exec_module(gate)
SHA = "a" * 40


def passing():
    runs = []
    for requirement in gate.REQUIRED:
        run = next((r for r in runs if r["path"].endswith("/" + requirement.workflow)), None)
        if run is None:
            run = {"id": len(runs) + 1, "path": ".github/workflows/" + requirement.workflow,
                   "event": "pull_request", "head_sha": SHA, "run_attempt": 1,
                   "status": "completed", "conclusion": "success", "jobs": []}
            runs.append(run)
        executed = {"status": "completed", "conclusion": "success",
                    "started_at": "2026-09-09T20:00:00Z", "completed_at": "2026-09-09T20:01:00Z"}
        run["jobs"].append({**executed, "name": requirement.job, "head_sha": SHA,
                            "run_id": run["id"], "run_attempt": 1,
                            "steps": [{**executed, "name": step} for step in requirement.steps]})
    return runs


def run_main(collect, timeout_minutes="0", poll_seconds="0"):
    """Drive main()'s poll loop over a stubbed evidence source."""
    keys = ("REPO", "HEAD_SHA", "TIMEOUT_MINUTES", "POLL_SECONDS")
    saved_env = {key: os.environ.get(key) for key in keys}
    saved_collect, saved_sleep = gate.collect, gate.time.sleep
    gate.collect = collect
    gate.time.sleep = lambda _seconds: None
    os.environ.update({"REPO": "Bug-Hunty/ArbiMind", "HEAD_SHA": SHA,
                       "TIMEOUT_MINUTES": timeout_minutes, "POLL_SECONDS": poll_seconds})
    buffer = io.StringIO()
    try:
        with contextlib.redirect_stdout(buffer):
            code = gate.main()
    finally:
        gate.collect, gate.time.sleep = saved_collect, saved_sleep
        for key, value in saved_env.items():
            os.environ.pop(key, None) if value is None else os.environ.__setitem__(key, value)
    return code, buffer.getvalue()


def workflow(runs, name):
    return next(run for run in runs if run["path"].endswith("/" + name))


class RequiredChecksTests(unittest.TestCase):
    def test_full_executed_evidence_passes(self):
        self.assertEqual(gate.evaluate(passing(), SHA), ([], [], []))

    def test_missing_everything_fails_closed(self):
        self.assertEqual(len(gate.evaluate([], SHA)[0]), len(gate.REQUIRED))

    def test_bot_test_success_cannot_hide_ci_audit_failure(self):
        runs = passing()
        runs[0]["conclusion"] = "failure"
        failures = gate.evaluate(runs, SHA)[2]
        self.assertTrue(any("ci.yml / test: workflow failure" in f for f in failures))

    def test_other_workflow_with_same_job_name_cannot_satisfy_missing_ci(self):
        runs = [r for r in passing() if r["path"] != ".github/workflows/ci.yml"]
        self.assertIn("ci.yml / test", gate.evaluate(runs, SHA)[0])

    def test_new_pending_run_wins_over_old_completed_success(self):
        runs = passing()
        queued = {**runs[0], "id": 100, "status": "queued", "conclusion": None, "jobs": []}
        runs.append(queued)
        self.assertIn("ci.yml / test", gate.evaluate(runs, SHA)[1])

    def test_push_run_cannot_replace_pull_request_evidence(self):
        runs = passing()
        runs[0]["event"] = "push"
        self.assertIn("ci.yml / test", gate.evaluate(runs, SHA)[0])

    def test_stale_sha_at_either_level_fails(self):
        for level in ("workflow", "job"):
            with self.subTest(level=level):
                runs = passing()
                target = runs[0] if level == "workflow" else runs[0]["jobs"][0]
                target["head_sha"] = "b" * 40
                self.assertTrue(gate.evaluate(runs, SHA)[2])

    def test_only_success_counts_at_all_three_levels(self):
        for level in ("workflow", "job", "step"):
            for conclusion in ("neutral", "skipped", "failure", "cancelled", "timed_out", None):
                with self.subTest(level=level, conclusion=conclusion):
                    runs = passing()
                    target = runs[0]
                    if level in ("job", "step"):
                        target = target["jobs"][0]
                    if level == "step":
                        target = target["steps"][0]
                    target["conclusion"] = conclusion
                    self.assertTrue(gate.evaluate(runs, SHA)[2])

    def test_empty_jobs_or_steps_are_not_success(self):
        for level in ("jobs", "steps"):
            runs = passing()
            target = runs[0] if level == "jobs" else runs[0]["jobs"][0]
            target[level] = []
            self.assertTrue(gate.evaluate(runs, SHA)[2])

    def test_step_without_execution_timestamps_fails(self):
        runs = passing()
        runs[0]["jobs"][0]["steps"][0]["started_at"] = None
        self.assertTrue(gate.evaluate(runs, SHA)[2])

    def test_job_from_previous_attempt_fails(self):
        runs = passing()
        runs[0]["run_attempt"] = 2
        self.assertTrue(gate.evaluate(runs, SHA)[2])

    def test_duplicate_job_evidence_is_ambiguous(self):
        runs = passing()
        runs[0]["jobs"].append(copy.deepcopy(runs[0]["jobs"][0]))
        self.assertTrue(gate.evaluate(runs, SHA)[2])

    def test_same_job_name_in_another_workflow_cannot_satisfy_failing_target(self):
        """The 6b7cfd2 shape: two jobs named `test`, one green, one red."""
        runs = passing()
        ci, bot = workflow(runs, "ci.yml"), workflow(runs, "bot-tests.yml")
        # Both really are called `test`; only the workflow tells them apart.
        self.assertEqual(ci["jobs"][0]["name"], bot["jobs"][0]["name"], "test")
        ci["jobs"][0]["conclusion"] = "failure"

        failed = gate.evaluate(runs, SHA)[2]
        self.assertTrue(any(f.startswith("ci.yml / test") for f in failed))
        # ...and the green one is not dragged down with it.
        self.assertFalse(any(f.startswith("bot-tests.yml / test") for f in failed))

    def test_legacy_name_only_selection_is_what_produced_the_false_green(self):
        """Root-cause witness: name + newest completed_at picks the wrong run."""
        same_name = [
            {"name": "test", "status": "completed", "conclusion": "failure",
             "completed_at": "2026-09-09T20:00:00Z"},   # CI / test
            {"name": "test", "status": "completed", "conclusion": "success",
             "completed_at": "2026-09-09T20:05:00Z"},   # Bot Tests / test
        ]
        legacy = sorted(same_name, key=lambda r: r.get("completed_at") or "")[-1]
        self.assertEqual(legacy["conclusion"], "success")  # the old gate's answer

        # The replacement identifies evidence by workflow+job+steps, and a
        # check-run display name is not part of that identity at all.
        self.assertEqual(set(gate.Requirement.__dataclass_fields__), {"workflow", "job", "steps"})

    def test_pending_target_fails_after_timeout(self):
        runs = passing()
        queued = workflow(runs, "ci.yml")
        queued.update({"status": "queued", "conclusion": None, "jobs": []})

        code, output = run_main(lambda _repo, _sha: runs, timeout_minutes="0")
        self.assertEqual(code, 1)
        self.assertIn("FAILED", output)

    def test_pending_target_waits_rather_than_failing_immediately(self):
        stalled = passing()
        workflow(stalled, "ci.yml").update({"status": "queued", "conclusion": None, "jobs": []})
        polls = [stalled, passing()]

        code, output = run_main(lambda _repo, _sha: polls.pop(0), timeout_minutes="5")
        self.assertEqual(code, 0, output)
        self.assertEqual(polls, [], "should have polled a second time instead of giving up")

    def test_exact_sha_success_passes_through_main(self):
        code, output = run_main(lambda _repo, _sha: passing(), timeout_minutes="5")
        self.assertEqual(code, 0)
        self.assertIn("executed successfully on this exact head", output)

    def test_wrong_sha_fails_through_main(self):
        runs = passing()
        for run in runs:
            run["head_sha"] = "b" * 40
        code, _ = run_main(lambda _repo, _sha: runs, timeout_minutes="0")
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()

"""Dependency-free regression tests for the merge evidence gate."""
import copy
import importlib.util
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


if __name__ == "__main__":
    unittest.main()

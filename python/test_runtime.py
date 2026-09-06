"""Native contract tests use the same setup archive as the browser."""

import tempfile
import subprocess
import sys
import json
import os
import unittest
from pathlib import Path
from episode_runtime import ROOT, Runtime, as_initial, load, save, verify


class NativeContractTests(unittest.TestCase):
    def setup_runtime(self, physics=False):
        ep = load(ROOT / "examples/two-objects.initial.episode.zip")
        ep["manifest"]["runtime"]["physics"].update(enabled=physics, duration=0.02)
        ep["manifest"]["runtime"]["enabledTools"].append("apply_force")
        return Runtime(ep)

    def test_query_lifecycle_and_missing_render_capability(self):
        r = self.setup_runtime()
        r.execute("get_state", {})
        self.assertEqual(r.m["lifecycle"], "active")
        with self.assertRaisesRegex(ValueError, "Unsupported capability"):
            r.execute("capture_scene", {})
        self.assertEqual(r.episode["calls"][-1]["error_code"], "unsupported_capability")
        self.assertEqual(r.episode["observations"], {})
        r.execute("end_episode", {"reason": "budget"})
        count = len(r.episode["calls"])
        r.execute("end_episode", {})
        self.assertEqual(count, len(r.episode["calls"]))
        with self.assertRaisesRegex(ValueError, "ended"):
            r.execute("translate_objects", {"ids": ["a"], "delta": [1, 0, 0]})

    def test_cancel_batch_and_native_exact_verification(self):
        r = self.setup_runtime(True)
        before = r.snapshot()
        r.cancel_at_step = 3
        with self.assertRaisesRegex(ValueError, "cancelled"):
            r.execute("advance_simulation", {"duration": 0.02})
        self.assertEqual(r.snapshot(), before)
        self.assertEqual(r.episode["trajectory"][-1]["phase"], "rollback")
        r.cancel_at_step = None
        r.execute(
            "edit_poses",
            {
                "poses": [
                    {"id": i, "position": [x, 0, 1], "quaternion": [1, 0, 0, 0]}
                    for x, i in enumerate(["a", "b"])
                ]
            },
            "human",
        )
        self.assertEqual(r.episode["calls"][-1]["steps"], 10)
        self.assertEqual(len(r.episode["states"]), 1)
        self.assertEqual(verify(r.episode)["status"], "passed")
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "run.zip"
            save(r.episode, p)
            loaded = Runtime(load(p))
            self.assertEqual(r.snapshot(), loaded.snapshot())

    def test_collision_override_survives_restore(self):
        ep = load(ROOT / "examples/two-objects.initial.episode.zip")
        ep["manifest"]["objects"][0]["collisionEnabled"] = False
        r = Runtime(ep)
        body = r.body("a")
        self.assertTrue(
            all(
                r.model.geom_contype[g] == 0
                for g in range(r.model.ngeom)
                if r.model.geom_bodyid[g] == body
            )
        )
        self.assertTrue(any(r.original_collision[0]))
        fresh = as_initial(r.episode, r.snapshot())
        self.assertEqual(fresh["manifest"]["objects"][0]["collisionEnabled"], False)

    def test_invalid_capability_and_frame_are_rejected(self):
        ep = load(ROOT / "examples/two-objects.initial.episode.zip")
        ep["manifest"]["requiredCapabilities"] = ["unknown"]
        with self.assertRaisesRegex(ValueError, "capability"):
            Runtime(ep)
        ep["manifest"]["requiredCapabilities"] = ["state"]
        ep["initial"]["integration"][0] = float("nan")
        with self.assertRaisesRegex(ValueError, "state"):
            Runtime(ep)

    def test_assets_never_fall_back_to_working_directory(self):
        ep = load(ROOT / "examples/two-objects.initial.episode.zip")
        ep["assets"]["model.xml"] = b'<mujoco><include file="outside.xml"/></mujoco>'
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "outside.xml").write_text(
                "<mujocoinclude><worldbody/></mujocoinclude>"
            )
            original = os.getcwd()
            try:
                os.chdir(directory)
                with self.assertRaises(ValueError):
                    Runtime(ep)
            finally:
                os.chdir(original)
        ep["assets"]["model.xml"] = (
            b'<mujoco><compiler meshdir="/tmp"/><worldbody/></mujoco>'
        )
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            Runtime(ep)

    def test_cli_reports_bad_archive_separately_and_does_not_overwrite_it(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "broken.zip"
            path.write_bytes(b"not a zip")
            result = subprocess.run(
                [sys.executable, str(ROOT / "python/replay.py"), "verify", str(path)],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 3)
            self.assertEqual(
                json.loads(result.stdout)["failureKind"], "invalid_archive"
            )
            self.assertEqual(path.read_bytes(), b"not a zip")


if __name__ == "__main__":
    unittest.main()

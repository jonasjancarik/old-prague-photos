import os
import subprocess
import unittest


class ReleaseScriptTests(unittest.TestCase):
    def test_legacy_deploy_uses_the_guarded_production_release(self) -> None:
        env = os.environ.copy()
        env.pop("CONFIRM_PRODUCTION_DEPLOY", None)
        result = subprocess.run(
            ["bash", "ops.sh", "deploy"],
            check=False,
            capture_output=True,
            text=True,
            env=env,
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("Production deployment is disabled by default", result.stderr)


if __name__ == "__main__":
    unittest.main()

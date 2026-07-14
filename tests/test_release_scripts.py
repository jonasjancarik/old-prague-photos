import os
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


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

    def test_production_deploy_rejects_the_wrong_branch_before_remote_work(self) -> None:
        env = os.environ.copy()
        env.update(
            {
                "CONFIRM_PRODUCTION_DEPLOY": "old-prague-photos",
                "D1_BACKUP_DIR": "/tmp/not-used",
                "PAGES_PRODUCTION_URL": "https://example.test",
                "PAGES_PRODUCTION_BRANCH": "definitely-not-the-current-branch",
            }
        )
        result = subprocess.run(
            ["sh", "scripts/deploy-pages.sh"],
            check=False,
            capture_output=True,
            text=True,
            env=env,
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("Production deployment must run from branch", result.stderr)

    def test_production_deploy_checks_cloudflare_branch_before_migrating(self) -> None:
        with TemporaryDirectory() as tmpdir:
            git = Path(tmpdir) / "git"
            git.write_text("#!/bin/sh\nprintf '%s\\n' 'test-production'\n", encoding="utf-8")
            git.chmod(0o755)
            curl = Path(tmpdir) / "curl"
            curl.write_text(
                "#!/bin/sh\nprintf '%s\\n' '{\"success\":true,\"result\":{\"production_branch\":\"different-production\"}}'\n",
                encoding="utf-8",
            )
            curl.chmod(0o755)
            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{tmpdir}:{env['PATH']}",
                    "CONFIRM_PRODUCTION_DEPLOY": "old-prague-photos",
                    "D1_BACKUP_DIR": "/tmp/not-used",
                    "PAGES_PRODUCTION_URL": "https://example.test",
                    "PAGES_PRODUCTION_BRANCH": "test-production",
                    "CLOUDFLARE_ACCOUNT_ID": "test-account",
                    "CLOUDFLARE_API_TOKEN": "test-token",
                }
            )
            result = subprocess.run(
                ["sh", "scripts/deploy-pages.sh"],
                check=False,
                capture_output=True,
                text=True,
                env=env,
            )

        self.assertEqual(result.returncode, 2)
        self.assertIn("Pages production branch is 'different-production'", result.stderr)


if __name__ == "__main__":
    unittest.main()

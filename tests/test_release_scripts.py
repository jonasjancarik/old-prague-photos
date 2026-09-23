import os
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


class ReleaseScriptTests(unittest.TestCase):
    def _staging_env(self) -> dict[str, str]:
        env = os.environ.copy()
        for name in (
            "CONFIRM_STAGING_DEPLOY",
            "D1_BACKUP_DIR",
            "PAGES_STAGING_URL",
            "ADMIN_API_TOKEN",
            "CF_ACCESS_CLIENT_ID",
            "CF_ACCESS_CLIENT_SECRET",
        ):
            env.pop(name, None)
        return env

    def test_staging_deploy_requires_explicit_confirmation(self) -> None:
        result = subprocess.run(
            ["sh", "scripts/deploy-pages-staging.sh"],
            check=False,
            capture_output=True,
            text=True,
            env=self._staging_env(),
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("Staging deployment is disabled by default", result.stderr)

    def test_staging_deploy_requires_checkpoint_destination(self) -> None:
        env = self._staging_env()
        env["CONFIRM_STAGING_DEPLOY"] = "old-prague-photos-staging"
        result = subprocess.run(
            ["sh", "scripts/deploy-pages-staging.sh"],
            check=False,
            capture_output=True,
            text=True,
            env=env,
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("Set D1_BACKUP_DIR", result.stderr)

    def test_staging_checkpoint_precedes_remote_migrations(self) -> None:
        script = Path("scripts/deploy-pages-staging.sh").read_text(encoding="utf-8")

        self.assertLess(
            script.index("scripts/checkpoint-d1.sh preview"),
            script.index("d1 migrations apply CORRECTIONS_DB --remote --env preview"),
        )

    def test_staging_deploy_fails_when_worktree_status_cannot_be_verified(self) -> None:
        with TemporaryDirectory() as tmpdir:
            git = Path(tmpdir) / "git"
            git.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
            git.chmod(0o755)
            env = self._staging_env()
            env.update(
                {
                    "PATH": f"{tmpdir}:{env['PATH']}",
                    "CONFIRM_STAGING_DEPLOY": "old-prague-photos-staging",
                    "D1_BACKUP_DIR": "/tmp/not-used",
                    "PAGES_STAGING_URL": "https://staging.example.test",
                    "CLOUDFLARE_ACCOUNT_ID": "test-account",
                    "ADMIN_API_TOKEN": "x",
                    "CF_ACCESS_CLIENT_ID": "x",
                    "CF_ACCESS_CLIENT_SECRET": "x",
                }
            )
            result = subprocess.run(
                ["sh", "scripts/deploy-pages-staging.sh"],
                check=False,
                capture_output=True,
                text=True,
                env=env,
            )

        self.assertEqual(result.returncode, 2)
        self.assertIn("Could not verify that the staging worktree is clean", result.stderr)

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
            git.write_text(
                "#!/bin/sh\n"
                "if [ \"$1\" = symbolic-ref ]; then printf '%s\\n' 'test-production'; fi\n",
                encoding="utf-8",
            )
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

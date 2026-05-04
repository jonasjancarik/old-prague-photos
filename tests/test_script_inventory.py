import re
import unittest
from pathlib import Path


INVENTORY_PATH = Path("docs/script-inventory.md")
ALLOWED_STATUSES = {
    "canonical",
    "maintenance",
    "research",
}


def loose_scripts() -> set[str]:
    result: set[str] = set()
    for path in Path(".").rglob("*"):
        if not path.is_file() or path.suffix not in {".py", ".sh"}:
            continue
        text = path.as_posix()
        if text.startswith((
            ".git/",
            ".ignore/",
            ".venv/",
            "node_modules/",
            "output/",
            "viewer/react/node_modules/",
        )):
            continue
        if text.startswith(("src/", "tests/", "functions/")):
            continue
        if text == "viewer/app.py":
            continue
        result.add(text)
    return result


def inventory_rows() -> dict[str, str]:
    rows: dict[str, str] = {}
    for line in INVENTORY_PATH.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^\| `([^`]+)` \| ([^|]+) \|", line)
        if match:
            rows[match.group(1)] = match.group(2).strip()
    return rows


class ScriptInventoryTests(unittest.TestCase):
    def test_all_loose_scripts_are_classified(self) -> None:
        scripts = loose_scripts()
        rows = inventory_rows()

        self.assertEqual(
            scripts - set(rows),
            set(),
            "Loose scripts missing from docs/script-inventory.md",
        )
        self.assertEqual(
            set(rows) - scripts,
            set(),
            "Inventory contains paths that are not loose scripts",
        )

    def test_inventory_statuses_are_explicit(self) -> None:
        rows = inventory_rows()
        self.assertTrue(rows)
        invalid = {
            path: status
            for path, status in rows.items()
            if status not in ALLOWED_STATUSES
        }
        self.assertEqual(invalid, {})


if __name__ == "__main__":
    unittest.main()

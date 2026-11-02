"""Offline tests for `oh-my-context hint` skill output (vendor/oh_my_context/hint.py).

Run: PYTHONPATH=<mod>/vendor python3 -m unittest discover -s <mod>/test -p test_hint.py
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_ROOT = Path(tempfile.mkdtemp(prefix="oh-my-context-hint-test-"))
for _k in [k for k in os.environ if k.startswith(("OMC_", "XDG_", "CLAUDE_"))]:
    del os.environ[_k]
os.environ["HOME"] = str(_ROOT / "home")
os.environ["OMC_HOME"] = str(_ROOT / "home" / "oh-my-context")
os.environ["OMC_CONFIG_FILE"] = str(_ROOT / "home" / "oh-my-context" / "config.json")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "vendor"))

from oh_my_context import hint  # noqa: E402

INDEX = {"skills": [
    {"slug": "ecc:docker-patterns", "name": "docker-patterns", "triggers": [],
     "desc": "Docker and Docker Compose patterns for containerized development. Use when writing Dockerfiles."},
    {"slug": "ecc:css-layout", "name": "css-layout", "triggers": [],
     "desc": "Flexbox grids and responsive stylesheets for web pages."},
    {"slug": "plain", "name": "plain", "triggers": [], "desc": "x" * 300},
]}


class SkillHintOutput(unittest.TestCase):
    def hints(self, prompt, index=INDEX):
        with mock.patch("oh_my_context.skills.load_index", return_value=index):
            return hint._skill_hints(prompt, 3)

    def test_id_name_and_one_line_desc(self):
        out = self.hints("write a Dockerfile and Docker Compose containerized development setup")
        self.assertEqual([h["id"] for h in out], ["ecc:docker-patterns"])
        self.assertEqual(out[0]["name"], "ecc:docker-patterns")  # older callers keep working
        self.assertEqual(out[0]["desc"], "Docker and Docker Compose patterns for containerized development.")
        self.assertIn("score", out[0])

    def test_quiet_without_a_clear_match(self):
        self.assertEqual(self.hints("what time is it in Tokyo today"), [])
        self.assertEqual(self.hints("anything at all", index={}), [])

    def test_one_line(self):
        self.assertEqual(hint._one_line('"Line one.\nLine two."'), "Line one.")
        self.assertEqual(hint._one_line(None), "")
        cut = hint._one_line("x" * 300)
        self.assertEqual(len(cut), hint._DESC_MAX)
        self.assertTrue(cut.endswith("…"))


if __name__ == "__main__":
    unittest.main()

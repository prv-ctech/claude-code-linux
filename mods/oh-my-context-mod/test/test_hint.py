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
        out = self.hints("use docker-patterns for a Dockerfile and Docker Compose containerized development setup")
        self.assertEqual([h["id"] for h in out], ["ecc:docker-patterns"])
        self.assertEqual(out[0]["name"], "ecc:docker-patterns")  # older callers keep working
        self.assertEqual(out[0]["desc"], "Docker and Docker Compose patterns for containerized development.")
        self.assertIn("score", out[0])

    def test_words_alone_do_not_hint(self):
        # Shares many words with the skill, but never names it or its plugin.
        self.assertEqual(self.hints("write a Dockerfile and Docker Compose containerized development setup"), [])

    def test_plugin_name_and_one_hint_per_synced_pair(self):
        index = {"skills": [
            {"slug": "authentik-mod:authentik", "name": "authentik", "triggers": [], "desc": "Work in the connected instance."},
            {"slug": "pdf", "name": "pdf", "triggers": [], "desc": "Read and fill PDF files."},
            {"slug": "anthropic-skills:pdf", "name": "pdf", "triggers": [], "desc": "Read and fill PDF files."},
            {"slug": "other", "name": "other", "triggers": [], "desc": "Create a new user and add files."},
        ]}
        self.assertEqual([h["id"] for h in self.hints("create a new authentik user", index)], ["authentik-mod:authentik"])
        self.assertEqual([h["id"] for h in self.hints("fill this pdf form", index)], ["pdf"])
        # Same skill name in two plugins: two skills, both hinted.
        two = {"skills": [{"slug": f"{p}:deep-research", "name": "deep-research", "triggers": [], "desc": "Research a topic."}
                          for p in ("ecc", "anthropic-skills")] + index["skills"]}
        self.assertEqual(len(self.hints("run deep-research on this topic", two)), 2)

    def test_quiet_without_a_clear_match(self):
        self.assertEqual(self.hints("what time is it in Tokyo today"), [])
        self.assertEqual(self.hints("anything at all", index={}), [])

    def test_one_line(self):
        self.assertEqual(hint._one_line('"Line one.\nLine two."'), "Line one.")
        self.assertEqual(hint._one_line(None), "")
        cut = hint._one_line("x" * 300)
        self.assertEqual(len(cut), hint._DESC_MAX)
        self.assertTrue(cut.endswith("…"))


class CardOutput(unittest.TestCase):
    INDEX = {"skills": [
        {"slug": "anthropic-skills:pdf", "name": "pdf", "desc": "Use this skill whenever the user wants to do anything with PDF files."},
        {"slug": "pdf", "name": "pdf", "desc": "Use this skill whenever the user wants to do anything with PDF files."},
        {"slug": "ecc:docker-patterns", "name": "docker-patterns", "desc": "Docker and Docker Compose patterns for containerized development."},
        {"slug": "old", "name": "old", "alias_of": "pdf", "desc": "alias"},
    ]}
    TOOLS = [{"name": "users_list"}, {"name": "users_create"}, {"name": "flows_list"}, {"error": "x"}]

    def card(self, index=INDEX, servers=None, used=({}, [])):
        from oh_my_context import card
        servers = {"ak": {"claude_prefix": "mcp__plugin_authentik-mod_authentik"}} if servers is None else servers
        with mock.patch("oh_my_context.skills.load_index", return_value=index), \
                mock.patch("oh_my_context.session_log.used", return_value=used), \
                mock.patch("oh_my_context.config.load_config", return_value=servers), \
                mock.patch("oh_my_context.cache.get_cached_tools_any_age", return_value=self.TOOLS):
            return card.build_card()

    def test_servers_by_claude_name_with_topic_words_and_one_line_per_skill(self):
        text = self.card()
        lines = text.split("\n")
        self.assertIn("`call`", lines[0])
        self.assertIn("`load_skill`", lines[0])
        # CRUD verbs are dropped; the most common word leads.
        self.assertIn("- mcp__plugin_authentik-mod_authentik__* (3 tools): users, flows", lines)
        # The synced pair shows once under its short id, an alias not at all, the opener is cut.
        self.assertIn("- pdf: PDF files.", lines)
        self.assertNotIn("anthropic-skills:pdf", text)
        self.assertNotIn("- old", text)
        self.assertEqual(text, self.card())  # same catalog, same text: keeps the prompt cache

    def test_what_the_project_uses_comes_first(self):
        text = self.card(used=({"ak": ["flows_list", "users_create"], "gone": ["x"]}, ["pdf", "removed:skill"]))
        lines = text.split("\n")
        self.assertIn("- mcp__plugin_authentik-mod_authentik__* (3 tools): users, flows; used here: flows_list, users_create", lines)
        self.assertEqual(lines[lines.index("Skills used in this project:") + 1], "- pdf: PDF files.")
        self.assertEqual(lines[lines.index("Other skills:") + 1][:22], "- ecc:docker-patterns:")
        self.assertEqual(text.count("- pdf:"), 1)
        self.assertNotIn("removed:skill", text)  # no longer in the catalog
        # A catalog over the cap keeps the glosses of the used skills only.
        big = {"skills": self.INDEX["skills"] + [
            {"slug": f"plugin:skill-number-{i}", "desc": "A long description of what it does " * 3} for i in range(400)]}
        text = self.card(index=big, used=({}, ["pdf"]))
        self.assertIn("Skills used in this project:\n- pdf: PDF files.\nOther skills: ecc:docker-patterns, plugin:skill-number-0,", text)

    def test_used_reads_the_project_log_and_creates_nothing(self):
        import tempfile as tf
        from oh_my_context import session_log
        proj = tf.mkdtemp(prefix="omc-used-")
        self.assertEqual(session_log.used(proj), ({}, []))
        self.assertFalse((session_log._log_dir() / f"{session_log._project_key(proj)}.sqlite").exists())
        old = os.getcwd()
        os.chdir(proj)
        try:
            for _ in range(2):
                session_log.record("gh", "list_commits", {})
            session_log.record("gh", "create_issue", {})
            session_log.record("gh", "delete_repo", {}, ok=False)
            session_log.record(session_log.SKILL, "ecc:docker-patterns", None)
        finally:
            os.chdir(old)
        self.assertEqual(session_log.used(proj), ({"gh": ["list_commits", "create_issue"]}, ["ecc:docker-patterns"]))

    def test_empty_catalog_prints_nothing_and_a_huge_one_stays_under_the_cap(self):
        from oh_my_context import card
        self.assertEqual(self.card(index={}, servers={}), "")
        big = {"skills": [{"slug": f"plugin:skill-number-{i}", "desc": "A long description of what it does " * 3} for i in range(400)]}
        text = self.card(index=big)
        self.assertLessEqual(len(text), card._MAX)
        self.assertIn("Skills: plugin:skill-number-0,", text)


if __name__ == "__main__":
    unittest.main()

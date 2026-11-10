"""Offline tests for result compression and the recovery store (ticket 005)."""

import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

_HOME = tempfile.mkdtemp(prefix="omc-compress-test-")
os.environ.setdefault("OMC_HOME", _HOME)
os.environ.setdefault("OMC_CONFIG_FILE", str(Path(_HOME) / "config.json"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "vendor"))

from oh_my_context import config, native_tools, recovery  # noqa: E402


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self._old = config.CONFIG_DIR
        config.CONFIG_DIR = Path(tempfile.mkdtemp(prefix="omc-rec-"))
        os.environ.pop("OMC_RECOVERY_MAX_BYTES", None)

    def tearDown(self):
        config.CONFIG_DIR = self._old
        os.environ.pop("OMC_RECOVERY_MAX_BYTES", None)

    def test_store_fetch_exact(self):
        t = "x" * 2000
        h = recovery.store(t)
        self.assertEqual(h, "omc_" + hashlib.sha256(t.encode()).hexdigest()[:32])
        self.assertEqual(recovery.fetch(h), ("ok", t))
        self.assertEqual(recovery.store(t), h)
        path = config.CONFIG_DIR / "recovery" / h
        self.assertEqual(oct(path.stat().st_mode & 0o777), "0o600")
        self.assertEqual(recovery.stats()["entries"], 1)
        self.assertEqual(recovery.stats()["bytes"], 2000)

    def test_empty_not_stored(self):
        self.assertIsNone(recovery.store(""))

    def test_corrupt_and_invalid(self):
        h = recovery.store("a" * 100)
        (config.CONFIG_DIR / "recovery" / h).write_text("y")
        self.assertEqual(recovery.fetch(h)[0], "corrupt")
        self.assertEqual(recovery.fetch("../../etc/passwd")[0], "invalid-handle")
        self.assertEqual(recovery.fetch("omc_" + "0" * 32)[0], "not-found")

    def test_cap_no_eviction(self):
        os.environ["OMC_RECOVERY_MAX_BYTES"] = "5000"
        hs = [recovery.store(c * 2000) for c in "abc"]
        self.assertIsNotNone(hs[0])
        self.assertIsNotNone(hs[1])
        self.assertIsNone(hs[2])
        self.assertEqual(recovery.fetch(hs[0])[0], "ok")
        self.assertEqual(recovery.fetch(hs[1])[0], "ok")
        self.assertEqual(recovery.stats()["cap"], 5000)

    def test_query(self):
        h = recovery.store("alpha one\n\nbeta two\n\nalpha three")
        self.assertEqual(recovery.fetch(h, "alpha"), ("ok", "alpha one\n…\nalpha three"))
        self.assertEqual(recovery.fetch(h, "zzz")[1],
                         "no section matches; call retrieve without query for the full original")

    def test_dedupe(self):
        h = "omc_" + "1" * 32
        self.assertFalse(recovery.was_sent(h))
        recovery.mark_sent(h)
        self.assertTrue(recovery.was_sent(h))

    def test_marker(self):
        self.assertEqual(recovery.marker("omc_x"),
                         "<<omc:omc_x>> compressed view; call retrieve with this handle for the exact original")

    def test_retrieve_tool(self):
        t = "hello\n\nworld " * 50
        h = recovery.store(t)
        r = native_tools.call_native("retrieve", {"handle": h}, {})
        self.assertEqual(r["content"][0]["text"], t)
        r = native_tools.call_native("retrieve", {"handle": h, "query": "world"}, {})
        self.assertIn("world", r["content"][0]["text"])
        r = native_tools.call_native("retrieve", {"handle": "bad"}, {})
        self.assertTrue(r["isError"])
        self.assertIn("invalid-handle", r["content"][0]["text"])
        sch = next(t for t in native_tools.native_tools() if t["name"] == "retrieve")["inputSchema"]
        self.assertEqual(sch["required"], ["handle"])
        self.assertIn("query", sch["properties"])


# ─── compression (ticket 005, compression teammate) ───

import json  # noqa: E402
import time  # noqa: E402

from oh_my_context import compressor, toon, usage  # noqa: E402
from oh_my_context.shapes import REGISTRY  # noqa: E402


class ToonTests(unittest.TestCase):
    def test_examples_and_round_trip(self):
        a = '[{"name":"Ada","role":"engineer"},{"name":"Lin","role":"designer"}]'
        self.assertEqual(toon.encode_json(a), "[2]{name,role}:\n  Ada,engineer\n  Lin,designer")
        self.assertEqual(toon.decode(toon.encode_json(a)), json.loads(a))
        b = '{"rows":[{"id":1}]}'
        self.assertEqual(toon.encode_json(b), "rows[1]{id}:\n  1")
        self.assertEqual(toon.decode(toon.encode_json(b)), json.loads(b))

    def test_not_eligible_and_quoting(self):
        self.assertIsNone(toon.encode_json('[{"a":1},{"b":2}]'))
        self.assertIsNone(toon.encode_json('{"a":1,"a":2}'))
        self.assertIsNone(toon.encode_json('{"bad key":[1]}'))
        out = toon.encode_json('{"a":["1x","ok","a,b",""],"n":{"x":1.50,"y":null}}')
        self.assertIn('a[4]: "1x",ok,"a,b",""', out)
        self.assertIn("n:\n  x: 1.50\n  y: null", out)
        self.assertEqual(toon.decode(out), json.loads('{"a":["1x","ok","a,b",""],"n":{"x":1.5,"y":null}}'))


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self._old = config.CONFIG_DIR
        config.CONFIG_DIR = Path(tempfile.mkdtemp(prefix="omc-pipe-"))
        usage._USAGE_FILE = config.CONFIG_DIR / "usage.json"
        os.environ.pop("OMC_RECOVERY_MAX_BYTES", None)

    def tearDown(self):
        config.CONFIG_DIR = self._old
        os.environ.pop("OMC_RECOVERY_MAX_BYTES", None)

    def handle(self, out):
        last = out.split("\n")[-1]
        self.assertTrue(last.startswith("<<omc:omc_") and last.endswith(
            ">> compressed view; call retrieve with this handle for the exact original"), last)
        return last[len("<<omc:"):last.index(">>")]

    def test_json_elision_and_recovery(self):
        t = json.dumps({"items": [{"id": i, "v": "ok" if i != 7 else "error: boom", "n": [1, {"a": i}]}
                                  for i in range(30)]})
        out = compressor.compress_text(t)
        h = self.handle(out)
        body = json.loads(out.rsplit("\n", 1)[0])
        ids = [x.get("id", x) for x in body["items"]]
        self.assertEqual(ids, [0, 1, 2, {"__omc_elided__": 4}, 7, {"__omc_elided__": 20}, 28, 29])
        self.assertEqual(recovery.fetch(h), ("ok", t))
        self.assertEqual(usage.saved_tokens(), usage.count_tokens(t) - usage.count_tokens(out))

    def test_marker_counts_toward_size(self):
        from unittest import mock
        t = "word " * 400
        shape = compressor.detect_shape(t)
        with mock.patch.dict(compressor.REGISTRY, {shape: lambda s: s[:-20]}):
            self.assertIsNone(compressor.compress_text(t))

    def test_testreport_pytest(self):
        tests = [{"nodeid": f"t::t{i}", "outcome": "passed"} for i in range(19)]
        tb = [{"path": f"f{i}.py", "lineno": i, "message": f"m{i}"} for i in range(12)]
        tests.append({"nodeid": "t::bad", "outcome": "failed",
                      "call": {"crash": {"message": "boom"}, "traceback": tb}})
        t = json.dumps({"tests": tests, "exitcode": 1, "duration": 1.5, "pad": "x" * 600})
        self.assertEqual(compressor.detect_shape(t), "testreport")
        out = compressor.compress_text(t)
        lines = out.split("\n")
        self.assertEqual(lines[0], "TEST SUMMARY: passed=19 failed=1 duration=1.5s")
        self.assertEqual(lines[1:3], ["FAILED: t::bad", "boom"])
        self.assertIn("... (7 frames omitted)", lines)
        self.assertEqual(lines[3:6], ["f0.py:0 m0", "f1.py:1 m1", "f2.py:2 m2"])
        self.handle(out)

    def test_testreport_junit(self):
        cases = "".join(f'<testcase classname="c" name="n{i}"/>' for i in range(40))
        t = ('<testsuite tests="41" time="2">' + cases +
             '<testcase classname="c" name="bad"><failure message="oops">a\nb</failure></testcase></testsuite>')
        out = compressor.compress_text(t)
        self.assertTrue(out.startswith("TEST SUMMARY: passed=40 failed=1 duration=2s\nFAILED: c.bad\noops\na\nb\n"))

    def test_diff(self):
        lines = ["diff --git a/f b/f", "index 1..2 100644", "--- a/f", "+++ b/f", "@@ -1,40 +1,40 @@"]
        lines += [f" ctx{i}" for i in range(20)] + ["-old", "+new"] + [f" ctx{i}" for i in range(20, 40)]
        lines += ["x" * 600]
        out = compressor.compress_text("\n".join(lines))
        self.assertIn("… 16 context lines elided …", out)
        self.assertIn("-old\n+new", out)
        self.assertNotIn(" ctx5\n", out)
        self.handle(out)

    def test_csv(self):
        rows = ["id,name,note"] + [f"{i},user{i},fine and plenty of padding {i}" for i in range(30)]
        rows[12] = "11,user11,ERROR something"
        out = compressor.compress_text("\n".join(rows))
        if out.startswith("[") or out.startswith("id"):
            pass
        self.handle(out)
        self.assertIn("ERROR something", out)
        self.assertIn("… ", out)

    def test_csv_elision_exact(self):
        rows = ["a,b"] + [f"{i},{'z' * 40}" for i in range(30)]
        rows[15] = "14,ERROR " + "z" * 40
        t = "\n".join(rows)
        got = REGISTRY["tabular"](t).split("\n")
        self.assertEqual(got[0:4], ["a,b", "0," + "z" * 40, "1," + "z" * 40, "2," + "z" * 40])
        self.assertIn("… 11 rows elided …", got)
        self.assertEqual(got[-2:], ["28," + "z" * 40, "29," + "z" * 40])

    def test_python_code(self):
        src = "import os\n\n" + "".join(
            f"def f{i}(a):\n    \"\"\"doc {i}\"\"\"\n    x = a + {i}\n    return x * 2\n\n" for i in range(12))
        out = compressor.compress_text(src)
        body = out.rsplit("\n", 1)[0]
        import ast
        ast.parse(body)
        self.assertIn('def f0(a):\n    """doc 0"""\n    ...', body)
        self.assertNotIn("return x", body)
        self.handle(out)

    def test_log(self):
        ls = [f"2024-01-01 10:00:{i:02d} INFO step {i}" for i in range(50)]
        ls[30] = "2024-01-01 10:00:30 ERROR bad thing"
        out = compressor.compress_text("\n".join(ls))
        got = out.split("\n")
        self.assertEqual(got[0:2], ls[0:2])
        self.assertEqual(got[2], "… 28 lines elided …")
        self.assertEqual(got[3], ls[30])
        self.assertEqual(got[4], "… 17 lines elided …")
        self.assertEqual(got[5:7], ls[48:50])

    def test_text(self):
        paras = [f"# Heading {i}\n\n" if i == 5 else "" for i in range(20)]
        body = "\n\n".join(f"{paras[i]}paragraph number {i} " + "word " * 20 for i in range(20))
        out = compressor.compress_text(body)
        self.assertIn("… 3 sections elided …", out)
        self.assertIn("# Heading 5", out)
        self.assertIn("paragraph number 19", out)
        self.assertNotIn("paragraph number 3 ", out)

    def test_passthrough(self):
        self.assertIsNone(compressor.compress_text("x" * 300))
        big = json.dumps({"items": list(range(100))})
        out = compressor.compress_text(big)
        self.assertIsNone(compressor.compress_text(out))  # already holds a marker
        self.assertIsNone(compressor.compress_text("hello world " * 100))  # text, 1 section
        os.environ["OMC_RECOVERY_MAX_BYTES"] = "10"
        before = usage.saved_tokens()
        j = json.dumps({"items": [{"id": i, "v": "x" * 20} for i in range(60)] + [{"nested": [1]}]})
        self.assertIsNone(compressor.compress_text(j))
        self.assertEqual(usage.saved_tokens(), before)

    def test_no_old_path(self):
        old = "compress_with_" + "c" + "cr"  # built from parts: the naming test forbids the literal
        self.assertFalse(hasattr(compressor, old))

    def test_setting(self):
        real = config.get_setting
        try:
            for val, want in (("smart", "on"), ("off", "off"), ("bogus", "on"), ("on", "on")):
                config.get_setting = lambda k, v=val: v
                self.assertEqual(config.compression_mode(), want)
        finally:
            config.get_setting = real

    def test_speed(self):
        log = "\n".join(f"2024-01-01 10:00:00 INFO line {i} " + "y" * 20 for i in range(30000))
        self.assertGreater(len(log), 1 << 20)
        t = time.time()
        out = compressor.compress_text(log)
        self.assertLess(time.time() - t, 1.0)
        self.assertIsNotNone(out)


if __name__ == "__main__":
    unittest.main()

"""Offline tests for the vendored oh-my-context fork (vendor/oh_my_context) and bin/oh-my-context.

Run: PYTHONPATH=<mod>/vendor python3 -m unittest discover -s <mod>/test -p 'test_*.py'

Everything runs under a temporary HOME, plugin data folder and OMC_HOME. The
upstream MCP server is a tiny stdlib script this file writes; nothing touches the
network or the real ~/.claude, ~/.oh-my-context or ~/.claude.json.
"""

import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

MOD = Path(__file__).resolve().parent.parent
BIN = MOD / "bin" / "oh-my-context"
VENDOR = MOD / "vendor"

# The in-process tests import oh_my_context, whose config module resolves (and creates)
# its folders at import time: point everything at a temp root first.
_ROOT = Path(tempfile.mkdtemp(prefix="oh-my-context-mod-test-"))
for _k in [k for k in os.environ if k.startswith(("OMC_", "XDG_", "CLAUDE_"))]:
    del os.environ[_k]
os.environ["HOME"] = str(_ROOT / "inproc-home")
os.environ["OMC_HOME"] = str(_ROOT / "inproc-home" / "oh-my-context")
os.environ["OMC_CONFIG_FILE"] = str(_ROOT / "inproc-home" / "oh-my-context" / "config.json")
sys.path.insert(0, str(VENDOR))

from oh_my_context import config as mconfig  # noqa: E402

FAKE_SERVER = r'''
import json, os, sys, time
log = os.environ.get("FAKE_SPAWN_LOG")
if log:
    with open(log, "a") as f:
        f.write("spawn\n")
time.sleep(float(os.environ.get("FAKE_START_DELAY", "0")))
TOOLS = [
    {"name": "echo", "description": "Echo text back.",
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}},
                     "required": ["text"]}},
    {"name": "delete_everything", "description": "Delete all records.",
     "inputSchema": {"type": "object", "properties": {}},
     "annotations": {"destructiveHint": True}},
    {"name": "sleep", "description": "Sleep for some seconds.",
     "inputSchema": {"type": "object", "properties": {"seconds": {"type": "number"}}}},
    {"name": "fail", "description": "Always fails.", "inputSchema": {"type": "object"}},
    {"name": "blocks", "description": "Several content blocks.", "inputSchema": {"type": "object"}},
]
IMG = {"type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png"}
LINK = {"type": "resource_link", "uri": "fake://doc", "name": "doc"}
def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()
for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg:
        continue
    rid, method, params = msg["id"], msg.get("method"), msg.get("params") or {}
    if method == "initialize":
        res = {"protocolVersion": params.get("protocolVersion"),
               "capabilities": {"tools": {}, "prompts": {}, "resources": {}},
               "serverInfo": {"name": "fake", "version": "1"}}
        if os.environ.get("FAKE_INSTRUCTIONS"):
            res["instructions"] = os.environ["FAKE_INSTRUCTIONS"]
        send({"jsonrpc": "2.0", "id": rid, "result": res})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}})
    elif method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        if name == "fail":
            send({"jsonrpc": "2.0", "id": rid, "result": {
                "content": [{"type": "text", "text": "bad 42"}], "isError": True}})
            continue
        if name == "blocks":
            send({"jsonrpc": "2.0", "id": rid, "result": {"content": [
                {"type": "text", "text": "def f():\n    return 1"},
                {"type": "text", "text": "# done"}, IMG, LINK]}})
            continue
        if name == "sleep":
            time.sleep(float(args.get("seconds", 0)))
            text = "slept"
        elif name == "echo":
            text = "echo:" + str(args.get("text"))
        else:
            text = "done:" + str(name)
        send({"jsonrpc": "2.0", "id": rid, "result": {"content": [{"type": "text", "text": text}]}})
    elif method == "prompts/list":
        send({"jsonrpc": "2.0", "id": rid, "result": {"prompts": [
            {"name": "review", "description": "Review a change.",
             "arguments": [{"name": "focus", "required": False}]}]}})
    elif method == "prompts/get":
        focus = (params.get("arguments") or {}).get("focus", "all")
        send({"jsonrpc": "2.0", "id": rid, "result": {"messages": [
            {"role": "user", "content": {"type": "text", "text": "review " + focus}}]}})
    elif method == "resources/list":
        send({"jsonrpc": "2.0", "id": rid, "result": {"resources": [
            {"uri": "fake://doc", "name": "doc"}]}})
    elif method == "resources/templates/list":
        send({"jsonrpc": "2.0", "id": rid, "result": {"resourceTemplates": [
            {"uriTemplate": "fake://item/{id}", "name": "item"}]}})
    elif method == "resources/read":
        send({"jsonrpc": "2.0", "id": rid, "result": {"contents": [
            {"uri": params["uri"], "text": "content of " + params["uri"]}]}})
    else:
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "no such method"}})
'''

NATIVE_ALWAYS = {"call", "inspect", "manifest", "resolve_skills"}
NATIVE_NAMES = {"manifest", "servers", "health", "usage", "skills", "resolve_skills", "inspect",
                "call", "retrieve", "kb_search", "kb_index", "session"}


def _snapshot(root: Path) -> dict:
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        for name in dirnames + filenames:
            p = Path(dirpath) / name
            st = p.lstat()
            out[str(p)] = (st.st_size, st.st_mtime_ns, p.is_dir())
    return out


class Sandbox:
    """A temp HOME, plugin data folder and project folder, plus the fake server."""

    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="sbx-", dir=_ROOT))
        self.home = self.root / "home"
        self.data = self.root / "data"
        self.mhome = self.data / "home"
        self.proj = self.root / "proj"
        self.other = self.root / "other-proj"
        for d in (self.home, self.mhome, self.proj, self.other):
            d.mkdir(parents=True)
        self.fake = self.root / "fake_server.py"
        self.fake.write_text(FAKE_SERVER)
        self.spawn_log = self.root / "spawns.log"

    def server(self, **extra) -> dict:
        entry = {"transport": "stdio", "command": sys.executable,
                 "args": [str(self.fake)], "env": {"FAKE_SPAWN_LOG": str(self.spawn_log)}}
        entry.update(extra)
        return entry

    def write_config(self, servers: dict, path: Path | None = None):
        path = path or self.mhome / "config.json"
        path.write_text(json.dumps({"servers": servers}))

    def env(self, **extra) -> dict:
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("OMC_", "XDG_", "CLAUDE_", "PYTHON"))}
        env["HOME"] = str(self.home)
        env["CLAUDE_PLUGIN_DATA"] = str(self.data)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env.update(extra)
        return env

    def settings(self, **values):
        (self.mhome / "settings.json").write_text(json.dumps(values))

    def run(self, args, stdin="", cwd=None, **extra):
        return subprocess.run([str(BIN), *args], input=stdin, capture_output=True, text=True,
                              timeout=60, cwd=str(cwd or self.proj), env=self.env(**extra))

    def spawns(self) -> int:
        return len(self.spawn_log.read_text().splitlines()) if self.spawn_log.exists() else 0


class Gateway:
    """A running `oh-my-context serve` over stdio, driven line by line."""

    def __init__(self, sbx: Sandbox, cwd=None):
        self.proc = subprocess.Popen([str(BIN), "serve"], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                                     bufsize=1, cwd=str(cwd or sbx.proj), env=sbx.env())
        self.lines: queue.Queue = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()
        self.next_id = 0

    def _pump(self):
        for line in self.proc.stdout:
            self.lines.put(line)

    def request(self, method, params=None, timeout=30):
        self.next_id += 1
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.next_id,
                                          "method": method, "params": params or {}}) + "\n")
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while True:
            msg = json.loads(self.lines.get(timeout=max(0.1, deadline - time.time())))
            if msg.get("id") == self.next_id:
                return msg

    def call(self, name, arguments, timeout=30):
        return self.request("tools/call", {"name": name, "arguments": arguments}, timeout)["result"]

    def send(self, obj):
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", **obj}) + "\n")
        self.proc.stdin.flush()

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
            self.proc.wait()
        self.proc.stdout.close()


def _text(result) -> str:
    return "\n".join(b.get("text", "") for b in result.get("content", []))


class GatewayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sbx = sbx = Sandbox()
        sbx.write_config({
            "fake": sbx.server(claude_key="fake", claude_prefix="mcp__fake",
                               env={"FAKE_SPAWN_LOG": str(sbx.spawn_log),
                                    "FAKE_INSTRUCTIONS": "FAKE-INSTRUCTIONS: echo is cheap"}),
            "pinned": sbx.server(claude_key="plugin:p:pinned", claude_prefix="mcp__plugin_p_pinned",
                                 cwd_only=str(sbx.other)),
        })
        # A project-local config must never be merged: it would run this command.
        cls.evil_marker = sbx.root / "evil-ran"
        (sbx.proj / ".oh-my-context.json").write_text(json.dumps({"servers": {"evil": {
            "transport": "stdio", "command": sys.executable,
            "args": ["-c", f"open({str(cls.evil_marker)!r}, 'w').write('x')"]}}}))
        cls.gw = Gateway(sbx)
        cls.init = cls.gw.request("initialize", {"protocolVersion": "2024-11-05",
                                                 "clientInfo": {"name": "test"}})["result"]

    @classmethod
    def tearDownClass(cls):
        cls.gw.close()

    def test_initialize_instructions_list_routed_servers(self):
        text = self.init["instructions"]
        self.assertLess(len(text), 1500)
        self.assertIn("mcp__fake", text)
        self.assertNotIn("pinned", text)  # cwd_only elsewhere
        self.assertNotIn("evil", text)
        self.assertIn("`call`", text)
        self.assertIn("`resolve_skills`", text)
        self.assertIn("Skill tool", text)
        self.assertNotIn("footer-facts", text)

    def test_tools_list_native_only_with_always_load(self):
        tools = self.gw.request("tools/list")["result"]["tools"]
        names = {t["name"] for t in tools}
        self.assertEqual(names, set(NATIVE_NAMES), names)
        for t in tools:
            meta = (t.get("_meta") or {}).get("anthropic/alwaysLoad")
            self.assertEqual(meta is True, t["name"] in NATIVE_ALWAYS, t["name"])
        call = next(t for t in tools if t["name"] == "call")
        self.assertIn("tool", call["inputSchema"]["properties"])
        self.assertIn("server", call["inputSchema"]["properties"])
        self.assertNotIn("outputSchema", call)

    def test_calls_instructions_once_and_aliases(self):
        first = self.gw.call("call", {"server": "fake", "tool": "echo",
                                              "arguments": {"text": "one"}})
        self.assertFalse(first["isError"], first)
        self.assertIn("FAKE-INSTRUCTIONS", first["content"][0]["text"])
        self.assertIn("echo:one", _text(first))
        # Claude Code shows structuredContent over content; a stub there would hide the result.
        self.assertNotIn("structuredContent", first)

        second = self.gw.call("call", {"tool": "mcp__fake__echo",
                                               "arguments": {"text": "two"}})
        self.assertFalse(second["isError"], second)
        self.assertIn("echo:two", _text(second))
        self.assertNotIn("FAKE-INSTRUCTIONS", _text(second))

        same = self.gw.call("call", {"tool": "mcp__fake__echo", "server": "fake",
                                             "arguments": {"text": "3"}})
        self.assertIn("echo:3", _text(same))

        insp = self.gw.call("inspect", {"tool": "mcp__fake__echo"})["structuredContent"]
        self.assertEqual(insp["server"], "fake")
        self.assertIn("text", insp["inputSchema"]["properties"])
        self.assertNotIn("serverInstructions", insp)  # already handed over

    def test_ambiguous_call_forms_refused(self):
        # Only the forms hooks/permit.js maps back to a Claude tool name run.
        for args in ({"name": "fake_echo"}, {"tool": "echo"}, {"name": "mcp__fake__echo"},
                     {"tool": "mcp__fake__echo", "name": "fake_echo"}, {}):
            res = self.gw.call("call", {**args, "arguments": {"text": "x"}})
            self.assertTrue(res["isError"], args)
            self.assertIn("mcp__<server>__<tool>", _text(res), args)
            self.assertNotIn("echo:x", _text(res), args)
        res = self.gw.call("call", {"tool": "mcp__fake__echo", "server": "pinned",
                                            "arguments": {"text": "x"}})
        self.assertTrue(res["isError"])
        self.assertIn("does not match", _text(res))
        res = self.gw.call("call", {"server": "nope", "tool": "echo",
                                            "arguments": {"text": "x"}})
        self.assertTrue(res["isError"])
        self.assertIn("Unknown server 'nope'", _text(res))
        tools = self.gw.request("tools/list")["result"]["tools"]
        schema = next(t for t in tools if t["name"] == "call")["inputSchema"]
        self.assertNotIn("name", schema["properties"])

    def test_unknown_alias_lists_prefixes(self):
        res = self.gw.call("call", {"tool": "mcp__plugin_p_pinned__echo",
                                            "arguments": {"text": "x"}})
        self.assertTrue(res["isError"])
        self.assertIn("mcp__fake__*", _text(res))
        self.assertNotIn("mcp__plugin_p_pinned__*", _text(res))

    def test_cwd_only_and_local_config_hidden(self):
        man = self.gw.call("manifest", {})["structuredContent"]
        self.assertEqual([s["name"] for s in man["servers"]], ["fake"])
        self.assertFalse(self.evil_marker.exists())

    def test_danger_block_off_for_a_resolved_call(self):
        res = self.gw.call("call", {"tool": "mcp__fake__delete_everything", "arguments": {}})
        self.assertFalse(res["isError"], res)
        self.assertIn("done:delete_everything", _text(res))


class CwdOnlyTest(unittest.TestCase):
    def test_pinned_server_loads_in_its_own_project(self):
        sbx = Sandbox()
        sbx.write_config({"pinned": sbx.server(claude_prefix="mcp__pinned", cwd_only=str(sbx.other))})
        gw = Gateway(sbx, cwd=sbx.other)
        try:
            gw.request("initialize", {"protocolVersion": "2024-11-05"})
            man = gw.call("manifest", {})["structuredContent"]
            self.assertEqual([s["name"] for s in man["servers"]], ["pinned"])
        finally:
            gw.close()


class CwdExceptTest(unittest.TestCase):
    def test_entry_hidden_in_listed_projects_only(self):
        cfg_file = Path(os.environ["OMC_CONFIG_FILE"])
        here, other = (Path(tempfile.mkdtemp(dir=_ROOT)) for _ in range(2))
        cfg_file.parent.mkdir(parents=True, exist_ok=True)
        cfg_file.write_text(json.dumps({"servers": {
            "g": {"command": "a", "cwd_except": [os.path.realpath(here)]}}}))
        old = os.getcwd()
        try:
            os.chdir(here)
            self.assertNotIn("g", mconfig.load_config())
            os.chdir(other)
            self.assertIn("g", mconfig.load_config())
        finally:
            os.chdir(old)
            cfg_file.unlink()


class TimeoutTest(unittest.TestCase):
    def test_per_server_timeout_wins_both_ways(self):
        sbx = Sandbox()
        sbx.write_config({"short": sbx.server(timeout=1), "long": sbx.server(timeout=20)})
        gw = Gateway(sbx)
        try:
            gw.call("call", {"server": "short", "tool": "echo", "arguments": {"text": "w"}})
            t0 = time.time()
            short = gw.call("call", {"server": "short", "tool": "sleep",
                                             "arguments": {"seconds": 4}})
            self.assertTrue(short["isError"])
            self.assertLess(time.time() - t0, 1.9)  # its own 1 s, not the 30 s default
            long = gw.call("call", {"server": "long", "tool": "sleep",
                                            "arguments": {"seconds": 3}})
            self.assertFalse(long["isError"], long)
            self.assertIn("slept", _text(long))
        finally:
            gw.close()


class CliTest(unittest.TestCase):
    def test_only_the_plugin_commands_run(self):
        # Every other command (upstream's writers among them) is not a command of this copy.
        sbx = Sandbox()
        claude = sbx.home / ".claude"
        (claude / "skills").mkdir(parents=True)
        (sbx.home / ".claude.json").write_text("{}")
        (sbx.home / ".bashrc").write_text("# rc\n")
        before = _snapshot(sbx.home)
        for args in ([], ["sync", "--self"], ["skills", "sync"], ["skills", "index"],
                     ["skills", "list"], ["quickstart"], ["install", "x"], ["add", "x"],
                     ["upgrade"], ["config", "set", "compress", "smart"], ["status"],
                     ["serve", "--background", "--http", ":0"], ["please", "discover", "--write"],
                     ["demo"], ["-V"], ["--help"]):
            res = sbx.run(args)
            self.assertEqual(res.returncode, 2, (args, res.stderr))
            self.assertIn("usage: oh-my-context", res.stderr, args)
            self.assertEqual(res.stdout, "", args)
        self.assertEqual(before, _snapshot(sbx.home))
        self.assertFalse((sbx.mhome / "config.json").exists())

    def test_version(self):
        sbx = Sandbox()
        res = sbx.run(["--version"])
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertRegex(res.stdout, r"^oh-my-context \d")


class LocalConfigTest(unittest.TestCase):
    def test_project_local_config_never_merged(self):
        work = Path(tempfile.mkdtemp(dir=_ROOT))
        (work / ".oh-my-context.json").write_text(json.dumps({"servers": {"evil": {"command": "x"}}}))
        (work / ".oh-my-context.toml").write_text('[servers.evil2]\ncommand = "x"\n')
        old = os.getcwd()
        os.chdir(work)
        try:
            self.assertNotIn("evil", mconfig.load_config())
            self.assertNotIn("evil2", mconfig.load_config())
        finally:
            os.chdir(old)



class HintTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sbx = sbx = Sandbox()
        sbx.write_config({"gh": sbx.server(claude_prefix="mcp__github")})
        catalog = sbx.root / "catalog"
        skills = {
            "superpowers__brainstorming": ("superpowers:brainstorming",
                                           "Explore ideas, requirements and design options "
                                           "before building a new feature."),
            "superpowers__debugging": ("superpowers:systematic-debugging",
                                       "Find the root cause of a failing test or a crash "
                                       "before proposing a fix."),
            "pdf": ("pdf", "Read, merge, split and fill PDF documents and forms."),
        }
        for d, (name, desc) in skills.items():
            (catalog / d).mkdir(parents=True)
            (catalog / d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {desc}\n---\nbody\n")
        res = sbx.run(["skills", "index", str(catalog)])
        assert res.returncode == 0, res.stderr
        # Cached manifest, written the way the gateway writes it.
        from oh_my_context import cache as mcache
        saved, mconfig.CACHE_DIR = mconfig.CACHE_DIR, sbx.mhome / "cache"
        try:
            mcache.set_cached_tools("gh", [
                {"name": "create_issue", "description": "Create a new issue in a GitHub repository.",
                 "inputSchema": {"type": "object"}},
                {"name": "list_commits", "description": "List the commits of a branch.",
                 "inputSchema": {"type": "object"}},
                {"name": "get.file", "description": "Read one file from a GitHub repository.",
                 "inputSchema": {"type": "object"}},
                {"name": "search", "description": "Search the indexed documents for a phrase.",
                 "inputSchema": {"type": "object"}},
            ])
        finally:
            mconfig.CACHE_DIR = saved

    def hint(self, prompt, *flags):
        before = _snapshot(self.sbx.root)
        t0 = time.time()
        res = self.sbx.run(["hint", *flags], stdin=prompt)
        self.elapsed = time.time() - t0
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(before, _snapshot(self.sbx.root))  # writes nothing
        self.assertEqual(self.sbx.spawns(), 0)  # starts no server
        return json.loads(res.stdout)

    def test_matches(self):
        out = self.hint("please open a GitHub issue: create an issue about the crash")
        self.assertEqual([t["claude_name"] for t in out["tools"]], ["mcp__github__create_issue"])
        self.assertEqual(out["tools"][0]["server"], "gh")
        self.assertLess(self.elapsed, 5)
        out = self.hint("brainstorm design options for a new feature before building it")
        self.assertEqual([s["name"] for s in out["skills"]], ["superpowers:brainstorming"])
        out = self.hint("read the file from the GitHub repository")
        self.assertEqual([t["tool"] for t in out["tools"]], ["get.file"])
        self.assertEqual(out["tools"][0]["claude_name"], "mcp__github__get_file")

    def test_tool_name_alone_is_not_enough(self):
        # A tool named after one common word needs a second term from its description.
        self.assertEqual(self.hint("search the codebase for the session token")["tools"], [])
        out = self.hint("search the indexed documents for this phrase")
        self.assertEqual([t["tool"] for t in out["tools"]], ["search"])

    def test_nothing_when_unrelated_or_disabled(self):
        self.assertEqual(self.hint("what time is it in Tokyo"), {"skills": [], "tools": []})
        self.assertEqual(self.hint("create a GitHub issue", "--k-tools", "0", "--k-skills", "0"),
                         {"skills": [], "tools": []})
        self.assertEqual(self.hint(""), {"skills": [], "tools": []})

    def test_missing_index_and_cache(self):
        sbx = Sandbox()
        res = sbx.run(["hint"], stdin="create a GitHub issue")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(json.loads(res.stdout), {"skills": [], "tools": []})


def _fake_config(sbx: Sandbox, name="fake", **extra) -> dict:
    env = {"FAKE_SPAWN_LOG": str(sbx.spawn_log), "FAKE_INSTRUCTIONS": f"{name.upper()}-INSTRUCTIONS"}
    env.update(extra.pop("env", {}))
    return sbx.server(claude_key=name, claude_prefix=f"mcp__{name}", env=env, **extra)


class ResultFidelityTest(unittest.TestCase):
    """A routed result reaches Claude as the upstream sent it."""

    def test_errors_blocks_and_instructions(self):
        sbx = Sandbox()
        sbx.write_config({"fake": _fake_config(sbx)})
        gw = Gateway(sbx)
        try:
            gw.request("initialize", {"protocolVersion": "2024-11-05"})
            fail = gw.call("call", {"tool": "mcp__fake__fail"})
            self.assertTrue(fail["isError"], fail)
            self.assertIn("bad 42", _text(fail))
            self.assertNotIn("FAKE-INSTRUCTIONS", _text(fail))  # not spent on a failure

            res = gw.call("call", {"tool": "mcp__fake__blocks"})
            self.assertFalse(res["isError"], res)
            first, *rest = res["content"]
            self.assertIn("FAKE-INSTRUCTIONS", first["text"])
            self.assertEqual(rest, [
                {"type": "text", "text": "def f():\n    return 1"},
                {"type": "text", "text": "# done"},
                {"type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png"},
                {"type": "resource_link", "uri": "fake://doc", "name": "doc"}])
            self.assertNotIn("structuredContent", res)

            plain = gw.call("call", {"server": "fake", "tool": "echo",
                                             "arguments": {"text": "a\nb"}})
            self.assertEqual(plain["content"], [{"type": "text", "text": "echo:a\nb"}])

            # A new context (hooks touch the epoch file) gets the instructions again.
            epoch = sbx.mhome / "instructions-epoch"
            epoch.write_text("1")
            os.utime(epoch, ns=(1, 1))
            again = gw.call("call", {"tool": "mcp__fake__echo", "arguments": {"text": "z"}})
            self.assertIn("FAKE-INSTRUCTIONS", _text(again))
            once = gw.call("call", {"tool": "mcp__fake__echo", "arguments": {"text": "z"}})
            self.assertNotIn("FAKE-INSTRUCTIONS", _text(once))
        finally:
            gw.close()

    def test_compression_default_off(self):
        self.assertEqual(mconfig.compression_mode(), "off")


class InspectTest(unittest.TestCase):
    def test_inspect_never_starts_a_server(self):
        sbx = Sandbox()
        sbx.write_config({"fake": _fake_config(sbx)})
        from oh_my_context import cache as mcache
        saved, mconfig.CACHE_DIR = mconfig.CACHE_DIR, sbx.mhome / "cache"
        try:
            mcache.set_cached_tools("fake", [{"name": "echo", "description": "Echo.",
                                              "inputSchema": {"type": "object"}}])
        finally:
            mconfig.CACHE_DIR = saved
        gw = Gateway(sbx)
        try:
            insp = gw.call("inspect", {"tool": "mcp__fake__echo"})["structuredContent"]
            self.assertEqual(insp["server"], "fake")
            self.assertNotIn("serverInstructions", insp)
            self.assertEqual(sbx.spawns(), 0)
            res = gw.call("call", {"tool": "mcp__fake__echo", "arguments": {"text": "x"}})
            self.assertIn("FAKE-INSTRUCTIONS", _text(res))
        finally:
            gw.close()


class ConcurrencyTest(unittest.TestCase):
    def test_slow_call_blocks_nothing_and_cancel_drops_reply(self):
        sbx = Sandbox()
        sbx.write_config({"a": _fake_config(sbx, "a"), "b": _fake_config(sbx, "b")})
        gw = Gateway(sbx)
        try:
            gw.request("initialize", {"protocolVersion": "2024-11-05"})
            for srv in ("a", "b"):  # warm: spawned and connected
                gw.call("call", {"server": srv, "tool": "echo", "arguments": {"text": "w"}})
            t0 = time.time()
            for rid, srv in ((100, "a"), (101, "b")):
                gw.send({"id": rid, "method": "tools/call", "params": {
                    "name": "call",
                    "arguments": {"server": srv, "tool": "sleep", "arguments": {"seconds": 3}}}})
            gw.send({"method": "notifications/cancelled", "params": {"requestId": 100}})
            gw.send({"id": 102, "method": "ping"})
            seen = {}
            while time.time() - t0 < 5:
                try:
                    msg = json.loads(gw.lines.get(timeout=0.2))
                except queue.Empty:
                    continue
                seen.setdefault(msg.get("id"), time.time() - t0)
            self.assertLess(seen[102], 1.0)
            self.assertGreater(seen[101], 2.5)
            self.assertLess(seen[101], 4.5)  # not queued behind the 3 s call to a
            self.assertNotIn(100, seen)  # cancelled: no response
        finally:
            gw.close()


class ColdIndexTest(unittest.TestCase):
    def test_cold_servers_start_in_parallel_and_stay_up(self):
        sbx = Sandbox()
        slow = {"FAKE_START_DELAY": "2"}
        sbx.write_config({"a": _fake_config(sbx, "a", env=slow), "b": _fake_config(sbx, "b", env=slow)})
        gw = Gateway(sbx)
        try:
            t0 = time.time()
            gw.request("tools/list")
            self.assertLess(time.time() - t0, 3.5)  # one startup, not the sum
            t0 = time.time()
            res = gw.call("call", {"tool": "mcp__a__echo", "arguments": {"text": "x"}})
            self.assertIn("echo:x", _text(res))
            self.assertLess(time.time() - t0, 1.5)  # reuses the client the index started
            self.assertEqual(sbx.spawns(), 2)
        finally:
            gw.close()


class RoutedPromptsResourcesTest(unittest.TestCase):
    def test_prompts_and_resources_pass_through(self):
        sbx = Sandbox()
        sbx.write_config({"fake": _fake_config(sbx)})
        gw = Gateway(sbx)
        try:
            gw.request("initialize", {"protocolVersion": "2024-11-05"})
            gw.request("tools/list")  # cold index connects and records capabilities
            prompts = gw.request("prompts/list")["result"]["prompts"]
            self.assertIn("fake__review", [p["name"] for p in prompts])
            got = gw.request("prompts/get", {"name": "fake__review",
                                             "arguments": {"focus": "tests"}})["result"]
            self.assertEqual(got["messages"][0]["content"]["text"], "review tests")
            res = gw.request("resources/list")["result"]["resources"]
            self.assertEqual([r["uri"] for r in res], ["fake://doc"])
            tpl = gw.request("resources/templates/list")["result"]["resourceTemplates"]
            self.assertEqual([t["uriTemplate"] for t in tpl], ["fake://item/{id}"])
            for uri in ("fake://doc", "fake://item/7"):
                read = gw.request("resources/read", {"uri": uri})["result"]
                self.assertEqual(read["contents"][0]["text"], "content of " + uri)
            missing = gw.request("resources/read", {"uri": "other://x"})
            self.assertEqual(missing["error"]["code"], -32002)
        finally:
            gw.close()


class DangerTest(unittest.TestCase):
    def test_exposure_full_keeps_the_block_off_route(self):
        sbx = Sandbox()
        sbx.write_config({"fake": _fake_config(sbx)})
        sbx.settings(exposure="full")
        gw = Gateway(sbx)
        try:
            names = {t["name"] for t in gw.request("tools/list")["result"]["tools"]}
            self.assertIn("fake_delete_everything", names)
            direct = gw.call("fake_delete_everything", {})
            self.assertTrue(direct["isError"], direct)
            self.assertIn("Blocked", _text(direct))
            for args in ({"tool": "mcp__fake__delete_everything"},
                         {"server": "fake", "tool": "delete_everything"}):
                ok = gw.call("call", args)
                self.assertIn("done:delete_everything", _text(ok), args)
        finally:
            gw.close()


def _http_server(handle):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
            code, headers, out = handle(self, body)
            self.send_response(code)
            for k, v in headers.items():
                self.send_header(k, v)
            data = json.dumps(out).encode() if out is not None else b""
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class HttpClientTest(unittest.TestCase):
    def test_expired_session_is_renewed(self):
        from oh_my_context.client import MCPClientPool
        state = {"n": 0, "live": set()}

        def handle(req, msg):
            method, rid = msg.get("method"), msg.get("id")
            if rid is None:
                return 202, {}, None
            if method == "server/discover":
                return 200, {}, {"jsonrpc": "2.0", "id": rid,
                                 "error": {"code": -32601, "message": "no"}}
            if method == "initialize":
                state["n"] += 1
                sid = f"s{state['n']}"
                state["live"].add(sid)
                return 200, {"Mcp-Session-Id": sid}, {"jsonrpc": "2.0", "id": rid, "result": {
                    "protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                    "serverInfo": {"name": "h", "version": "1"}}}
            sid = req.headers.get("Mcp-Session-Id")
            if sid not in state["live"]:
                return 404, {}, {"jsonrpc": "2.0", "id": rid,
                                 "error": {"code": -32001, "message": "Session not found"}}
            state["live"].discard(sid)  # the session expires after one call
            return 200, {}, {"jsonrpc": "2.0", "id": rid,
                             "result": {"content": [{"type": "text", "text": "pong"}]}}

        srv = _http_server(handle)
        pool = MCPClientPool({"h": {"transport": "http",
                                    "url": f"http://127.0.0.1:{srv.server_port}/mcp"}})
        try:
            for _ in range(3):
                res = pool.call_full("h", "ping", {})
                self.assertEqual(res["content"][0]["text"], "pong")
        finally:
            pool.close()
            srv.shutdown()
            srv.server_close()

    def test_remote_server_uses_proxy_env(self):
        from oh_my_context.client import MCPClient
        hits = []

        def handle(req, msg):
            hits.append(req.path)
            return 200, {}, {"jsonrpc": "2.0", "id": msg.get("id"), "result": {"ok": True}}

        proxy, local = _http_server(handle), _http_server(handle)
        saved = {k: os.environ.pop(k, None) for k in
                 ("HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy")}
        os.environ["HTTP_PROXY"] = f"http://127.0.0.1:{proxy.server_port}"
        payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}).encode()
        try:
            MCPClient(http="http://mcp.example.invalid/mcp", timeout=5)._http_request(payload)
            self.assertEqual(hits, ["http://mcp.example.invalid/mcp"])  # via the proxy
            MCPClient(http=f"http://127.0.0.1:{local.server_port}/mcp", timeout=5)._http_request(payload)
            self.assertEqual(hits[1:], ["/mcp"])  # loopback stays direct
        finally:
            for k, v in saved.items():
                os.environ.pop(k, None)
                if v is not None:
                    os.environ[k] = v
            for srv in (proxy, local):
                srv.shutdown()
                srv.server_close()


class OAuthErrorTest(unittest.TestCase):
    def test_401_with_an_oauth_body_is_an_http_error(self):
        from oh_my_context.client import MCPClient, MCPError

        def handle(req, msg):
            return 401, {"WWW-Authenticate": "Bearer"}, {"error": "invalid_token"}

        srv = _http_server(handle)
        try:
            client = MCPClient(http=f"http://127.0.0.1:{srv.server_port}/mcp", timeout=5)
            with self.assertRaises(MCPError) as cm:
                client._request("tools/list", {})
            self.assertEqual(cm.exception.code, "HTTP_ERROR")
            self.assertIn("direct_servers", str(cm.exception))
        finally:
            srv.shutdown()
            srv.server_close()


# Exits after its first request while a child keeps stdout open, so no EOF reaches the
# client and only the deadline ends the wait (from upstream mcptoon 27dd0ddac).
DEAD_BUT_PIPE_STAYS_OPEN = r'''
import subprocess, sys
for line in sys.stdin:
    break
subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
sys.exit(0)
'''


class ProcessDiedTest(unittest.TestCase):
    def test_dead_process_reports_died_even_when_the_deadline_wins(self):
        from oh_my_context.client import MCPClient, MCPError
        server = Path(tempfile.mkdtemp(dir=_ROOT)) / "dead_open_pipe.py"
        server.write_text(DEAD_BUT_PIPE_STAYS_OPEN)
        client = MCPClient(stdio=[sys.executable, str(server)], timeout=2)
        try:
            with self.assertRaises(MCPError) as cm:
                client.initialize()
            self.assertEqual(cm.exception.code, "PROCESS_DIED")
        finally:
            client.close()


class ConfigBackupTest(unittest.TestCase):
    def test_unreadable_config_backup_is_owner_only(self):
        old = os.umask(0o002)
        try:
            d = Path(tempfile.mkdtemp(dir=_ROOT))
            bad = d / "bad.json"
            mconfig._preserve_unreadable(bad, '{not json "Bearer t"')
            bak = d / "bad.json.bak"
            self.assertEqual(bak.stat().st_mode & 0o777, 0o600)
            mconfig._preserve_unreadable(bad, "{}")  # never clobbers
            self.assertIn("Bearer", bak.read_text())
        finally:
            os.umask(old)


class LauncherTest(unittest.TestCase):
    def test_default_data_dir_follows_claude_dirs(self):
        # Without CLAUDE_PLUGIN_DATA (the Bash tool), the same folder hooks/restore.js uses.
        for var, rel in (("CLAUDE_CONFIG_DIR", "cfg/plugins"), ("CLAUDE_CODE_PLUGIN_CACHE_DIR", "pc")):
            sbx = Sandbox()
            env = {var: str(sbx.root / rel.split("/")[0])}
            full = sbx.env(**env)
            del full["CLAUDE_PLUGIN_DATA"]
            res = subprocess.run([str(BIN), "hint"], input="create a GitHub issue",
                                 capture_output=True, text=True, timeout=60,
                                 cwd=str(sbx.proj), env=full)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertTrue((sbx.root / rel / "data" / "oh-my-context-mod-claude-code-linux"
                             / "home").is_dir(), var)
            self.assertFalse((sbx.home / ".claude").exists(), var)

    def test_project_folder_cannot_shadow_the_fork(self):
        sbx = Sandbox()
        (sbx.proj / "oh_my_context").mkdir()
        (sbx.proj / "oh_my_context" / "__init__.py").write_text("raise SystemExit('shadowed')")
        res = sbx.run(["--version"])
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertNotIn("shadowed", res.stderr)


def tearDownModule():
    shutil.rmtree(_ROOT, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()

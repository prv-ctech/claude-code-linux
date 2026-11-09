// Shared test helpers: temp git repos with an oh-my-agent profile, no network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};

export function tmp(prefix = 'oma-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

export function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
}

// A repo on branch main with one commit and a filled-in profile whose json block is `cfg`.
export function repo(cfg = {}) {
  const dir = tmp('oma-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  const json = { appType: 'web', install: 'none', lint: 'none', build: 'none', test: 'none', start: 'none', upPath: '/', mainPort: 3000, agentHosts: 'yes', ...cfg };
  write(path.join(dir, '.oma', 'project.md'), `# Project profile\n\n**Profile:** filled in\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`);
  write(path.join(dir, 'README.md'), 'x\n');
  write(path.join(dir, '.gitignore'), '/.oma/job/\n/.claude/worktrees/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export function run(cmd, args, { cwd, input, env = {} } = {}) {
  return spawnSync(cmd, args, { cwd, input, env: { ...ENV, ...env }, encoding: 'utf8', timeout: 60000 });
}

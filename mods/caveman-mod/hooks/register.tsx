import type { Hook, Register } from 'claude-code'

// Caveman's own hook scripts run as shipped (src/hooks), minus the statusline nudge and the
// cavecrew override. This module passes them the payloads the plugin's hooks would get.
type Dollar = Parameters<Hook<'session.start'>>[0]

const MODES = [
  { id: 'off', label: 'Off', command: '/caveman off' },
  { id: 'caveman', label: 'Caveman', command: '/caveman' },
  { id: 'ultracave', label: 'Ultracave', command: '/ultracave' },
  { id: 'megacave', label: 'Megacave', command: '/megacave' },
] as const

// Per-load state: the module's own variables, reset on each reload
const st = { root: '', cwd: '', sessionId: '', mode: 'off', lastPress: 0, pending: [] as string[] }

const run = async ($: Dollar, script: string, payload: Record<string, string>, subagent = false) => {
  const { stdout } = await $.process.run(['node', `${st.root}/src/hooks/${script}`, ...(subagent ? ['--subagent'] : [])], {
    stdin: JSON.stringify({ session_id: st.sessionId, cwd: st.cwd, ...payload }),
    timeoutMs: 10000,
  })
  return stdout.trim()
}

// Start and compact print the ruleset as plain text, or OK when the session is off
const takeRuleset = (out: string) => {
  if (!out || out === 'OK') return void (st.mode = 'off')
  st.pending.push(out)
  st.mode = /mode: (caveman|ultracave|megacave)/.exec(out)?.[1] ?? st.mode
}

// The prompt hook prints its context as JSON, and prints nothing while caveman is off
const takePrompt = (out: string) => {
  const ctx: string | undefined = out ? JSON.parse(out).hookSpecificOutput.additionalContext : undefined
  if (!ctx) return void (st.mode = 'off')
  st.pending.push(ctx)
  st.mode = /(?:mode: |ACTIVE \()(caveman|ultracave|megacave)/.exec(ctx)?.[1] ?? st.mode
}

const pick = async ($: Dollar, id: string, command: string) => {
  takePrompt(await run($, 'caveman-mode-tracker.js', { prompt: command }))
  st.mode = id
  $.ui.toast(`Caveman: ${id}. Rules apply from your next message.`)
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    st.root = $.plugin.root
    st.cwd = e.cwd
    st.sessionId = await $.session.id()
    // resume: reads this session's stored mode, or the configured default for a new session
    takeRuleset(await run($, 'caveman-activate.js', { source: 'resume' }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    takeRuleset(await run($, 'caveman-activate.js', { source: 'compact' }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    takePrompt(await run($, 'caveman-mode-tracker.js', { prompt: e.text }))
    return next({ ...e, context: [...(e.context ?? []), ...st.pending.splice(0)] })
  }).catch(($, e, next) => next(e))

  // Subagents get this session's active ruleset ahead of their task, as SubagentStart does
  on('agent.spawn', async ($, e, next) => {
    if (st.mode === 'off') return next(e)
    const out = await run($, 'caveman-activate.js', { agent_type: e.subagentType }, true)
    const rules: string | undefined = out ? JSON.parse(out).hookSpecificOutput.additionalContext : undefined
    return next(rules ? { ...e, prompt: `${rules}\n\n${e.prompt}` } : e)
  }).catch(($, e, next) => next(e))

  // The prompt footer, beside the model picker, shows the mode; a press cycles it. The footer
  // keeps only text and buttons. One press per second at most: the host can raise a press twice.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const ui = $.ui.resolve(e)
    return (
      <ui.Box>
        <ui.Button
          label={MODES.find(m => m.id === st.mode)?.label ?? st.mode}
          onPress={() => {
            if (Date.now() - st.lastPress < 1000) return
            st.lastPress = Date.now()
            const m = MODES[(MODES.findIndex(x => x.id === st.mode) + 1) % MODES.length]
            return pick($, m.id, m.command)
          }}
        />
      </ui.Box>
    )
  })
}

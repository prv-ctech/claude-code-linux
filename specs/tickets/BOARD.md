| # | Title | Status | Mode | Runs |
|---|---|---|---|---|
| 001 | Remove all superpowers handling from /oma | done | solo | alongside |
| 002 | oh-my-agent works with codebase-memory-mod's code-search gate | done | solo | alongside |
| 003 | Caveman style really changes how Claude replies | done | solo | alongside |
| 004 | Reply compression modes in oh-my-context-mod | done | solo | alongside |
| 005 | Tool-result compression and recovery in the gateway | done | team | alongside |
| 006 | /omc compress document minimizer | done | solo | waits for 004: both change commands/omc.md, README, plugin.json |
| 007 | /omc status shows the whole mod, plus naming check | done | solo | waits for 005, 006: needs recovery stats and saved tokens; shares commands, README, plugin.json |
| 008 | Remove caveman-mod from the repo | done | solo | waits for 004: done; shares no file with 006/007 |
| 009 | Uninstall the old mod from the user's Claude Code | draft | solo | waits for 008; then user pushes main and updates oh-my-context-mod |

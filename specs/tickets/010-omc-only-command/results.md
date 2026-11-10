# 010-omc-only-command results
A-1 | PASS | oma run lint: Validation passed, exit 0
A-2 | PASS | oma run test: node # pass 106 # fail 0, python OK
E-1 | PASS | ls commands prints omc.md
E-2 | PASS | diff of body vs 6265db6 empty
E-3 | PASS | line 2 matches exactly
E-4 | PASS | grep: only ./mods/ source path and plugin-name paths remain
E-5 | PASS | sync.js, plugin.json, marketplace.json edited; tests pass
E-6 | PASS | bin/oh-my-context untouched
E-7 | PASS | version 0.7.2
E-8 | PASS | grep -c prints 1
E-9 | PASS | validate and tests exit 0
E-10 | PASS | no oh-my-context-mod.md path reference in code

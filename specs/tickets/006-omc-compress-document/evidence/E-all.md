== E-1
backup: /tmp/tmp.gMiPf5Nenq/oh-my-context-mod/backups/083d4a56d06f-tmp.LV2CQg0k7L/notes.md.original
candidate: /tmp/tmp.gMiPf5Nenq/oh-my-context-mod/backups/083d4a56d06f-tmp.LV2CQg0k7L/notes.md.candidate
rewrite rules for the candidate:
- remove articles, filler (just, really, basically, actually, simply), pleasantries, hedging
- shorten redundant phrases ("in order to" -> "to"); drop connective fluff (however, furthermore, additionally)
- use short fragments
- keep exactly: fenced and indented code blocks, inline code, URLs and links, file paths, commands,
  env vars ($HOME, NODE_ENV), proper nouns, dates, versions, all numbers, every heading line,
  frontmatter, table rows, list nesting and numbering, and the words not/never/no/only/except
- write the result to the candidate path; then run apply
exit=0
identical
600
== E-2
compressed: /tmp/tmp.LV2CQg0k7L/notes.md 61 -> 48 tokens (21% smaller)
exit=0
ls: cannot access '/tmp/tmp.gMiPf5Nenq/oh-my-context-mod/backups/083d4a56d06f-tmp.LV2CQg0k7L/notes.md.candidate': No such file or directory
== E-5
restored: /tmp/tmp.LV2CQg0k7L/notes.md
byte-equal
no backup for /tmp/tmp.LV2CQg0k7L/notes.md
exit=1
== E-3
invalid:
headings changed: expected ["# Setup"], got ["# Install"]
inline code changed: missing "`npm start`"
paths changed: missing "/srv/app"
numbers changed: missing "8080", missing "2.1"
word "not" count dropped 1 -> 0
exit=1
untouched
== E-4
left unchanged: /tmp/tmp.LV2CQg0k7L/notes.md
ls: cannot access '/tmp/tmp.gMiPf5Nenq/oh-my-context-mod/backups/083d4a56d06f-tmp.LV2CQg0k7L/notes.md.original': No such file or directory
ls: cannot access '/tmp/tmp.gMiPf5Nenq/oh-my-context-mod/backups/083d4a56d06f-tmp.LV2CQg0k7L/notes.md.candidate': No such file or directory
== E-8
invalid: file changed since prepare

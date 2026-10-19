#!/bin/sh
# Move mods/rea-mod to npm's rea-agents dist-tags.latest: the pin in bin/rea, the skill from
# the same package, and a patch bump of the plugin version so installed copies update through
# the marketplace. Prints the new version; prints nothing when the mod is already current.
# Run by .github/workflows/rea-mod.yml.
set -eu

mod="$(cd "$(dirname "$0")/../mods/rea-mod" && pwd)"
latest="$(npm view rea-agents dist-tags.latest)"
case "${latest}" in
	'' | *[!0-9.]* | .* | *.)
		echo "update-rea-mod: npm rea-agents dist-tags.latest is not a version: '${latest}'" >&2
		exit 1
		;;
esac
current="$(sed -n 's/^VERSION=//p' "${mod}/bin/rea")"
[ "${latest}" != "${current}" ] || exit 0

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
(cd "${tmp}" && npm pack --silent "rea-agents@${latest}" > /dev/null && tar -xzf rea-agents-*.tgz)
[ -f "${tmp}/package/skills/reverse-engineer-anything/SKILL.md" ] || {
	echo "update-rea-mod: rea-agents ${latest} has no skills/reverse-engineer-anything/SKILL.md" >&2
	exit 1
}
rm -rf "${mod}/skills"
cp -R "${tmp}/package/skills" "${mod}/skills"
sed -i "s/^VERSION=.*/VERSION=${latest}/" "${mod}/bin/rea"
python3 - "${mod}/.claude-plugin/plugin.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
major, minor, patch = d["version"].split(".")
d["version"] = f"{major}.{minor}.{int(patch) + 1}"
open(p, "w").write(json.dumps(d, indent=2) + "\n")
PY
echo "${latest}"

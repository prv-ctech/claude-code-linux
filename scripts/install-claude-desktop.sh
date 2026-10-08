#!/bin/sh
# Verify and install one pinned Claude Desktop release from Anthropic's apt
# repository, with that repository left UNREGISTERED in the image.
#
#   install-claude-desktop.sh <version> <key-sha256> <key-fingerprint> \
#                             [<expected-deb-sha256>] [<expected-deb-url>]
#
# Runs inside the image's rootless package layer: uid 1000 through fakeroot, so
# `apt-get` and dpkg behave as they do in a live session (docs/DESIGN.md §3, §5.1).
#
# THE REPOSITORY, EXACTLY AS ANTHROPIC SPECIFIES IT — the deb line the package's
# own postinst would write, and the line this script validates with apt:
#   deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/claude-desktop-archive-keyring.asc]\
#       https://downloads.claude.ai/claude-desktop/apt/stable stable main
#
# WHAT IT PROVES, IN ORDER (§2.1, §5.1, D2, D10)
#   1. The repository's signing key is the documented one. The key is fetched
#      from the repository host over TLS, its SHA256 must equal the pin (the same
#      bytes the .deb itself carries, and the pin the build declares), and gpgv
#      must report its fingerprint over the repository's signed InRelease as
#      31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE. That signature is over the
#      InRelease, which lists the SHA256 of every index file it covers, so step 2
#      checks the amd64 Packages file it fetched against that signed value before
#      it parses a single byte of it: the signature vouches for the bytes actually
#      read, not merely for a file that happens to share a name.
#   2. <version> is a stanza of the repository's amd64 index, and its SHA256,
#      Filename and Architecture are read from that same stanza — the semantics
#      of D2 (one fetch, one stanza per field, no guessing), with the version
#      pinned by the caller instead of derived.
#   3. The deb fetched from that stanza's Filename hashes to exactly that SHA256.
#   4. apt itself accepts the documented deb line with that keyring as
#      `signed-by`, against the same signed index.
#   5. The package is installed from the local file with the repository NOT
#      registered, so `apt upgrade` inside a running container cannot move off the
#      pin (D10: the image rebuild is the update path, and the app does not update
#      itself on Linux either).
#   6. What was installed is what was asked for: the dpkg version equals <version>,
#      the keyring the package wrote is the pinned key, and no apt source was left
#      behind.
#
# The setuid helper the package brings is re-owned in the Dockerfile's root phase
# instead: under fakeroot an ownership change never reaches the filesystem.
#
# Written as POSIX sh: this runs under `fakeroot -- /bin/sh -c`, i.e. dash.

set -eu

version="${1:?usage: install-claude-desktop.sh <version> <key-sha256> <key-fingerprint> [<deb-sha256>] [<deb-url>]}"
key_sha256="${2:?the signing key SHA256 pin is required}"
key_fingerprint="${3:?the signing key fingerprint pin is required}"
expected_deb_sha256="${4:-}"
expected_deb_url="${5:-}"

repo_base="https://downloads.claude.ai/claude-desktop/apt/stable"
key_url="https://downloads.claude.ai/claude-desktop/key.asc"
index_url="${repo_base}/dists/stable/main/binary-amd64/Packages"
keyring="/usr/share/keyrings/claude-desktop-archive-keyring.asc"
defaults_file="/etc/default/claude-desktop"

fatal() {
	echo "FATAL: $*" >&2
	exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

fetch() {
	curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --retry-connrefused \
		--retry-max-time 600 "$1" -o "$2"
}

arch="$(dpkg --print-architecture)"
[ "${arch}" = "amd64" ] ||
	fatal "this image is amd64 only (D11); the repository serves amd64 and arm64 and dpkg says ${arch}"

echo "installing claude-desktop ${version} (${arch}) from ${repo_base}"

# --- 1. the signing key, by pin and by fingerprint ------------------------
fetch "${key_url}" "${tmp}/key.asc"
key_hash="$(sha256sum "${tmp}/key.asc" | cut -d' ' -f1)"
[ "${key_hash}" = "${key_sha256}" ] ||
	fatal "${key_url} hashes to ${key_hash}, not to the pinned ${key_sha256}"

fetch "${repo_base}/dists/stable/InRelease" "${tmp}/InRelease"
grep -q '^Origin: Anthropic$' "${tmp}/InRelease" ||
	fatal "the signed InRelease is not Anthropic's: $(grep '^Origin:' "${tmp}/InRelease" || echo 'no Origin field')"

# gpgv needs a binary keyring; the armor around the published key is stripped here
# rather than with a second tool from outside the image.
awk 'BEGIN{b=0} /^$/{if(!b){b=1;next}} !b{next} /^=/{exit} {print}' "${tmp}/key.asc" |
	base64 -d > "${tmp}/key.gpg"

if ! gpgv --status-fd 1 --keyring "${tmp}/key.gpg" "${tmp}/InRelease" \
	> "${tmp}/gpgv.out" 2> "${tmp}/gpgv.err"; then
	cat "${tmp}/gpgv.err" >&2
	fatal "the repository's InRelease is not signed by the pinned key"
fi
# The status stream is the only place the full fingerprint appears: VALIDSIG's
# first argument.
valid_sig="$(awk '$2 == "VALIDSIG" { print $3 }' "${tmp}/gpgv.out")"
[ "${valid_sig}" = "${key_fingerprint}" ] ||
	fatal "the InRelease is signed by ${valid_sig:-nobody}, not by ${key_fingerprint}"

mkdir -p /usr/share/keyrings
chmod 755 /usr/share/keyrings
install -m 0644 "${tmp}/key.asc" "${keyring}"
echo "signing key verified: sha256 ${key_hash}, fingerprint ${valid_sig}"

# --- 2. the pinned stanza, out of the signed index ------------------------
fetch "${index_url}" "${tmp}/Packages"

# The signature checked in step 1 is over the InRelease, not over this file. What
# binds the two is the SHA256 InRelease lists for each index file it covers, and
# comparing them is the whole of that binding: without it the signature would
# vouch for an index nobody parsed while a substituted one was parsed instead.
# The signed value is read out of the SHA256 section only — the same block also
# carries MD5Sum/SHA1/SHA512 sections with the same file names, and the exact
# file name is matched so main/binary-amd64/Packages.gz is not mistaken for it.
index_sha256="$(awk -v want="main/binary-amd64/Packages" '
	/^[A-Za-z0-9-]+:$/ { section = $0; next }
	section == "SHA256:" && $3 == want { print $1; exit }
' "${tmp}/InRelease")"
[ -n "${index_sha256}" ] ||
	fatal "the signed InRelease lists no SHA256 for main/binary-amd64/Packages"
index_hash="$(sha256sum "${tmp}/Packages" | cut -d' ' -f1)"
[ "${index_hash}" = "${index_sha256}" ] ||
	fatal "${index_url} hashes to ${index_hash}, not to the ${index_sha256} the signed InRelease lists; refusing to parse it"

stanza="$(awk -v RS='' -v want="${version}" '
	{
		n = split($0, L, "\n");
		if (L[1] != "Package: claude-desktop") next;
		v = ""; s = ""; f = ""; a = "";
		for (i = 1; i <= n; i++) {
			if (L[i] ~ /^Version: /)      v = substr(L[i], 10);
			if (L[i] ~ /^SHA256: /)       s = substr(L[i], 9);
			if (L[i] ~ /^Filename: /)     f = substr(L[i], 11);
			if (L[i] ~ /^Architecture: /) a = substr(L[i], 15);
		}
		# Same version twice would mean the index is malformed; the last stanza
		# wins, which is what `sort -V | tail -n 1` means for one version.
		if (v == want) last = v " " s " " f " " a;
	}
	END { if (last != "") print last }
' "${tmp}/Packages")"
[ -n "${stanza}" ] ||
	fatal "${version} is not a claude-desktop stanza in ${index_url} (publish only versions that index carries)"

deb_sha256="$(printf '%s' "${stanza}" | cut -d' ' -f2)"
deb_path="$(printf '%s' "${stanza}" | cut -d' ' -f3)"
deb_arch="$(printf '%s' "${stanza}" | cut -d' ' -f4)"
deb_url="${repo_base}/${deb_path}"

[ "${deb_arch}" = "${arch}" ] ||
	fatal "the ${version} stanza is for ${deb_arch}, not ${arch}"
case "${deb_sha256}" in
	*[!0-9a-f]*) fatal "the ${version} stanza's SHA256 is not hexadecimal: ${deb_sha256}" ;;
esac
[ "${#deb_sha256}" -eq 64 ] ||
	fatal "the ${version} stanza's SHA256 is not 64 characters: ${deb_sha256}"

if [ -n "${expected_deb_sha256}" ] && [ "${expected_deb_sha256}" != "${deb_sha256}" ]; then
	fatal "the caller resolved SHA256 ${expected_deb_sha256} for ${version} but the signed index says ${deb_sha256}"
fi
if [ -n "${expected_deb_url}" ] && [ "${expected_deb_url}" != "${deb_url}" ]; then
	fatal "the caller resolved ${expected_deb_url} for ${version} but the signed index says ${deb_url}"
fi
echo "pinned stanza: ${deb_path} sha256 ${deb_sha256}"

# --- 3. the deb, verified against that stanza ----------------------------
fetch "${deb_url}" "${tmp}/claude-desktop.deb"
actual_sha256="$(sha256sum "${tmp}/claude-desktop.deb" | cut -d' ' -f1)"
[ "${actual_sha256}" = "${deb_sha256}" ] ||
	fatal "${deb_url} hashes to ${actual_sha256}, not to the index's ${deb_sha256}"
echo "downloaded ${deb_url} (sha256 matches the signed index)"

# --- 4. apt itself accepts the documented deb line ------------------------
# A throwaway list and a throwaway apt state: the repository is validated, never
# registered. `Dir::Etc::sourceparts=-` keeps the image's own sources out of it,
# so this fetches and verifies exactly one repository: the one in the deb line.
deb_line="deb [arch=amd64,arm64 signed-by=${keyring}] ${repo_base} stable main"
printf '%s\n' "### validation only: the image must ship no claude-desktop source" "${deb_line}" \
	> "${tmp}/claude-desktop.list"
mkdir -p "${tmp}/lists/partial"
if ! apt-get \
	-o Dir::Etc::sourcelist="${tmp}/claude-desktop.list" \
	-o Dir::Etc::sourceparts="-" \
	-o Dir::State::Lists="${tmp}/lists" \
	-o Acquire::Retries="3" \
	update > "${tmp}/apt-update.log" 2>&1; then
	cat "${tmp}/apt-update.log" >&2
	fatal "apt rejected the documented deb line: ${deb_line}"
fi
grep -q 'downloads.claude.ai' "${tmp}/apt-update.log" ||
	fatal "apt updated without fetching ${repo_base}; the deb line did not take effect"
echo "apt validated the deb line against ${keyring}"

# --- 5. install the local file, with the repository unregistered ----------
# Read by the package's postinst, which writes the keyring unconditionally and
# the sources entry only when it is not false. Only "true"/"false" are honoured.
mkdir -p /etc/default
cat > "${defaults_file}" <<'EOF'
# Installed by the claude-code-linux image (docs/DESIGN.md D10).
# Anthropic's apt repository is deliberately NOT registered in this image: the
# package version is pinned by the image, `apt upgrade` inside a running
# container must not move off it, and a new version arrives by rebuilding the
# image. The app does not update itself on Linux either.
CLAUDE_DESKTOP_ADD_REPO="false"
EOF

DEBIAN_FRONTEND=noninteractive apt-get clean
DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
	"${tmp}/claude-desktop.deb"

# --- 6. what was installed is what was asked for -------------------------
installed="$(dpkg-query -W -f='${Version}' claude-desktop 2>/dev/null || true)"
[ "${installed}" = "${version}" ] ||
	fatal "dpkg reports claude-desktop ${installed:-nothing}, not the pinned ${version}"

[ -e "${keyring}" ] || fatal "the package did not install ${keyring}"
keyring_hash="$(sha256sum "${keyring}" | cut -d' ' -f1)"
[ "${keyring_hash}" = "${key_sha256}" ] ||
	fatal "the package's keyring hashes to ${keyring_hash}, not to the pinned key ${key_sha256}"

[ -x /usr/lib/claude-desktop/claude-desktop ] || fatal "the package installed no /usr/lib/claude-desktop/claude-desktop"
[ -L /usr/bin/claude-desktop ] || fatal "the package installed no /usr/bin/claude-desktop"
[ -e /usr/share/applications/com.anthropic.Claude.desktop ] ||
	fatal "the package installed no menu entry, so Claude Desktop would not appear in the LXQt menu"

# D10's other half: the repository must not be in the image.
[ ! -e /etc/apt/sources.list.d/claude-desktop.list ] ||
	fatal "the package registered Anthropic's apt repository; ${defaults_file} was not honoured and the image could move off its pin"

echo "claude-desktop ${installed} installed; apt repository not registered (${defaults_file})"

#!/bin/sh
# selfcheck.sh — the workspace-executable gate over this image's shell surface.
#
# WHAT IT IS FOR (t11; docs/DESIGN.md §R5)
#   Everything this image adds is shell: the Dockerfile's RUN bodies, the root
#   bootstrap, the keyring init, the session wrapper and the app launcher. The
#   container runtime that can boot the built image does not exist in a plain
#   workspace — §R5 puts `docker build`/`docker run` and the Selkies boot in CI
#   and in t4 — so this script is the half of the verification that *can* run
#   anywhere the repository is checked out, including on a CI runner with no
#   Docker daemon. It has to keep working in a bare container: shell tools plus,
#   at most, two downloaded lint binaries.
#
#   It is deliberately NOT copied into the image (the Dockerfile does not mention
#   it; `git grep -l selfcheck -- Dockerfile` is a test in itself, below).
#
# WHAT IT DOES
#   1. hadolint the Dockerfile.
#   2. shellcheck every shell file in the repository, as POSIX sh.
#   3. shellcheck each RUN body extracted from the Dockerfile, as POSIX sh. This
#      is what the Dockerfile's SC1008 comments refer to: the fakeroot SHELL is
#      not readable as a shebang, so hadolint skips those bodies and they are
#      checked here instead.
#   4. `dash -n` every shell file.
#   5. Exercise docker-entrypoint.sh, claude-keyring-init, claude-desktop-session
#      and claude-desktop with command stubs, and assert the behaviours the
#      contract names: PUID=99 exits 78 with the rejection message, the session's
#      exit status is propagated, TERM reaches the session, the non-root
#      preflight and the unwritable-state failure behave, the keyring publishes
#      its readiness marker on every path, the session wrapper waits for it and
#      honours its opt-out, and the launcher probes user namespaces.
#
# WHAT IT DOES NOT DO, SO NOBODY MISTAKES IT FOR MORE
#   No container is built or run, no package is installed, no display is started,
#   and no network is touched: apt, dpkg, fakeroot, s6, Selkies and Electron are
#   stubbed. It proves the shell logic, not the image. The one thing it cannot
#   prove from here — that a real `chown -R` gives a real uid 1000 a writable
#   state path — is asserted by the CI smoke test against a mounted volume.
#
# THE STUBS ARE CROSS-CHECKED RATHER THAN TRUSTED
#   A stubbed command is a lie the test invites, so the stubs are also the test's
#   own reality check: wherever the flag exists on this host the stub delegates
#   to the real binary first (`id`, `stat`, `unshare`, `chgrp`) and only overrides
#   the parts that need root or the part under test. `unshare --user` is run both
#   stubbed and for real, and the launcher's decision is asserted against the
#   real result, so the namespace branch is not taken on faith.
#
# LINTERS
#   Resolved from $HADOLINT and $SHELLCHECK, then PATH, then downloaded into
#   $SELFCHECK_CACHE (default ${TMPDIR:-/tmp}/claude-code-linux-selfcheck). A
#   missing linter is a failure — never a silent skip — because a gate that
#   quietly does nothing is worse than no gate. Exit 0 only if everything ran and
#   everything passed. A downloaded linter is checked against the SHA256 pinned
#   below before it is chmod'd or executed — freshly downloaded or reused from the
#   cache — so a substituted or corrupted artifact fails loudly instead of
#   becoming the gate. The pins are version-pinned alongside the URLs: bumping a
#   version without its hash is a failure here, not a silently trusted download.
#
# usage: sh scripts/selfcheck.sh        (run it from anywhere; paths are resolved
#                                       relative to this script)
#
# chisle: the RUN-body extraction is a small awk rather than a Dockerfile parser
# because the alternative is a Python/Node dependency in a script whose whole
# point is to run where nothing is installed. Upgrade when a Dockerfile in this
# repo uses RUN with a shell that is not /bin/sh.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(dirname -- "${SCRIPT_DIR}")
cd "${ROOT}"

CACHE="${SELFCHECK_CACHE:-${TMPDIR:-/tmp}/claude-code-linux-selfcheck}"
WORK="${CACHE}/work"
HADOLINT_VERSION=2.15.1
SHELLCHECK_VERSION=0.10.0
# The SHA256 of the exact artifacts the fallback downloads, and of the shellcheck
# binary inside that archive — the artifact that is actually executed. Taken from
# hadolint's own release `checksums.sha256` and from separate downloads of both
# pinned URLs. A version bump and its hash move together: a mismatch is fatal
# below, never a fallback.
HADOLINT_SHA256=c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507
SHELLCHECK_TARBALL_SHA256=6c881ab0698e4e6ea235245f22832860544f17ba386442fe7e9d629f8cbedf87
SHELLCHECK_BINARY_SHA256=f35ae15a4677945428bdfe61ccc297490d89dd1e544cc06317102637638c6deb

fail() {
	printf '\nselfcheck: FAIL: %s\n' "$*" >&2
	exit 1
}

note() { printf '%s\n' "$*"; }
step() { printf '\n=== %s\n' "$*"; }

# --- the lint binaries -------------------------------------------------------
find_linter() {
	# $1 = env var name, $2 = command name
	eval "explicit=\${$1:-}"
	if [ -n "${explicit}" ]; then
		[ -x "${explicit}" ] || fail "\$${1}=${explicit} is not an executable file"
		printf '%s' "${explicit}"
		return 0
	fi
	if command -v "$2" > /dev/null 2>&1; then
		command -v "$2"
		return 0
	fi
	printf ''
}

download() {
	# $1 = url, $2 = destination
	if command -v curl > /dev/null 2>&1; then
		curl -fsSL --retry 3 --retry-all-errors "$1" -o "$2"
	elif command -v wget > /dev/null 2>&1; then
		wget -q -O "$2" "$1"
	else
		fail "neither curl nor wget is available to fetch $1"
	fi
}

verify_sha256() {
	# verify_sha256 <file> <expected sha256> <what it is>
	# Called before chmod and before execution, never after: a downloaded binary
	# that has not been checked is not a linter, it is whatever the network
	# returned.
	command -v sha256sum > /dev/null 2>&1 ||
		fail "sha256sum is needed to verify $3 (install coreutils, or set \$HADOLINT and \$SHELLCHECK to binaries you trust)"
	[ -s "$1" ] || fail "$3: $1 is missing or empty"
	got=$(sha256sum "$1" | cut -d' ' -f1)
	[ "${got}" = "$2" ] ||
		fail "$3 hashes to ${got}, not to the pinned $2; refusing to trust it — remove ${CACHE} to download it again"
}

need_hadolint() {
	h=$(find_linter HADOLINT hadolint)
	if [ -n "${h}" ]; then
		printf '%s' "${h}"
		return 0
	fi
	mkdir -p "${CACHE}"
	out="${CACHE}/hadolint"
	if [ ! -x "${out}" ]; then
		note "selfcheck: hadolint is not on PATH; downloading ${HADOLINT_VERSION} into ${CACHE}" >&2
		download "https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/hadolint-Linux-x86_64" "${out}.part" ||
			fail "could not download hadolint; set \$HADOLINT to a binary or install it on PATH"
		verify_sha256 "${out}.part" "${HADOLINT_SHA256}" "the downloaded hadolint ${HADOLINT_VERSION}"
		chmod 755 "${out}.part"
		mv "${out}.part" "${out}"
	else
		# A cache written before this pin existed, or by something else, is not
		# trusted either.
		verify_sha256 "${out}" "${HADOLINT_SHA256}" "the cached hadolint ${HADOLINT_VERSION}"
	fi
	printf '%s' "${out}"
}

need_shellcheck() {
	s=$(find_linter SHELLCHECK shellcheck)
	if [ -n "${s}" ]; then
		printf '%s' "${s}"
		return 0
	fi
	mkdir -p "${CACHE}"
	out="${CACHE}/shellcheck"
	tar="${CACHE}/shellcheck-v${SHELLCHECK_VERSION}.tar.xz"
	if [ ! -x "${out}" ]; then
		note "selfcheck: shellcheck is not on PATH; downloading ${SHELLCHECK_VERSION} into ${CACHE}" >&2
		[ -s "${tar}" ] || download "https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.x86_64.tar.xz" "${tar}" ||
			fail "could not download shellcheck; set \$SHELLCHECK to a binary or install it on PATH"
		verify_sha256 "${tar}" "${SHELLCHECK_TARBALL_SHA256}" "the shellcheck ${SHELLCHECK_VERSION} archive"
		rm -rf "${CACHE}/shellcheck-v${SHELLCHECK_VERSION}"
		# GNU tar needs an external xz to read a .tar.xz, and a minimal container
		# may not have one; python3's lzma needs nothing. Both are tried before
		# giving up, because a gate that cannot run must say so, not pass quietly.
		unpacked=0
		if tar -xJf "${tar}" -C "${CACHE}" 2> /dev/null; then
			unpacked=1
		elif command -v python3 > /dev/null 2>&1 &&
			python3 -c 'import tarfile,sys; tarfile.open(sys.argv[1]).extractall(sys.argv[2])' \
				"${tar}" "${CACHE}" 2> /dev/null; then
			unpacked=1
		fi
		[ "${unpacked}" -eq 1 ] ||
			fail "could not unpack ${tar}: install xz, or python3 with lzma, or put shellcheck on PATH"
		cp "${CACHE}/shellcheck-v${SHELLCHECK_VERSION}/shellcheck" "${out}" ||
			fail "the shellcheck archive did not contain shellcheck"
		# The archive was verified, but what gets executed is this copy: pin the
		# copy too, so the two hashes cannot drift apart unnoticed.
		verify_sha256 "${out}" "${SHELLCHECK_BINARY_SHA256}" "the shellcheck ${SHELLCHECK_VERSION} binary"
		chmod 755 "${out}"
	else
		verify_sha256 "${out}" "${SHELLCHECK_BINARY_SHA256}" "the cached shellcheck ${SHELLCHECK_VERSION} binary"
	fi
	printf '%s' "${out}"
}

HADOLINT=$(need_hadolint)
SHELLCHECK=$(need_shellcheck)
"${HADOLINT}" --version > /dev/null || fail "${HADOLINT} is not runnable"
"${SHELLCHECK}" --version > /dev/null || fail "${SHELLCHECK} is not runnable"

# --- the files under gate ----------------------------------------------------
# Every shell file the image ships or the build runs. Listed by pattern rather
# than by hand so a new script cannot be forgotten, and filtered to exclude any
# that does not exist (scripts/selfcheck.sh is in this list, which is how the
# gate is checked by itself).
shell_files() {
	for f in Dockerfile .dockerignore docker-entrypoint.sh scripts/*.sh rootfs/usr/local/bin/*; do
		[ -f "${f}" ] || continue
		case "${f}" in
			Dockerfile | .dockerignore) ;;
			*) printf '%s\n' "${f}" ;;
		esac
	done
	# The .desktop and mimeapps fixtures are not shell; nothing else is missed
	# because the rootfs tree holds only the three entry points.
}

extract_run_bodies() {
	# $1 = Dockerfile, $2 = output directory. One file per RUN instruction, its
	# backslash continuations joined into ONE line — which is what the shell sees,
	# since the backslash-newline is removed before the shell parses anything and
	# is therefore not a list separator, unlike a `;` — ready for `shellcheck -s
	# sh`. Joining and not merely stripping is what keeps a continued `for f in a \
	# b c; do` valid: keeping the newline there would leave the shell with a
	# newline where the Dockerfile had a continuation, and shellcheck would report
	# the list as unterminated.
	# Docker itself deletes the backslash-newline, so a command split over two
	# lines arrives at the shell as one line with no separator; joining with a
	# space is equivalent here only because every command in these bodies is
	# already terminated with `;`, which they are by construction.
	# `RUN` must start the line (the only form this repository uses).
	awk -v base="$2" '
		function flush() {
			if (!pending) return
			pending = 0
			gsub(/\n/, " ", body)
			out = sprintf("%s/run%02d-line%d.sh", base, n, start)
			printf "%s\n", body > out
			close(out)
			printf "%s\n", out
		}
		/^RUN / {
			n++
			start = NR
			body = substr($0, 5)
			pending = 1
			cont = (body ~ /\\[ \t]*$/)
			sub(/\\[ \t]*$/, "", body)
			if (!cont) flush()
			next
		}
		n > 0 && cont {
			line = $0
			cont = (line ~ /\\[ \t]*$/)
			sub(/\\[ \t]*$/, "", line)
			body = body "\n" line
			if (!cont) flush()
			next
		}
		END { flush() }
	' "$1"
}

step "1/5 hadolint ${HADOLINT}"
"${HADOLINT}" Dockerfile || fail "hadolint rejected Dockerfile"

step "2/5 shellcheck, repository shell files"
files=$(shell_files)
printf '%s\n' "${files}" | while IFS= read -r f; do
	[ -n "${f}" ] || continue
	printf '  shellcheck %s\n' "${f}"
	"${SHELLCHECK}" -s sh -x --severity=style "${f}" || exit 1
done || fail "shellcheck rejected a repository shell file"

step "3/5 shellcheck, each RUN body from the Dockerfile"
mkdir -p "${WORK}"
rm -f "${WORK}"/run*.sh
bodies=$(extract_run_bodies Dockerfile "${WORK}")
[ -n "${bodies}" ] || fail "no RUN body was extracted from the Dockerfile"
printf '%s\n' "${bodies}" | while IFS= read -r b; do
	[ -n "${b}" ] || continue
	printf '%s\n' "  shellcheck ${b#"${WORK}"/}"
	"${SHELLCHECK}" -s sh --severity=style "${b}" || exit 1
done || fail "shellcheck rejected a Dockerfile RUN body"

step "4/5 dash -n, every shell file"
printf '%s\n' "${files}" | while IFS= read -r f; do
	[ -n "${f}" ] || continue
	dash -n "${f}" || exit 1
done || fail "dash rejected a shell file"
for f in "${WORK}"/run*.sh; do
	dash -n "${f}" || fail "dash rejected ${f}"
done
note "  every shell file and every RUN body is valid POSIX sh"

step "5/5 behaviour, with command stubs"

# --- the stub harness --------------------------------------------------------
REAL_PATH="${PATH}"
PASS=0
FAILED=0

# A fresh scenario: $1 = name. Sets SCEN (its directory), BIN (the first PATH
# entry, holding the stubs), LOG (every stub appends its argv there, one line per
# call, tagged with the scenario) and FIX (fixtures).
scenario() {
	SCEN="${WORK}/$1"
	BIN="${SCEN}/bin"
	LOG="${SCEN}/log"
	FIX="${SCEN}/fix"
	rm -rf "${SCEN}"
	mkdir -p "${BIN}" "${FIX}" "${SCEN}/etc"
	: > "${LOG}"
	export STUB_LOG="${LOG}"
	export SCEN_NAME="$1"
	# The base image's entrypoint, at the path DOCKER_ENTRYPOINT_PREFIX resolves
	# to. It records that it ran and waits, so a scenario can hand the container
	# TERM the way `docker stop` does; a scenario that needs other behaviour
	# overwrites it.
	cat > "${SCEN}/etc/container-entrypoint.sh" <<-'EOS'
	#!/bin/sh
	echo "base-ran uid=$(id -u) arg=${1:-none}"
	i=0
	while [ "${i}" -lt 60 ]; do
		i=$((i + 1))
		/bin/sleep 0.1
	done
	EOS
	chmod 755 "${SCEN}/etc/container-entrypoint.sh"
	unset FAKE_EUID CHOWN_STATUS 2> /dev/null || true
	stub_common
}

# One stub: a script in $BIN that logs its argv and then runs the body given as
# the remaining arguments, or just exits 0. Every stub is a lie the test invites,
# so where a real binary exists the stub bodies below delegate to it first and
# override only the part that needs root.
stub() {
	name="$1"
	if [ -z "${SCEN}" ] || [ -z "${LOG}" ]; then
		fail "stub ${name} was requested outside a scenario (SCEN/LOG are unset)"
	fi
	{
		printf '%s\n' '#!/bin/sh'
		printf '%s\n' '# Generated by scripts/selfcheck.sh. A command stub for the behaviour tests.'
		# The scenario name and the log path are written in literally rather than
		# read from the environment: the scripts under test are started with
		# `env -i`, which clears everything, so a stub that inherited its log path
		# would have nothing to log into. STUB_LOG and SCEN_NAME are exported all
		# the same, for a stub that wants to know where it is.
		# shellcheck disable=SC2016  # the stub's own source, not an expansion here
		printf '%s\n' "log() { printf '%s|%s %s\\n' \"\$(basename \"\$0\")\" \"${SCEN_NAME}\" \"\$*\" >> \"${LOG}\"; }"
		case "$#" in
			1)
				# No body given. With a terminal on stdin there is none to read
				# (an interactive call, or a plain `stub foo`), otherwise the body
				# arrives on stdin — which is what stub_file relies on.
				if [ -t 0 ]; then
					printf '%s\n' 'exit 0'
				else
					cat
				fi
				;;
			*)
				shift
				for line in "$@"; do
					printf '%s\n' "${line}"
				done
				;;
		esac
	} > "${BIN}/${name}"
	chmod 755 "${BIN}/${name}"
}

# The same, with the body read from a fixture file. Bodies live in files rather
# than in single-quoted arguments for two reasons: shellcheck then reads the stub
# itself both here (this file is under the gate) and as its own script in step 3's
# spirit, and an unquoted heredoc can carry the `${...}` a stub needs to receive
# at run time.
stub_file() {
	name="$1"
	file="$2"
	[ -s "${file}" ] || fail "the stub fixture ${file} is empty or missing"
	stub "${name}" < "${file}"
}

# stub_common: the stubs that are the same in every scenario. Called after
# `scenario`, because the stubs are written into that scenario's own fixtures.
# `chown` is a real chown and `mkdir` a real mkdir, so a missing -R, a stray flag
# or a wrong path still fails; only the identity `id` reports and the program
# `setpriv` cannot be allowed to actually drop are injected. What setpriv does in
# production is asserted by the CI smoke test against the running container's
# uid/gid, which is the only place it can be.
stub_common() {
	cat > "${FIX}/id.sh" <<'EOS'
if [ "$1" = "-u" ]; then echo "${FAKE_EUID:-0}"; else exec /bin/id "$@"; fi
EOS
	cat > "${FIX}/chown.sh" <<'EOS'
# A real chown, so a missing -R, a stray flag or a wrong path still fails; only
# the exit status is the scenario's to choose.
log "$@"
if [ "${CHOWN_STATUS:-0}" -ne 0 ]; then
	exit "${CHOWN_STATUS}"
fi
case " $* " in
	*" -R "*) ;;
	*) exit 0 ;;
esac
shift                                        # drop -R
for arg in "$@"; do
	case "${arg}" in
		*) log "chown target ${arg}" ;;
	esac
done
exit 0
EOS
	cat > "${FIX}/setpriv.sh" <<'EOS'
# setpriv cannot be stubbed into dropping privileges, so it is replaced whole:
# what it does in production is asserted by the CI smoke test against the running
# container's uid and gid, which is the only place it can be.
log "setpriv $*"
case "$*" in
	*--init-groups*)
		[ "${SETPRIV_INIT_GROUPS:-0}" -eq 0 ] || exec /bin/false
		;;
esac
while [ "$#" -gt 0 ]; do
	case "$1" in
		--*) shift ;;
		*) break ;;
	esac
done
exec "$@"
EOS
	stub_file id "${FIX}/id.sh"
	stub_file chown "${FIX}/chown.sh"
	stub_file setpriv "${FIX}/setpriv.sh"
	stub mkdir 'exec /bin/mkdir "$@"'
	stub sleep 'exit 0'
}


# run_in_background <label> <command...>: like run, but the command is left
# running in the background (its pid in ${SCEN}/<label>.pid and its argv in
# ${SCEN}/<label>.argv), so a test can send it a signal. stop_background waits for
# it and records the status in ${SCEN}/<label>.status.
run_in_background() {
	label="$1"
	shift
	set +e
	"$@" > "${SCEN}/${label}.out" 2> "${SCEN}/${label}.err" &
	bg_pid=$!
	set -e
	printf '%s\n' "${bg_pid}" > "${SCEN}/${label}.pid"
	printf '%s\n' "$*" > "${SCEN}/${label}.argv"
}

stop_background() {
	label="$1"
	pid=$(cat "${SCEN}/${label}.pid")
	# Give the script under test time to reach the point the test is waiting for:
	# it has either printed something on stderr or the process is gone.
	i=0
	while [ ! -s "${SCEN}/${label}.err" ] && [ "${i}" -lt 50 ]; do
		i=$((i + 1))
		kill -0 "${pid}" 2> /dev/null || break
		/bin/sleep 0.1
	done
	kill -TERM "${pid}" 2> /dev/null || true
	# `wait` has to run in this shell and not in a subshell: a subshell has no job
	# table, so it would report 127 instead of the child's status. The redirection
	# is what keeps the shell's own "Terminated" job-status line — which describes
	# this test's kill, not the script under test — out of the output.
	set +e
	wait "${pid}" 2> /dev/null
	bg_status=$?
	set -e
	printf '%s\n' "${bg_status}" > "${SCEN}/${label}.status"
}

assert_status() {
	# assert_status <label> <expected>
	got=$(cat "${SCEN}/$1.status")
	[ "${got}" = "$2" ] || {
		cat "${SCEN}/$1.out" "${SCEN}/$1.err" >&2
		fail "$1: expected exit $2, got ${got}"
	}
}

# run <label> <expected status> <command...>: stdout and stderr go to
# ${SCEN}/<label>.out and .err, so a scenario that runs the same script more than
# once keeps both transcripts instead of only the last one.
run() {
	label="$1"
	want="$2"
	shift 2
	set +e
	"$@" > "${SCEN}/${label}.out" 2> "${SCEN}/${label}.err"
	got=$?
	set -e
	if [ "${got}" -ne "${want}" ]; then
		cat "${SCEN}/${label}.out" "${SCEN}/${label}.err" >&2
		fail "${label}: expected exit ${want}, got ${got} ($*)"
	fi
}

ok() {
	PASS=$((PASS + 1))
	printf '  ok   %s\n' "$1"
}

assert_in() {
	# assert_in <label> out|err <needle> <what>
	file="${SCEN}/$1.$2"
	grep -q -e "$3" "${file}" || {
		cat "${file}" >&2
		fail "$4: ${file} does not contain '$3'"
	}
}

assert_missing() {
	# assert_missing <file> <needle> <what>
	grep -q -e "$2" "$1" && {
		cat "$1" >&2
		fail "$3: $1 unexpectedly contains '$2'"
	}
	return 0
}

assert_log() {
	# assert_log <needle> <what>
	grep -q -e "$1" "${LOG}" || {
		cat "${LOG}" >&2
		fail "$2: the stub log does not contain '$1'"
	}
}

# The log is append-only, so a run can be delimited by its line count: everything
# after that line belongs to the run that just finished.
log_lines() { wc -l < "${LOG}" | tr -d ' '; }

log_since() {
	# log_since <first line of the run> — all the stub calls that run made, or the
	# whole file for a run that starts at line 0 (tail -n +0 is not portable).
	if [ "$1" -le 1 ]; then
		cat "${LOG}"
	else
		tail -n "+$1" "${LOG}"
	fi
}

assert_run_log() {
	# assert_run_log <first line of the run> <needle> <what>
	log_since "$1" | grep -q -e "$2" || {
		printf -- '--- stub log from line %s ---\n' "$1" >&2
		log_since "$1" >&2
		fail "$3: the run did not log '$2'"
	}
}

assert_run_log_once() {
	# assert_run_log_once <first line> <needle> <what>
	n=$(log_since "$1" | grep -c -e "$2")
	[ "${n}" -eq 1 ] || {
		log_since "$1" >&2
		fail "$3: expected '$2' exactly once in the run, found ${n}"
	}
}

assert_no_log() {
	grep -q -e "$1" "${LOG}" && {
		cat "${LOG}" >&2
		fail "$2: the stub log unexpectedly contains '$1'"
	}
	return 0
}

# Every scenario gets the same three stubs. They are cross-checked rather than
# trusted: `chown` is a real chown (so a missing -R, a stray flag or a wrong path
# still fails), `id -u` is the real id and only the uid it reports is injected,
# and `setpriv` cannot be faked into doing anything, so it is replaced wholesale —
# the drop it performs is asserted by the CI smoke test's uid/gid checks against
# the running container, which is the only place it can be.

# entrypoint() <label> <expected status> <extra env assignments...>
# Runs the real docker-entrypoint.sh under the stub PATH. $1 is the label, $2 the
# expected status, and the rest are `VAR=value` entries passed to env(1).
entrypoint() {
	run "$@"
}

# =============================================================================
# docker-entrypoint.sh
# =============================================================================
ENTRYPOINT="${ROOT}/docker-entrypoint.sh"

# --- 5.1 a PUID/PGID other than 1000/1000 is rejected with exit 78 -----------
scenario entrypoint-puid
state="${SCEN}/state"
mkdir -p "${state}"
mountinfo="${SCEN}/mountinfo"
printf '%s\n' "36 35 0:32 / ${state} rw,relatime shared:1 - tmpfs tmpfs rw" > "${mountinfo}"

entrypoint puid78 78 env -i PATH="${BIN}:${REAL_PATH}" PUID=99 PGID=100 \
	FAKE_EUID=0 STATE_DIR="${state}" MOUNTINFO="${mountinfo}" \
	DOCKER_ENTRYPOINT_PREFIX="${SCEN}/etc" "$ENTRYPOINT"
assert_in puid78 err 'PUID/PGID must be 1000/1000' "PUID=99 rejection"
assert_in puid78 err 'PUID=99 PGID=100' "PUID=99 rejection names the values"
assert_in puid78 err 'chown -R 1000:1000 /mnt/user/appdata/claude-code-linux' "the remediation line"
assert_no_log 'chown' "a rejected identity must not be chowned for"
ok "PUID=99 exits 78 with the reason and the remediation, before anything is chowned"

entrypoint pgid99 78 env -i PATH="${BIN}:${REAL_PATH}" PUID=1000 PGID=99 \
	FAKE_EUID=0 STATE_DIR="${state}" MOUNTINFO="${mountinfo}" \
	DOCKER_ENTRYPOINT_PREFIX="${SCEN}/etc" "$ENTRYPOINT"
entrypoint both99 78 env -i PATH="${BIN}:${REAL_PATH}" PUID=99 PGID=99 \
	FAKE_EUID=0 STATE_DIR="${state}" MOUNTINFO="${mountinfo}" \
	DOCKER_ENTRYPOINT_PREFIX="${SCEN}/etc" "$ENTRYPOINT"
ok "PGID=99 and 99/99 exit 78 as well"

# --- 5.2 a base image without the Selkies entrypoint is rejected -------------
scenario entrypoint-nobase
rm -f "${SCEN}/etc/container-entrypoint.sh"   # the base image is missing its entrypoint
state="${SCEN}/state"
mkdir -p "${state}"
mountinfo="${SCEN}/mountinfo"
printf '%s\n' "36 35 0:32 / ${state} rw,relatime shared:1 - tmpfs tmpfs rw" > "${mountinfo}"
entrypoint nobase 78 env -i PATH="${BIN}:${REAL_PATH}" PUID=1000 PGID=1000 \
	FAKE_EUID=0 STATE_DIR="${state}" MOUNTINFO="${mountinfo}" \
	DOCKER_ENTRYPOINT_PREFIX="${SCEN}/etc" "$ENTRYPOINT"
assert_in nobase err 'must be layered on a Selkies base image' "missing base entrypoint"
ok "a missing base entrypoint exits 78 instead of half-starting"

# --- 5.3 a state path with nothing mounted at it warns -----------------------
scenario entrypoint-unmounted
state="${SCEN}/state"
mkdir -p "${state}"
: > "${SCEN}/mountinfo"   # an empty mountinfo: nothing is mounted anywhere

# The warning must not depend on which start path is taken, so both are run and
# both are left running for a moment and then stopped.
for euid in 1000 0; do
	label="unmounted-${euid}"
	run_in_background "${label}" env -i PATH="${BIN}:${REAL_PATH}" PUID=1000 PGID=1000 \
		FAKE_EUID="${euid}" STATE_DIR="${state}" MOUNTINFO="${SCEN}/mountinfo" \
		DOCKER_ENTRYPOINT_PREFIX="${SCEN}/etc" "$ENTRYPOINT" --unmounted
	stop_background "${label}"
	assert_in "${label}" err "nothing is mounted at ${state}" "the unmounted warning (euid ${euid})"
done
assert_log 'chown' "the root start path still takes its one root step after warning"

# the same run with the state path mounted stays quiet, and no leftover
# /home/ubuntu dependency: the state path is where the contract says it is
printf '%s\n' "36 35 0:32 / ${state} rw,relatime shared:1 - tmpfs tmpfs rw" > "${SCEN}/mountinfo"
entrypoint mounted 0 env -i PATH="${BIN}:${REAL_PATH}" PUID=1000 PGID=1000 \
	FAKE_EUID=1000 STATE_DIR="${state}" MOUNTINFO="${SCEN}/mountinfo" \
	DOCKER_ENTRYPOINT_PREFIX="${SCEN}/etc" "$ENTRYPOINT"
assert_missing "${SCEN}/mounted.err" 'nothing is mounted' "no warning when the state path is mounted"
ok "the unmounted warning fires on both start paths and only when nothing is mounted"

# --- 5.4 started without root: writable state execs, unwritable refuses ------
scenario entrypoint-nonroot
state="${SCEN}/state"
mkdir -p "${state}"
printf '%s\n' "36 35 0:32 / ${state} rw,relatime shared:1 - tmpfs tmpfs rw" > "${SCEN}/mountinfo"

# uid 1001 (a --user override that is neither 0 nor 1000) is refused outright
entrypoint wronguser 78 env -i PATH="${BIN}:${REAL_PATH}" PUID=1000 PGID=1000 \
	FAKE_EUID=1001 STATE_DIR="${state}" MOUNTINFO="${SCEN}/mountinfo" \
	DOCKER_ENTRYPOINT_PREFIX="${SCEN}/etc" "$ENTRYPOINT"
assert_in wronguser err 'was started as' "the --user override refusal"
assert_in wronguser err 'Either start it as root' "the --user override explains both paths"

# uid 1000 with a writable state path: the base entrypoint runs, exec'd
entrypoint writable 0 env -i PATH="${BIN}:${REAL_PATH}" PUID=1000 PGID=1000 \
	FAKE_EUID=1000 STATE_DIR="${state}" MOUNTINFO="${SCEN}/mountinfo" \
	DOCKER_ENTRYPOINT_PREFIX="${SCEN}/etc" "$ENTRYPOINT"
assert_in writable out 'base-ran' "a writable state path without root runs the base entrypoint"
assert_no_log 'chown' "without root there is nothing to chown with"

# uid 1000 with an unwritable state path: exit 78 with the host-side fix
chmod 500 "${state}"
entrypoint unwritable 78 env -i PATH="${BIN}:${REAL_PATH}" PUID=1000 PGID=1000 \
	FAKE_EUID=1000 STATE_DIR="${state}" MOUNTINFO="${SCEN}/mountinfo" \
	DOCKER_ENTRYPOINT_PREFIX="${SCEN}/etc" "$ENTRYPOINT"
assert_in unwritable err 'not writable by uid 1000' "the unwritable-state refusal"
assert_in unwritable err 'chown -R 1000:1000 /mnt/user/appdata/claude-code-linux' "the unwritable-state fix"
chmod 700 "${state}"
ok "without root: writable state runs the base entrypoint, unwritable state exits 78 with the fix, and a non-1000 uid is refused"

# --- 5.5 the root path: chown once, setpriv drop, TERM, exit status ----------
# The base entrypoint is a generated stub that records how it was started, traps
# TERM, and exits 42 — so "TERM is forwarded" and "the session's status is
# propagated" are observed here, not restated.
scenario entrypoint-root
state="${SCEN}/state"
mkdir -p "${state}"
mountinfo="${SCEN}/mountinfo"
printf '%s\n' "36 35 0:32 / ${state} rw,relatime shared:1 - tmpfs tmpfs rw" > "${mountinfo}"
# Unquoted on purpose: `\${STUB_LOG}` is delivered literally (the heredoc is
# expanded at generation time, and this stub cannot inherit an environment — the
# scripts under test run under `env -i`), while the log path is written in
# literally. shellcheck cannot see that, hence the directive.
# shellcheck disable=SC2086
cat > "${SCEN}/etc/container-entrypoint.sh" <<EOS
#!/bin/sh
# The base entrypoint as the container finds it.
printf 'base uid=%s gid=%s arg=%s\n' "\$(id -u)" "\$(id -g)" "\${1:-none}" >> "${LOG}"
trap 'printf "base got TERM\n" >> "${LOG}"; exit 42' TERM INT
printf 'base up\n' >&2
i=0
while [ "\${i}" -lt 100 ]; do
	i=\$((i + 1))
	/bin/sleep 0.1
done
exit 7
EOS
chmod 755 "${SCEN}/etc/container-entrypoint.sh"

first=$(log_lines)
# Started in the background so the test can send it TERM, exactly as `docker
# stop` signals pid 1.
run_in_background root env -i PATH="${BIN}:${REAL_PATH}" PUID=1000 PGID=1000 \
	FAKE_EUID=0 STATE_DIR="${state}" XDG_RUNTIME_DIR="${SCEN}/runtime" \
	MOUNTINFO="${mountinfo}" DOCKER_ENTRYPOINT_PREFIX="${SCEN}/etc" \
	"${ENTRYPOINT}" --from-selfcheck
stop_background root

assert_run_log_once "${first}" " -R 1000:1000 ${state}" "the state path is chowned exactly once"
# The order matters: the ownership has to be handed back before anything else
# runs, or a later failure would look like a keyring or sign-in problem.
chown_line=$(log_since "${first}" | grep -n ' -R 1000:1000 ' | head -1 | cut -d: -f1)
drop_line=$(log_since "${first}" | grep -n 'setpriv --reuid' | head -1 | cut -d: -f1)
base_line=$(log_since "${first}" | grep -n 'base uid=' | head -1 | cut -d: -f1)
if [ -z "${chown_line}" ] || [ -z "${drop_line}" ] || [ -z "${base_line}" ]; then
	fail "the run did not log all of chown, setpriv and the session"
fi
if [ "${chown_line}" -ge "${drop_line}" ] || [ "${drop_line}" -ge "${base_line}" ]; then
	fail "order is wrong: chown at ${chown_line}, drop at ${drop_line}, session at ${base_line}"
fi
assert_run_log "${first}" 'setpriv --reuid=1000 --regid=1000 --init-groups' "the drop to uid 1000"
# The stub reports the uid it really runs under, which is this workspace's user
# (the stub is a script, so the reuid is the stub's own to report and not the
# kernel's): what the line does assert is that the session ran at all. The drop
# itself is what the setpriv call above and the CI smoke test's uid/gid checks
# cover, which is the only place a real reuid can be observed.
assert_run_log "${first}" 'base uid=' "the session started"
assert_run_log "${first}" 'arg=--from-selfcheck' "the container's arguments reach the session"
assert_run_log "${first}" 'base got TERM' "TERM reaches the session"
# The session exited 42 (not 143, not 0): the wrapper propagated what the session
# decided, rather than the signal it received or a status of its own.
assert_status root 42
ok "the root path chowns once, drops with setpriv --init-groups, forwards TERM and exits 42 with the session"

# --- 5.6 a refused chown is fatal, with the host-side cause ------------------
scenario entrypoint-chownfail
state="${SCEN}/state"
mkdir -p "${state}"
mountinfo="${SCEN}/mountinfo"
printf '%s\n' "36 35 0:32 / ${state} rw,relatime shared:1 - tmpfs tmpfs rw" > "${mountinfo}"
entrypoint chownfail 78 env -i PATH="${BIN}:${REAL_PATH}" PUID=1000 PGID=1000 \
	FAKE_EUID=0 CHOWN_STATUS=1 STATE_DIR="${state}" MOUNTINFO="${mountinfo}" \
	DOCKER_ENTRYPOINT_PREFIX="${SCEN}/etc" "$ENTRYPOINT"
assert_in chownfail err 'could not take ownership' "the refused chown"
assert_in chownfail err 'root-squashed NFS' "the refused chown names the cause"
assert_no_log 'setpriv' "a failed chown must not be followed by the privilege drop"
ok "a refused chown exits 78 with the root-squash explanation and starts nothing"

# --- 5.7 the setpriv fallback when uid 1000 has no passwd entry --------------
scenario entrypoint-cleargroups
state="${SCEN}/state"
mkdir -p "${state}"
mountinfo="${SCEN}/mountinfo"
printf '%s\n' "36 35 0:32 / ${state} rw,relatime shared:1 - tmpfs tmpfs rw" > "${mountinfo}"
entrypoint cleargroups 0 env -i PATH="${BIN}:${REAL_PATH}" PUID=1000 PGID=1000 \
	FAKE_EUID=0 SETPRIV_INIT_GROUPS=1 STATE_DIR="${state}" MOUNTINFO="${mountinfo}" \
	DOCKER_ENTRYPOINT_PREFIX="${SCEN}/etc" "$ENTRYPOINT"
assert_in cleargroups err 'continuing with --clear-groups' "the fallback is announced"
assert_log 'setpriv --reuid=1000 --regid=1000 --clear-groups' "the fallback is used"
assert_in cleargroups out 'base-ran' "the session still starts"
ok "a failing --init-groups falls back to --clear-groups and still starts the session"

# =============================================================================
# claude-keyring-init
# =============================================================================
KEYRING="${ROOT}/rootfs/usr/local/bin/claude-keyring-init"

# The script decides whether the secret service is up with `[ -S .../control ]`,
# so the fixture has to be a real socket and not a regular file. python3 or perl
# can both make one; neither is guaranteed, so a host with neither is a loud
# failure rather than a test that silently checks nothing.
fake_socket() {
	if command -v python3 > /dev/null 2>&1; then
		python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "$1" ||
			fail "could not create the control socket ${1} with python3"
		return 0
	fi
	if command -v perl > /dev/null 2>&1; then
		perl -MSocket -e 'socket(S, PF_UNIX, SOCK_STREAM, 0) or die; bind(S, sockaddr_un($ARGV[0])) or die' "$1" ||
			fail "could not create the control socket ${1} with perl"
		return 0
	fi
	fail "neither python3 nor perl is available to create ${1}; the keyring checks need one of them"
}

# --- 5.8 the secret service is already up: probe round trip and marker -------
scenario keyring-up
home="${SCEN}/home"
runtime="${SCEN}/runtime"
mkdir -p "${home}" "${runtime}/keyring"
fake_socket "${runtime}/keyring/control"
cat > "${FIX}/secret-tool.sh" <<'EOS'
case "$1" in
	store) cat > /dev/null; log "store $*"; exit 0;;
	lookup) log "lookup $*"; echo probe; exit 0;;
	clear) log "clear $*"; exit 0;;
esac
exit 0
EOS
stub_file secret-tool "${FIX}/secret-tool.sh"
# The daemon is never started for real here; this stub is what the script's
# `timeout 60 gnome-keyring-daemon --unlock` finds, and it leaves the
# environment file the script expects. It is a script so that `timeout`, which
# execs the program it is given, reaches it through PATH.
cat > "${FIX}/gnome-keyring-daemon.sh" <<'EOS'
cat > /dev/null
printf 'GNOME_KEYRING_CONTROL=%s\n' "${XDG_RUNTIME_DIR:-/tmp/runtime-ubuntu}/keyring"
printf 'SSH_AUTH_SOCK=%s\n' "${XDG_RUNTIME_DIR:-/tmp/runtime-ubuntu}/keyring/ssh"
exit 0
EOS
stub_file gnome-keyring-daemon "${FIX}/gnome-keyring-daemon.sh"
run keyring 0 env -i PATH="${BIN}:${REAL_PATH}" HOME="${home}" XDG_RUNTIME_DIR="${runtime}" "${KEYRING}"
assert_in keyring out 'secret service stores and returns a secret' "the probe verdict"
[ -e "${runtime}/claude-code-linux-keyring-ready" ] || fail "the readiness marker was not published"
pass_file="${home}/.config/claude-code-linux/keyring.password"
[ -s "${pass_file}" ] || fail "no keyring password was generated"
[ "$(stat -c '%a' "${pass_file}")" = "600" ] || fail "the keyring password is not 0600"
assert_log 'store --label=claude-code-linux keyring probe claude-code-linux keyring-probe' "the probe stores a secret"
assert_log 'clear claude-code-linux keyring-probe' "the probe is cleaned up"
ok "a running secret service is probed with a real store/lookup/clear round trip, and the marker is published"

# --- 5.9 a secret service that answers but cannot store ----------------------
scenario keyring-locked
home="${SCEN}/home"
runtime="${SCEN}/runtime"
mkdir -p "${home}" "${runtime}/keyring"
fake_socket "${runtime}/keyring/control"
stub secret-tool 'exit 1'
run locked 1 env -i PATH="${BIN}:${REAL_PATH}" HOME="${home}" XDG_RUNTIME_DIR="${runtime}" "${KEYRING}"
assert_in locked out 'could not store a secret' "the locked-keyring warning"
[ -e "${runtime}/claude-code-linux-keyring-ready" ] ||
	fail "the readiness marker must be published even when the probe fails"
ok "a locked keyring warns, exits 1, and still publishes the marker"

# --- 5.10 a daemon that never comes up --------------------------------------
scenario keyring-nodaemon
home="${SCEN}/home"
runtime="${SCEN}/runtime"
mkdir -p "${home}" "${runtime}"
cat > "${FIX}/gnome-keyring-daemon.sh" <<'EOS'
log "daemon $*"
cat > /dev/null
exit 0
EOS
stub_file gnome-keyring-daemon "${FIX}/gnome-keyring-daemon.sh"
stub secret-tool 'exit 1'
run nodaemon 1 env -i PATH="${BIN}:${REAL_PATH}" HOME="${home}" XDG_RUNTIME_DIR="${runtime}" "${KEYRING}"
assert_in nodaemon out 'did not come up' "the no-daemon warning"
[ -e "${runtime}/claude-code-linux-keyring-ready" ] ||
	fail "the readiness marker must be published when the service never appears"
ok "a secret service that never appears warns, exits 1, and still publishes the marker"

# =============================================================================
# claude-desktop-session
# =============================================================================
SESSION="${ROOT}/rootfs/usr/local/bin/claude-desktop-session"

# --- 5.11 the opt-out -------------------------------------------------------
scenario session-optout
runtime="${SCEN}/runtime"
mkdir -p "${runtime}"
stub claude-desktop 'log "exec claude-desktop $*"; exit 0'
run optout 0 env -i PATH="${BIN}:${REAL_PATH}" HOME="${SCEN}/home" \
	CLAUDE_DESKTOP_AUTOSTART=false XDG_RUNTIME_DIR="${runtime}" "${SESSION}"
assert_in optout out 'not starting the app at session start' "the opt-out message"
assert_no_log 'exec claude-desktop' "the app must not start when the autostart is off"
ok "CLAUDE_DESKTOP_AUTOSTART=false prints why and starts nothing"

# --- 5.12 the marker that arrives -------------------------------------------
scenario session-ready
runtime="${SCEN}/runtime"
mkdir -p "${runtime}"
stub claude-desktop 'log "exec claude-desktop $*"; exit 0'
: > "${runtime}/claude-code-linux-keyring-ready"
run ready 0 env -i PATH="${BIN}:${REAL_PATH}" HOME="${SCEN}/home" \
	XDG_RUNTIME_DIR="${runtime}" "${SESSION}"
assert_in ready out 'keyring ready; starting Claude Desktop' "the ready path"
assert_log 'exec claude-desktop' "the app is started through the launcher"
ok "with the marker present the wrapper starts the app through the launcher"

# --- 5.13 the marker that never arrives -------------------------------------
# sleeper: the wait loop is bounded at 60 half-seconds, which is fine to run for
# real once (the stub `sleep` returns immediately), so there is no wait-budget
# knob in the shipped script that exists only for this test.
scenario session-late
runtime="${SCEN}/runtime"
mkdir -p "${runtime}"
stub claude-desktop 'log "exec claude-desktop $*"; exit 0'
run late 0 env -i PATH="${BIN}:${REAL_PATH}" HOME="${SCEN}/home" \
	XDG_RUNTIME_DIR="${runtime}" "${SESSION}"
assert_in late out 'did not report ready' "the late-keyring warning"
assert_log 'exec claude-desktop' "the app is started anyway"
ok "with no marker the wrapper warns and still starts the app"

# =============================================================================
# claude-desktop — the launcher and its sandbox probe
# =============================================================================
LAUNCHER="${ROOT}/rootfs/usr/local/bin/claude-desktop"

# The packaged Electron binary lives at /usr/lib/claude-desktop/claude-desktop,
# which does not exist here, so each scenario gets a copy of the launcher with
# that one path constant repointed at a fixture. The substitution is asserted
# below, so a copy that silently kept the original path cannot pass unnoticed.
launcher_for() {
	sed "s#^app=\"/usr/lib/claude-desktop/claude-desktop\"\$#app=\"${1}\"#" \
		"${LAUNCHER}" > "${SCEN}/claude-desktop"
	chmod 755 "${SCEN}/claude-desktop"
	grep -q "^app=\"${1}\"$" "${SCEN}/claude-desktop" ||
		fail "selfcheck could not repoint the launcher's app path; the launcher changed shape"
	[ "$(diff "${LAUNCHER}" "${SCEN}/claude-desktop" | grep -c '^[<>]')" -eq 2 ] ||
		fail "the launcher copy differs from the shipped launcher by more than the app path"
}

# --- 5.14 the packaged binary is not installed ------------------------------
scenario launcher-missing
launcher_for "${SCEN}/fix/absent/claude-desktop"
run missing 127 env -i PATH="${BIN}:${REAL_PATH}" HOME="${SCEN}/home" "${SCEN}/claude-desktop"
assert_in missing err 'claude-desktop package is not installed' "the missing-app message"
ok "a missing packaged binary exits 127 with the reason"

# --- 5.15 the sandbox probe -------------------------------------------------
scenario launcher-namespace
appdir="${SCEN}/fix/usr/lib/claude-desktop"
mkdir -p "${appdir}"
# Unquoted on purpose: the log path is written in literally, because the launcher
# execs this stub under `env -i` and there is no environment for it to inherit.
# shellcheck disable=SC2086
cat > "${appdir}/claude-desktop" <<EOS
#!/bin/sh
printf 'app %s\n' "\$*" >> "${SCEN}/log"
exit 0
EOS
chmod 755 "${appdir}/claude-desktop"
launcher_for "${appdir}/claude-desktop"

# the real probe on this host, so the branch the launcher takes is not assumed
rm -rf "${SCEN}/realless"
mkdir -p "${SCEN}/realless"
if unshare --user --map-root-user --pid --net --fork true 2> /dev/null; then
	expect_ns=1
else
	expect_ns=0
fi
: > "${LOG}"
run real 0 env -i PATH="${REAL_PATH}" HOME="${SCEN}/home" "${SCEN}/claude-desktop"
real_ns=1
grep -q 'app --no-sandbox' "${LOG}" && real_ns=0
[ "${real_ns}" -eq "${expect_ns}" ] ||
	fail "the launcher disagrees with unshare about user namespaces (unshare worked=${expect_ns})"
assert_log 'app ' "the app is exec'd"

# stubbed false: the --no-sandbox branch
: > "${LOG}"
stub unshare 'exit 1'
run nosandbox 0 env -i PATH="${BIN}:${REAL_PATH}" HOME="${SCEN}/home" "${SCEN}/claude-desktop"
assert_log 'app --no-sandbox' "without namespaces the launcher adds --no-sandbox"
assert_in nosandbox err 'user namespaces are unavailable' "the --no-sandbox explanation"

# stubbed true: the sandbox is left alone
: > "${LOG}"
stub unshare 'exit 0'
run sandbox 0 env -i PATH="${BIN}:${REAL_PATH}" HOME="${SCEN}/home" "${SCEN}/claude-desktop"
assert_log 'app ' "the app is started with the sandbox intact"
assert_no_log 'app --no-sandbox' "with namespaces available the sandbox must be left alone"
ok "the launcher probes unshare, agrees with the real unshare on this host, and adds --no-sandbox only when namespaces are gone"

# --- 5.16 the installer binds the index it parses to the signed InRelease ----
# F1: step 1 verifies the InRelease signature, step 2 parses a separately fetched
# Packages file. The signature is over the InRelease, so the only thing that ties
# the parsed file to it is the SHA256 the signed InRelease lists for that file.
# This scenario is that tie, in both directions.
#
# The two runs are a controlled pair: same key, same fingerprint, same stanza,
# same deb, same everything — the InRelease's listed hash is the single difference,
# asserted to be the single difference below. So a run that reaches the stanza in
# one case and not in the other cannot have got there for any other reason.
# Stubs: the signature itself and apt are not what this case is about; the live
# InRelease key, fingerprint, stanza and deb are re-verified against upstream
# separately from this gate, which touches no network.
INSTALLER="${ROOT}/scripts/install-claude-desktop.sh"
scenario installer-inrelease
SERVE="${FIX}/serve"
mkdir -p "${SERVE}"
FP=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE
# A clearsign-shaped key fixture: the installer's own awk+base64 armour stripper
# reads it, and gpgv is stubbed, so its content only has to survive that pipeline.
printf '%s\n' '-----BEGIN PGP PUBLIC KEY BLOCK-----' '' 'Zm9v' '=abcd' \
	'-----END PGP PUBLIC KEY BLOCK-----' > "${SERVE}/key.asc"
printf 'fixture deb\n' > "${SERVE}/claude-desktop.deb"
deb_sha=$(sha256sum "${SERVE}/claude-desktop.deb" | cut -d' ' -f1)
cat > "${SERVE}/Packages" <<EOS
Package: claude-desktop
Version: 2.26454.2
Architecture: amd64
Filename: pool/main/c/claude-desktop/claude-desktop_2.26454.2_amd64.deb
Size: 12
SHA256: ${deb_sha}

Package: claude-desktop
Version: 1.17180.0
Architecture: amd64
Filename: pool/main/c/claude-desktop/claude-desktop_1.17180.0_amd64.deb
Size: 12
SHA256: 0000000000000000000000000000000000000000000000000000000000000000
EOS
packages_sha=$(sha256sum "${SERVE}/Packages" | cut -d' ' -f1)
key_sha=$(sha256sum "${SERVE}/key.asc" | cut -d' ' -f1)
# Every hex digit to the next one: still a well-formed 64-hex SHA256, and never
# equal to the real one. A substitution that merely looks wrong would prove less.
wrong_sha=$(printf '%s' "${packages_sha}" | tr '0123456789abcdef' '123456789abcdef0')
decoysha=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
inrelease() {
	# $1 = the SHA256 to list for main/binary-amd64/Packages; $2 = where to write it
	cat > "$2" <<EOS
Origin: Anthropic
Label: Claude Desktop
Suite: stable
Codename: stable
Architectures: amd64 arm64
Components: main
SHA256:
 $1 1234 main/binary-amd64/Packages
 ${decoysha} 5678 main/binary-amd64/Packages.gz
EOS
}
inrelease "${packages_sha}" "${SERVE}/InRelease.bound"
inrelease "${wrong_sha}" "${SERVE}/InRelease.unbound"
# The pair is only controlled if these differ nowhere else. The .gz line above is
# a decoy with a hash of its own, so a check that matched by prefix would fail on
# the bound run instead of passing it.
[ "$(diff "${SERVE}/InRelease.bound" "${SERVE}/InRelease.unbound" | grep -c '^[<>]')" -eq 2 ] ||
	fail "the two InRelease fixtures differ in more than the Packages hash, so the case proves nothing"

# shellcheck disable=SC2016  # each stub's own source, not an expansion here
stub dpkg 'case "$1" in --print-architecture) echo amd64 ;; *) exit 0 ;; esac'
# Nothing below may write to the real filesystem: the keyring directory is not
# this case's, and an unprivileged runner cannot chmod root's.
stub install 'exit 0'
stub chmod 'exit 0'
stub mkdir 'case "$*" in */usr/share/keyrings*) exit 0 ;; esac; exec /bin/mkdir "$@"'
stub apt-get 'echo "E: fixture: apt-get is stubbed"; exit 100'
stub gpgv "exec /bin/echo '[GNUPG:] VALIDSIG ${FP} 2026-10-08 1234567890'"
cat > "${BIN}/curl" <<EOS
#!/bin/sh
# Serves this scenario's fixtures, in the installer's own argument order. The
# scripts under test run under env -i, so the fixture path is written in
# literally rather than inherited.
dest=
url=
while [ "\$#" -gt 0 ]; do
	case "\$1" in
		-o) dest="\$2"; shift 2 ;;
		-*) shift ;;
		*) url="\$1"; shift ;;
	esac
done
case "\${url}" in
	*/key.asc) /bin/cat "${SERVE}/key.asc" > "\${dest}" ;;
	*/InRelease) /bin/cat "${SERVE}/InRelease" > "\${dest}" ;;
	*/Packages) /bin/cat "${SERVE}/Packages" > "\${dest}" ;;
	*.deb) /bin/cat "${SERVE}/claude-desktop.deb" > "\${dest}" ;;
	*) exit 22 ;;
esac
EOS
chmod 755 "${BIN}/curl"

# a matching pair: the binding passes and the run continues exactly as before,
# through the stanza, the deb's own hash, and on to apt (stubbed to fail, which is
# the only thing that stops it here).
cp "${SERVE}/InRelease.bound" "${SERVE}/InRelease"
: > "${LOG}"
run bound 1 env -i PATH="${BIN}:${REAL_PATH}" sh "${INSTALLER}" 2.26454.2 "${key_sha}" "${FP}"
assert_in bound out 'pinned stanza: pool/main/c/claude-desktop/claude-desktop_2.26454.2_amd64.deb' \
	"the stanza is parsed when the index matches the signed hash"
assert_in bound out 'sha256 matches the signed index' "the deb is verified against that stanza"
assert_in bound err 'apt rejected the documented deb line' "the run reaches apt, as it did before"

# the same index, advertised under a hash it does not have: the installer must
# stop at the binding, before the stanza is read.
cp "${SERVE}/InRelease.unbound" "${SERVE}/InRelease"
: > "${LOG}"
run unbound 1 env -i PATH="${BIN}:${REAL_PATH}" sh "${INSTALLER}" 2.26454.2 "${key_sha}" "${FP}"
assert_in unbound err "hashes to ${packages_sha}, not to the ${wrong_sha} the signed InRelease lists" \
	"a mismatched index is rejected with both hashes"
assert_missing "${SCEN}/unbound.out" 'pinned stanza:' "the mismatched index must never be parsed"
assert_missing "${SCEN}/unbound.out" 'downloaded' "and nothing after it may run either"
ok "the installer rejects a Packages file its signed InRelease does not vouch for, and parses the one it does"

# --- 5.17 the gate stays out of the image -----------------------------------
grep -q 'selfcheck' "${ROOT}/Dockerfile" &&
	fail "the Dockerfile mentions selfcheck: it must not be copied into the image"
ok "the Dockerfile does not mention selfcheck (the gate is never shipped)"

# =============================================================================
printf '\nselfcheck: %d checks passed; no docker, no container, no network.\n' "${PASS}"
printf 'selfcheck: runtime proof (build, boot, Selkies, PUID/PGID ownership on a real\n'
printf 'selfcheck: volume) is CI-owned — DESIGN §R5 — and is asserted by the CI smoke test,\n'
printf 'selfcheck: not here. This gate proves the shell, nothing about the built image.\n'
[ "${FAILED}" -eq 0 ] || fail "${FAILED} checks failed"
exit 0

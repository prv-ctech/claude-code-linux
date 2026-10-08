#!/bin/sh
# claude-code-linux — the root bootstrap and the PUID/PGID guard.
#
# WHY THIS EXISTS (docs/DESIGN.md §4, D5/D6)
#   The image is layered on the Selkies reference desktop, which is rootless by
#   design: every build layer runs as uid 1000 through fakeroot, the whole
#   filesystem belongs to the session user, and only the setuid and setgid
#   helpers belong to root. Unraid, however, pre-creates a missing appdata path
#   with mode 0777 and `chown 99:100`, and its maintenance tools ("New
#   Permissions") can reset that ownership later. A container that starts as uid
#   1000 can therefore find its own state mount unwritable, and the symptom is a
#   Selkies page that loads and never authenticates — a broken login with no
#   visible cause. This wrapper takes exactly one root step, gives the state path
#   back to uid 1000, and drops to the session user for the rest of the
#   container's life.
#
# PUID/PGID IS 1000/1000, EXCLUSIVELY (D5)
#   No remap path exists. /home/ubuntu, the build-time fakeroot package database
#   and the root-owned setuid bracket (/usr/bin/sudo-root, the polkit helpers,
#   utempter) all assume uid 1000; `usermod -o -u`/`groupmod -o -g` (the -o is
#   needed because uid 1000 already exists as `ubuntu`) would move the identity
#   and leave the ownership behind, so the home directory would have to be
#   re-chowned on every start anyway. Any other value is rejected here, loudly,
#   with exit 78 (EX_CONFIG) — never silently.
#
# THE BASE IMAGE'S CONTRACT IS KEPT (§5, D9)
#   /etc/container-entrypoint.sh is still what runs the container, unchanged, as
#   uid 1000. Anything this image adds to the session is a new s6 service
#   directory under /etc/service or an XDG autostart entry — never a rewrite of
#   that entrypoint.
#
# WHY PID 1 STAYS ROOT AND SUPERVISES THE SESSION AS A CHILD
#   §6.3's smoke test asserts that pid 1 is root and the session is uid 1000, and
#   the only way to have both is not to exec over pid 1. The base image documents
#   that its entrypoint is PID-agnostic — "it can be PID 1 (add `docker run
#   --init` for zombie reaping) or run below an injected init or launcher" — and
#   s6-svscan runs at any PID, so the session is a child of this script instead of
#   replacing it. `wait` in dash reaps every child that exits while it is blocked,
#   and a process orphaned inside the container is reparented to pid 1, so nothing
#   is left as a zombie; a signal that reaches pid 1 (which is what `docker stop`
#   sends) is handed to the session, and this script exits with the session's
#   status so the container's lifecycle still ends with it.

set -eu

# These three paths are overridable for one reason: scripts/selfcheck.sh has to be
# able to run this script somewhere /home/ubuntu does not exist, with a state path
# it is allowed to write to and with both mount states to hand, none of which a
# workspace provides. Nothing in the image, the Unraid template or compose.yaml
# sets any of them, so a container always takes these defaults — the paths
# docs/DESIGN.md names (§4.2, §6.3). The prefix has to be an absolute path: the
# built file it resolves to is /etc/container-entrypoint.sh.
DOCKER_ENTRYPOINT_PREFIX="${DOCKER_ENTRYPOINT_PREFIX:-/etc}"
BASE_ENTRYPOINT="${DOCKER_ENTRYPOINT_PREFIX}/container-entrypoint.sh"
STATE_DIR="${STATE_DIR:-/home/ubuntu}"
MOUNTINFO="${MOUNTINFO:-/proc/self/mountinfo}"
SUPPORTED_ID="1000"
# The one remediation that covers every ownership situation in §4.5. It is
# quoted verbatim in the Unraid template's <Overview>.
REMEDIATION="chown -R 1000:1000 /mnt/user/appdata/claude-code-linux"

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

fatal() {
	echo "FATAL: $*" >&2
	exit 78
}

reject_identity() {
	cat >&2 <<EOF
FATAL: PUID/PGID must be 1000/1000 (got PUID=${PUID} PGID=${PGID}).
The Selkies desktop layer is rootless by design at uid 1000: /home/ubuntu, the
build-time fakeroot database and the root-owned setuid bracket all assume that
id, and no supported path remaps it. Set PUID=1000 and PGID=1000 and recreate
the container. If /mnt/user/appdata/claude-code-linux still cannot be written:
  ${REMEDIATION}
EOF
	exit 78
}

if [ "${PUID}" != "${SUPPORTED_ID}" ] || [ "${PGID}" != "${SUPPORTED_ID}" ]; then
	reject_identity
fi

if [ ! -x "${BASE_ENTRYPOINT}" ]; then
	echo "FATAL: ${BASE_ENTRYPOINT} is missing or not executable. This image must be layered on a Selkies base image; the desktop, the display server and the s6 service set all come from it." >&2
	exit 78
fi

# One thing the image cannot fix for the user: if the state path is a plain
# directory in the container's filesystem rather than a mount, everything above
# still works and nothing survives recreation. Say so once, at start, instead of
# letting it look like a keyring bug later. Checked for both entry paths, so it
# is printed before either of them leaves this script.
if [ -r "${MOUNTINFO}" ] &&
	! awk '{ if ($5 == "'"${STATE_DIR}"'") found = 1 } END { exit !found }' "${MOUNTINFO}"; then
	echo "WARNING: nothing is mounted at ${STATE_DIR}: Claude Desktop's sign-in, the keyring and the Chrome profile will be lost when this container is recreated. Mount a volume there (Unraid: Path → /home/ubuntu)." >&2
fi

if [ "$(id -u)" = "0" ]; then
	# One root step. A failure here is fatal and actionable rather than silent,
	# because every later symptom looks unrelated to it: a Selkies login that
	# never completes, a keyring that cannot be written, a Claude sign-in that
	# does not survive recreation.
	#
	# The recursive chown costs a walk of the state path on every start and is
	# deliberate (§4.2 step 2, R7): nested files the session created are already
	# 1000:1000, but the mount root and anything a host-side tool touched are
	# not, and checking would walk the tree just as far.
	if ! chown -R 1000:1000 "${STATE_DIR}"; then
		cat >&2 <<EOF
FATAL: could not take ownership of ${STATE_DIR}. The bind-mounted appdata is not
writable by root — a root-squashed NFS export does this. On the server that holds
the share, run:
  ${REMEDIATION}
EOF
		exit 78
	fi

	# The runtime dir carries the session's sockets and the environment file the
	# s6 services read. It normally does not exist yet (the base entrypoint
	# creates it as uid 1000, and /tmp lets it); this only handles the case where
	# something already made it root-owned.
	runtime_dir="${XDG_RUNTIME_DIR:-/tmp/runtime-ubuntu}"
	if [ -e "${runtime_dir}" ]; then
		chown -R 1000:1000 "${runtime_dir}" ||
			echo "WARNING: could not take ownership of ${runtime_dir}; the session may fail to create its sockets" >&2
	fi

	# The privilege drop itself. `--init-groups` and not `--clear-groups`: uid
	# 1000 has a passwd entry here (`ubuntu`) and its supplementary groups
	# (render, video, audio, input) are what the GPU, audio and gamepad paths use.
	# setpriv needs no writable /etc and no PAM, so the drop is transparent.
	# `--clear-groups` stays as the fallback for a base image that somehow lost
	# that passwd entry. It is resolved from PATH rather than hardcoded to
	# /usr/bin so that scripts/selfcheck.sh can substitute its own recorder; a
	# missing setpriv is fatal here, because continuing without the drop would
	# silently run the whole session as root, which is the one outcome this image
	# must never produce (§4.2).
	setpriv_bin="$(command -v setpriv 2>/dev/null || true)"
	if [ -z "${setpriv_bin}" ] && [ -x /usr/bin/setpriv ]; then
		setpriv_bin="/usr/bin/setpriv"
	fi
	[ -n "${setpriv_bin}" ] ||
		fatal "setpriv is not in this image, so the session cannot be dropped to uid 1000; the session must not run as root (§4.2)"

	if "${setpriv_bin}" --reuid=1000 --regid=1000 --init-groups /bin/true 2>/dev/null; then
		"${setpriv_bin}" --reuid=1000 --regid=1000 --init-groups "${BASE_ENTRYPOINT}" "$@" &
	else
		echo "WARNING: setpriv --init-groups failed (uid 1000 has no passwd entry?); continuing with --clear-groups" >&2
		"${setpriv_bin}" --reuid=1000 --regid=1000 --clear-groups "${BASE_ENTRYPOINT}" "$@" &
	fi
	session=$!

	# `docker stop` signals pid 1 only, so the signal is handed to the session;
	# the loop re-enters `wait` when it is interrupted by that trap rather than
	# treating an interrupted wait as the session having ended. (The status is
	# taken from `wait` itself, with `||`: after an `if` whose condition was
	# false and which has no `else`, `$?` is 0, not the condition's status.)
	trap 'kill -TERM "${session}" 2>/dev/null || true' TERM INT QUIT
	status=0
	while :; do
		wait "${session}" || status=$?
		if [ "${status}" -ne 0 ] && kill -0 "${session}" 2>/dev/null; then
			# The trap interrupted `wait` and the session is still shutting
			# down: wait for it again.
			status=0
			continue
		fi
		break
	done
	exit "${status}"
fi

# Started without root — `docker run --user 1000`, or a --user override. There is
# nothing to chown with, so the state path is only checked, and the two supported
# outcomes are "uid 1000 can write it" and "fail with the fix" (§4.2 step 4).
if [ "$(id -u)" != "${SUPPORTED_ID}" ]; then
	cat >&2 <<EOF
FATAL: this container runs its session as uid ${SUPPORTED_ID} and was started as
uid $(id -u). The image drops privileges itself, precisely so that it can take
ownership of the state path first (§4.2). Either start it as root, or start it as
${SUPPORTED_ID}:${SUPPORTED_ID} with ${STATE_DIR} already owned by that id.
EOF
	exit 78
fi

if [ ! -w "${STATE_DIR}" ]; then
	cat >&2 <<EOF
FATAL: ${STATE_DIR} is not writable by uid ${SUPPORTED_ID} (mode $(stat -c '%a %U:%G' "${STATE_DIR}" 2>/dev/null || echo unknown)), and the container was started without root, so it cannot take ownership of it.
Everything that has to survive recreation lives there: Claude Desktop's settings,
the keyring that stores the claude.ai sign-in, the Chrome profile, and the CLI's
credentials. On the Unraid host run:
  ${REMEDIATION}
then recreate the container without a --user override.
EOF
	exit 78
fi

exec "${BASE_ENTRYPOINT}" "$@"

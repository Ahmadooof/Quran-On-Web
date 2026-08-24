#!/bin/sh
# Brings the server up to whatever passed its checks.
#
# Run by readquran-deploy.timer once a minute. The server reaches out to
# GitHub, so nothing has to reach in — which is what lets the firewall keep
# SSH closed to everyone but you.
#
# It follows `release`, not `main`. CI moves that branch only after the checks
# pass, so a red build is never picked up.

set -e

APP_DIR=/var/www/readqurantoday
cd "$APP_DIR"

# The server was cloned with --depth 1, which implies --single-branch: the
# checkout's refspec covers main and nothing else. A plain `git fetch origin
# release` would land in FETCH_HEAD and never create origin/release, so name
# the destination. Shallow, because the page fonts make the history heavy.
git fetch --quiet --depth 1 origin   '+refs/heads/release:refs/remotes/origin/release' || exit 0

# Not there yet — the first green build has not happened.
NEW="$(git rev-parse --verify --quiet origin/release)" || exit 0
OLD="$(git rev-parse HEAD)"
[ "$NEW" = "$OLD" ] && exit 0

# What is about to change, read before moving, so nginx is only touched when
# its own config did.
CHANGED="$(git diff --name-only "$OLD" "$NEW" || echo deploy/)"

# reset rather than merge: this checkout mirrors the branch and is never a
# place to edit. Anything changed here by hand is meant to lose.
git reset --hard --quiet "$NEW"

echo "deployed $(git rev-parse --short HEAD)"

# The snippets live in /etc, outside this checkout, so a pull alone misses
# them. One narrow sudo rule covers this and nothing else.
if echo "$CHANGED" | grep -q '^deploy/'; then
  sudo /usr/local/sbin/readquran-sync-nginx
fi

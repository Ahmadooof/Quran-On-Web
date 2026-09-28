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

# The feedback service's packages, installed from its lockfile whenever it
# changes (or on the first deploy that has it). Production packages only.
if [ -f feedback/package-lock.json ] &&    { echo "$CHANGED" | grep -q '^feedback/package' || [ ! -d feedback/node_modules ]; }; then
  (cd feedback && npm ci --omit=dev --no-audit --no-fund --silent)
fi

# Cloudflare keeps copies of the pages, so it is told to drop them once the new
# files are on disk — never before, or it would copy the old ones again. Only
# this hostname: the audio subdomain shares the zone and has not changed.
# /etc/readquran/cf-purge holds CF_ZONE and CF_TOKEN (a Cache Purge token only).
if echo "$CHANGED" | grep -q '^public/' && [ -r /etc/readquran/cf-purge ]; then
  . /etc/readquran/cf-purge
  curl -fsS -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE/purge_cache" \
    -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
    --data '{"hosts":["readqurantoday.com"]}' >/dev/null \
    && echo "cloudflare cache purged" || echo "cloudflare purge failed" >&2
fi

# The service reads its code once at start, so a change needs a restart.
# Another narrow sudo rule: this one command, no arguments.
if echo "$CHANGED" | grep -q '^feedback/'; then
  sudo /usr/local/sbin/readquran-restart-feedback
fi

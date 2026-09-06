#!/bin/sh
# Copies the nginx snippets out of the checkout and reloads.
#
# Installed to /usr/local/sbin/readquran-sync-nginx and owned by root, so the
# deploy user can run just this one thing as root. It takes no arguments on
# purpose: a sudoers rule that allowed `install <src> <dst>` with a wildcard
# would let the deploy user write any file anywhere as root, which is a much
# bigger key than this needs.
#
# THIS FILE IS A SOURCE, NOT WHAT RUNS. A deploy runs the installed copy, so
# editing it here changes nothing until someone runs:
#
#   sudo install -m 755 /var/www/readqurantoday/deploy/sync-nginx.sh #        /usr/local/sbin/readquran-sync-nginx
#
# Forgetting that is not harmless. Add a snippet here that another snippet
# includes, push, and the old installed copy will happily install the file
# holding the include without installing the file it includes -- `nginx -t`
# then fails on every deploy, the reload is skipped, and the running config
# stays good until something restarts nginx and it refuses to come up. That
# happened. Change this file and install it in the same sitting.
#
# Snippets only. The vhosts in sites-available are not touched, because certbot
# edits those in place to add the TLS listeners — copying the repo's version
# over them would throw the certificate config away on every deploy.

set -e

APP_DIR=/var/www/readqurantoday

install -m 644 "$APP_DIR/deploy/security-headers.conf" /etc/nginx/snippets/readquran-security.conf

# Before umami-proxy.conf, which includes it: install them the other way round
# and the first deploy fails `nginx -t` on a file that is not there yet.
if [ -f "$APP_DIR/deploy/cloudflare-realip.conf" ]; then
  install -m 644 "$APP_DIR/deploy/cloudflare-realip.conf" /etc/nginx/snippets/cloudflare-realip.conf
fi

if [ -f "$APP_DIR/deploy/umami-proxy.conf" ]; then
  install -m 644 "$APP_DIR/deploy/umami-proxy.conf" /etc/nginx/snippets/umami-proxy.conf
fi

# umami-allow.conf is deliberately not synced. It holds a home address, this
# repo is public, and the vhost has said so all along. It lives on the server
# and is written there by deploy/update-ip.bat -- which also means a deploy no
# longer reverts what that script just set, as it used to.

nginx -t
systemctl reload nginx
echo "nginx snippets synced and reloaded"

#!/bin/sh
# Copies the nginx snippets out of the checkout and reloads.
#
# Installed to /usr/local/sbin/ and owned by root, so the deploy user can run
# just this one thing as root. It takes no arguments on purpose: a sudoers rule
# that allowed `install <src> <dst>` with a wildcard would let the deploy user
# write any file anywhere as root, which is a much bigger key than this needs.
#
# Snippets only. The vhosts in sites-available are not touched, because certbot
# edits those in place to add the TLS listeners — copying the repo's version
# over them would throw the certificate config away on every deploy.

set -e

APP_DIR=/var/www/readqurantoday

install -m 644 "$APP_DIR/deploy/security-headers.conf" /etc/nginx/snippets/readquran-security.conf

if [ -f "$APP_DIR/deploy/umami-proxy.conf" ]; then
  install -m 644 "$APP_DIR/deploy/umami-proxy.conf" /etc/nginx/snippets/umami-proxy.conf
fi

# umami-allow.conf is deliberately absent here: it holds an address, is written
# on the server, and is not in the repo.

nginx -t
systemctl reload nginx
echo "nginx snippets synced and reloaded"

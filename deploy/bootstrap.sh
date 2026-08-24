#!/usr/bin/env bash
#
# Sets up a fresh Ubuntu box to serve the mushaf, in one go.
#
#   curl -fsSL https://raw.githubusercontent.com/Ahmadooof/Quran-On-Web/main/deploy/bootstrap.sh | sudo -E bash
#
# Safe to re-run: every step checks before it acts, so running it twice fixes a
# half-finished install rather than breaking a working one.
#
# Options, as environment variables:
#   DOMAIN=readqurantoday.com   the site's domain
#   EMAIL=you@example.com       for Let's Encrypt expiry notices
#   WITH_UMAMI=yes              also install analytics (needs the analytics
#                               subdomain pointing here)
#   ADMIN_IP=1.2.3.4            restrict the Umami dashboard to this address.
#                               The tracker and its collect endpoint stay open
#                               regardless - readers' browsers need them.
#   SKIP_TLS=yes                set up http only, get the certificate later

set -euo pipefail

DOMAIN="${DOMAIN:-readqurantoday.com}"
REPO="${REPO:-https://github.com/Ahmadooof/Quran-On-Web.git}"
EMAIL="${EMAIL:-}"
WITH_UMAMI="${WITH_UMAMI:-no}"
SKIP_TLS="${SKIP_TLS:-no}"
APP_DIR="${APP_DIR:-/var/www/readqurantoday}"

# The user who will own the checkout and run docker — the one who invoked sudo,
# not root, so `git pull` from CI works as that user later.
RUN_USER="${SUDO_USER:-$(id -un)}"

say()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m X\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo: curl ... | sudo -E bash"
[ "$RUN_USER" != "root" ] || warn "running as root; a limited user is better"

# ---------------------------------------------------------------- swap
# 1 GB is enough to run but not to be careless during an upgrade. This is a
# safety net, not a memory tier, hence the low swappiness.
if ! swapon --show | grep -q .; then
  say "Adding 2G swap"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -qw vm.swappiness=10
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swap.conf
else
  say "Swap already present, leaving it"
fi

# ---------------------------------------------------------------- packages
say "Installing nginx, git and certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx git curl certbot python3-certbot-nginx >/dev/null

# ---------------------------------------------------------------- firewall
# OpenSSH first and always — enabling ufw without it locks you out of your own
# machine, and there is no console to fix it from.
say "Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ufw status | head -1

# ---------------------------------------------------------------- the app
say "Fetching the site into $APP_DIR"
mkdir -p "$(dirname "$APP_DIR")"
if [ -d "$APP_DIR/.git" ]; then
  sudo -u "$RUN_USER" git -C "$APP_DIR" pull --ff-only
else
  # --depth 1 skips the history, which is most of the download: the 604 page
  # fonts are committed, so a full clone is well over 100 MB.
  git clone --depth 1 "$REPO" "$APP_DIR"
  chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
fi
# nginx runs as www-data and has to be able to traverse the path.
chmod o+x "$APP_DIR"

[ -f "$APP_DIR/public/index.html" ] || die "no public/index.html — wrong repo or branch?"

# ---------------------------------------------------------------- nginx
say "Installing the nginx config"
mkdir -p /etc/nginx/snippets
install -m 644 "$APP_DIR/deploy/security-headers.conf" /etc/nginx/snippets/readquran-security.conf
install -m 644 "$APP_DIR/deploy/$DOMAIN.conf" /etc/nginx/sites-available/ 2>/dev/null \
  || install -m 644 "$APP_DIR/deploy/readqurantoday.com.conf" "/etc/nginx/sites-available/$DOMAIN.conf"

# The config ships with the real domain baked in; rewrite if deploying another.
if [ "$DOMAIN" != "readqurantoday.com" ]; then
  sed -i "s/readqurantoday\.com/$DOMAIN/g" "/etc/nginx/sites-available/$DOMAIN.conf"
fi
sed -i "s#/var/www/readqurantoday#$APP_DIR#g" "/etc/nginx/sites-available/$DOMAIN.conf"

ln -sf "/etc/nginx/sites-available/$DOMAIN.conf" /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

nginx -t || die "nginx rejected the config — the message above names the file and line"
systemctl reload nginx
say "Serving over http"

# ---------------------------------------------------------------- deploy hook
# So a push can sync the nginx snippets without the deploy user holding
# general root. One fixed script, one sudoers line naming it.
say "Letting $RUN_USER reload nginx for a deploy"
install -m 755 "$APP_DIR/deploy/sync-nginx.sh" /usr/local/sbin/readquran-sync-nginx
echo "$RUN_USER ALL=(root) NOPASSWD: /usr/local/sbin/readquran-sync-nginx" > /etc/sudoers.d/readquran-deploy
chmod 440 /etc/sudoers.d/readquran-deploy
visudo -cf /etc/sudoers.d/readquran-deploy >/dev/null || die "bad sudoers file"

# The box asks GitHub for new work rather than being pushed to, so the
# firewall can keep SSH shut to everyone but you. It follows the `release`
# branch, which CI moves only once the checks are green.
install -m 755 "$APP_DIR/deploy/pull-deploy.sh" /usr/local/sbin/readquran-pull-deploy
install -m 644 "$APP_DIR/deploy/readquran-deploy.service" /etc/systemd/system/
install -m 644 "$APP_DIR/deploy/readquran-deploy.timer"   /etc/systemd/system/
sed -i "s/^User=.*/User=$RUN_USER/"           /etc/systemd/system/readquran-deploy.service
sed -i "s#^WorkingDirectory=.*#WorkingDirectory=$APP_DIR#" /etc/systemd/system/readquran-deploy.service
systemctl daemon-reload
systemctl enable --now readquran-deploy.timer >/dev/null
say "Deploys now arrive on their own, within a minute of a green build"

# ---------------------------------------------------------------- umami
if [ "$WITH_UMAMI" = "yes" ]; then
  say "Installing Umami"
  apt-get install -y -qq docker.io docker-compose-v2 >/dev/null
  usermod -aG docker "$RUN_USER"

  UMAMI_DIR="/home/$RUN_USER/umami"
  mkdir -p "$UMAMI_DIR"
  cp "$APP_DIR/deploy/docker-compose.umami.yml" "$UMAMI_DIR/"
  if [ ! -f "$UMAMI_DIR/.env" ]; then
    printf 'UMAMI_DB_PASSWORD=%s\nUMAMI_APP_SECRET=%s\n' \
      "$(openssl rand -base64 24)" "$(openssl rand -base64 32)" > "$UMAMI_DIR/.env"
    chmod 600 "$UMAMI_DIR/.env"
  fi
  chown -R "$RUN_USER:$RUN_USER" "$UMAMI_DIR"

  ( cd "$UMAMI_DIR" && docker compose -f docker-compose.umami.yml --env-file .env up -d )

  install -m 644 "$APP_DIR/deploy/umami-proxy.conf" /etc/nginx/snippets/umami-proxy.conf

  # Who may reach the dashboard. Kept out of the repo - it is public, and a
  # home address does not belong in it. Open unless ADMIN_IP says otherwise.
  if [ ! -f /etc/nginx/snippets/umami-allow.conf ]; then
    if [ -n "${ADMIN_IP:-}" ]; then
      cat > /etc/nginx/snippets/umami-allow.conf <<ALLOW
allow $ADMIN_IP;
deny all;
ALLOW
    else
      cat > /etc/nginx/snippets/umami-allow.conf <<'ALLOW'
# Nobody is shut out yet. Put your address here — or pass ADMIN_IP when
# bootstrapping — so the dashboard answers only to you:
#   allow 1.2.3.4;
#   deny all;
allow all;
ALLOW
    fi
  fi

  install -m 644 "$APP_DIR/deploy/analytics.readqurantoday.com.conf" \
    "/etc/nginx/sites-available/analytics.$DOMAIN.conf"
  sed -i "s/analytics\.readqurantoday\.com/analytics.$DOMAIN/g" \
    "/etc/nginx/sites-available/analytics.$DOMAIN.conf"
  ln -sf "/etc/nginx/sites-available/analytics.$DOMAIN.conf" /etc/nginx/sites-enabled/
  nginx -t && systemctl reload nginx

  # A weekly dump covers a bad upgrade, which is the failure that actually
  # happens. Total instance loss takes the dumps with it — accepted, because
  # this is analytics history and not the Quran.
  cat > /etc/cron.weekly/umami-dump <<CRON
#!/bin/sh
cd $UMAMI_DIR || exit 0
docker compose exec -T db pg_dump -U umami umami | gzip > "$UMAMI_DIR/umami-\$(date +%F).sql.gz"
ls -1t $UMAMI_DIR/umami-*.sql.gz | tail -n +5 | xargs -r rm
CRON
  chmod +x /etc/cron.weekly/umami-dump
fi

# ---------------------------------------------------------------- tls
if [ "$SKIP_TLS" = "yes" ]; then
  warn "Skipping TLS as asked. Run: sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN"
else
  say "Checking DNS before asking for a certificate"
  # Certbot proves ownership by fetching a file over http, so it fails flatly
  # if the domain does not point here yet. Better to say so than to burn a
  # rate-limited attempt.
  MY_IP="$(curl -fsS --max-time 10 https://api.ipify.org || echo '')"
  DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}' || echo '')"

  if [ -n "$MY_IP" ] && [ "$DNS_IP" != "$MY_IP" ]; then
    warn "$DOMAIN resolves to '${DNS_IP:-nothing}' but this box is $MY_IP."
    warn "DNS has not reached here yet. The site works over http now; once"
    warn "'dig +short $DOMAIN' shows $MY_IP, run:"
    warn "  sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN"
  else
    DOMAINS=(-d "$DOMAIN" -d "www.$DOMAIN")
    [ "$WITH_UMAMI" = "yes" ] && DOMAINS+=(-d "analytics.$DOMAIN")
    MAIL=(--register-unsafely-without-email)
    [ -n "$EMAIL" ] && MAIL=(-m "$EMAIL")
    certbot --nginx "${DOMAINS[@]}" "${MAIL[@]}" --agree-tos --redirect -n \
      || warn "certbot failed — the site is still up over http; see the message above"
  fi
fi

# ---------------------------------------------------------------- done
say "Done"
cat <<DONE

  Site:      https://$DOMAIN
  Files:     $APP_DIR
  Deploy:    cd $APP_DIR && git pull

  Renewal is automatic (certbot's systemd timer). Prove it:
      systemctl list-timers | grep certbot
      sudo certbot renew --dry-run

  To deploy on every push, add these to the repo's
  Settings -> Secrets and variables -> Actions:
      DEPLOY_HOST = $(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '<this box IP>')
      DEPLOY_USER = $RUN_USER
      DEPLOY_KEY  = the private half of a key in ~$RUN_USER/.ssh/authorized_keys

DONE

if [ "$WITH_UMAMI" = "yes" ]; then
cat <<UMAMI
  Umami:     https://analytics.$DOMAIN  (admin / umami — change it now)
  Then paste the website id into public/index.html and allow the host in
  /etc/nginx/snippets/readquran-security.conf. See DEPLOY.md section 6.

UMAMI
fi

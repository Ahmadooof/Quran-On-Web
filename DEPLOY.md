# Deploying readqurantoday.com

The app is static. nginx serves `public/` off disk and there is no Node process
in production — `server.js` is a local dev convenience and never runs on the
server.

Everything below assumes Ubuntu 24.04.

## The short version

Two commands, once. Point DNS at the box first — `@`, `www`, and `analytics` if
you want Umami — then on the server:

```bash
curl -fsSL https://raw.githubusercontent.com/Ahmadooof/Quran-On-Web/main/deploy/bootstrap.sh -o bootstrap.sh
```

```bash
sudo -E DOMAIN=readqurantoday.com EMAIL=you@example.com WITH_UMAMI=yes bash bootstrap.sh
```

That does swap, the firewall, nginx, the clone, the site config, the
certificate, Umami and its weekly dump — and prints the three GitHub secrets to
paste in so every later push deploys itself.

Read the script before running it; piping someone else's shell into `sudo` is
a habit worth not having. It is safe to re-run: each step checks before it
acts, so a second run repairs a half-finished install rather than breaking a
working one.

**After that, deploying is just `git push`** — see section 7.

The rest of this document is what the script does, step by step, for when
something needs fixing by hand.

## What ships, and what does not

The web root is `public/`. Anything outside it cannot be requested at all —
that is the whole access rule, and it is structural rather than a deny list.

| Ships | Stays behind |
| --- | --- |
| `public/index.html`, `css/`, `js/`, `fonts/` | `tests/` — outside the root |
| `public/data/surahs.json`, `mushaf.json` | `scripts/` — build tools |
| `public/favicon.svg`, `site.webmanifest` | `server.js`, `package.json`, `node_modules/` |
| `public/admin/` — behind a password, section 6d | |
| | `reference/` — test fixtures |
| | `deploy/` — these files |

**`public/data/.env` must never reach the server.** It holds the Quran
Foundation API credentials. It is gitignored, so deploying by `git pull` leaves
it behind on its own; nginx also denies dotfiles as a second line. Nothing in
the app reads it at runtime — only the old download script did.

You asked whether the tests should move out of the project: **no.** They are
not reachable from the web root, they cost nothing on the server because they
are never copied there, and keeping them beside the code is what makes them get
run. Nothing needs moving.

## 1. The box

**1 GB / 1 vCPU is enough** (Vultr `vhp-1c-1gb`, $6/mo, 2 TB transfer), with a
swap file. Roughly what it holds:

| | |
| --- | --- |
| Ubuntu 24.04 | ~200 MB |
| Docker daemon | ~60 MB |
| Umami (Node) | ~200 MB |
| Postgres | ~130 MB |
| nginx | ~30 MB |
| **total** | **~620 MB** |

Serving the site itself costs almost nothing: nginx hands files to the kernel,
and the 95 MB of page fonts live in page cache, which is reclaimable and never
competes with Umami for memory.

The ~380 MB left is enough to run but not enough to be careless during an
`apt upgrade`, so give it swap. Nothing here is memory-hungry enough to touch it
in normal use — it is there so a spike waits instead of the OOM killer taking
Postgres:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo sysctl -w vm.swappiness=10    # prefer RAM; swap is a safety net, not a tier
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf
```

Postgres ships defaults sized for a much bigger machine. On 1 GB, cap it — this
saves ~70 MB and changes nothing at this scale. Add to the `db` service in
`docker-compose.umami.yml`:

```yaml
    command: postgres -c shared_buffers=64MB -c max_connections=20
```

Disk: a `--depth 1` clone lands around 100 MB, so 25 GB is ample.

**When to move up to 2 GB:** if `free -h` shows swap steadily in use rather than
near zero, or `dmesg | grep -i oom` ever reports a kill. Both providers resize in
place — it is a reboot, not a rebuild — so starting at 1 GB costs you nothing but
the reboot if you outgrow it.

Create it with your SSH key, then harden it:

```bash
adduser deploy && usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
```

Then disable root SSH login and password auth in `/etc/ssh/sshd_config`
(`PermitRootLogin no`, `PasswordAuthentication no`) and `systemctl restart ssh`.

## 2. DNS

In DigitalOcean → Networking → Domains, add `readqurantoday.com` and point the
registrar's nameservers at `ns1/ns2/ns3.digitalocean.com`. Then three records:

| Type | Host | Value |
| --- | --- | --- |
| A | `@` | droplet IP |
| A | `www` | droplet IP |
| A | `analytics` | droplet IP |

Wait until `dig +short readqurantoday.com` returns the droplet IP before running
certbot — the certificate is issued by fetching a file over HTTP, so it fails if
DNS has not moved yet.

## 3. The app

```bash
sudo apt update && sudo apt install -y nginx git
sudo mkdir -p /var/www/readqurantoday && sudo chown deploy:deploy /var/www/readqurantoday
git clone --depth 1 <your-repo-url> /var/www/readqurantoday
```

`--depth 1` skips the history, which is most of the download.

nginx runs as `www-data` and needs to traverse the path:

```bash
sudo chmod o+x /var/www/readqurantoday
```

## 4. nginx

```bash
sudo mkdir -p /etc/nginx/snippets
sudo cp /var/www/readqurantoday/deploy/security-headers.conf /etc/nginx/snippets/readquran-security.conf
sudo cp /var/www/readqurantoday/deploy/readqurantoday.com.conf /etc/nginx/sites-available/
sudo cp /var/www/readqurantoday/deploy/analytics.readqurantoday.com.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/readqurantoday.com.conf /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/analytics.readqurantoday.com.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` is not a formality — **I could not validate these configs locally**,
as there is no nginx on this machine. If it complains, the message names the
file and line.

Skip the analytics symlink if you are not setting up Umami. nginx starts either
way — a `proxy_pass` to a port with nothing behind it fails per request, not at
startup — but the host would answer 502, so there is no reason to enable it
before the container is up.

One nginx trap worth knowing, since it shapes these files: `add_header` inside a
`location` throws away **every** header inherited from the server block. That is
why `security-headers.conf` is included again in each location that sets a
header of its own, instead of being stated once at the top.

## 5. TLS, and renewal that looks after itself

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d readqurantoday.com -d www.readqurantoday.com
```

Choose **redirect** when it offers. Certbot edits the site file in place: it
adds the `listen 443 ssl` block, the certificate paths, and an http→https
redirect. The caching, headers and gzip written above survive that edit.

Renewal needs no cron of your own — the certbot package installs a systemd timer
that runs twice a day and renews anything inside 30 days of expiry. Confirm both:

```bash
systemctl list-timers | grep certbot     # the timer exists and is scheduled
sudo certbot renew --dry-run             # a full rehearsal against staging
```

If the dry run passes, renewal is genuinely automatic. Certbot reloads nginx
itself after a successful renewal.

For Umami's subdomain, once it is running:

```bash
sudo certbot --nginx -d analytics.readqurantoday.com
```

## 6. Umami

```bash
sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker deploy    # log out and back in
mkdir -p ~/umami && cp /var/www/readqurantoday/deploy/docker-compose.umami.yml ~/umami/
cd ~/umami
printf 'UMAMI_DB_PASSWORD=%s\nUMAMI_APP_SECRET=%s\n' "$(openssl rand -base64 24)" "$(openssl rand -base64 32)" > .env
chmod 600 .env
docker compose -f docker-compose.umami.yml up -d
```

Umami binds to `127.0.0.1:3000`, so it is reachable only through nginx.

Then open `https://analytics.readqurantoday.com`, sign in with **admin /
umami**, change that password immediately, and turn the second factor on —
section 6a, which is also what lets the dashboard be reachable from anywhere. Add a website for
`readqurantoday.com` and copy the website id it gives you.

Two edits to switch tracking on:

1. In `public/index.html`, uncomment the Umami `<script>` near the top and paste
   the id into `data-website-id`.
2. In `/etc/nginx/snippets/readquran-security.conf`, allow the host in the CSP —
   otherwise the browser blocks the script and you will see nothing:

   ```
   script-src 'self' https://analytics.readqurantoday.com;
   connect-src 'self' https://analytics.readqurantoday.com;
   ```

Then `sudo nginx -t && sudo systemctl reload nginx`.

### What you get, and where

| Question | Where it comes from |
| --- | --- |
| How many are reading right now | Umami → Realtime |
| How long they stay | Umami → Visitors, average visit duration |
| Which country | Umami → Countries |
| Which screen | Umami → Devices / Screens |
| **Which surah they read** | Umami → Pages, as `/surah/18/` |
| **Which reading mode** | the `reading-mode` event |

Which surah needs no event. Every surah has its own url, and Umami's tracker
patches `pushState`, so moving between surahs inside the app reports a pageview
just as a fresh load would — the Pages report carries it, with referrers and
entry pages thrown in.

Reading mode is the one thing no url can say, so it is the only event left. It
fires on a deliberate switch, not on the restore at boot. Page turns are
deliberately **not** tracked: in one-page mode the page changes as you scroll,
so it would report noise rather than reading.

Everything goes through one `track()` wrapper in `app.js` that does nothing
unless `window.umami` exists, so the reader behaves identically before you turn
the snippet on — which is how it ships.

None of this uses cookies, which is why no consent banner is owed.

## 6a. The dashboard's second factor

The dashboard used to answer only to one address, kept in
`/etc/nginx/snippets/umami-allow.conf` and set from home by a small script. That
shut strangers out and shut you out too, from every network but one, and a home
address changes on its own.

Umami grew TOTP two-factor login in v3.3.0, so the door can be open and still
hold: the password, then a six-digit code from your phone. The compose file
tracks `postgresql-latest`, so the upgrade is a pull.

**Do it in this order.** The second factor has to be on the account before the
allow-list comes off, or the login form stands on the internet with a password
alone in between.

```bash
cd ~/umami
docker compose exec -T db pg_dump -U umami umami | gzip > ~/umami-before-2fa.sql.gz
```

Take that dump for real: v2 to v3 migrates the database, and a migration that
goes wrong has nothing else to go back to.

```bash
printf 'UMAMI_TWO_FACTOR_KEY=%s\n' "$(openssl rand -base64 32)" >> ~/umami/.env
docker compose -f docker-compose.umami.yml --env-file .env pull
docker compose -f docker-compose.umami.yml --env-file .env up -d
```

Umami refuses to turn 2FA on without that key, and **losing it locks every
enrolled account out** — it is what the authenticator secrets are encrypted
with. It lives in `~/umami/.env` with the database password, which is not
backed up anywhere, so keep a copy in your password manager.

Then in the dashboard: **Profile → Security → Two-factor authentication**, scan
the QR code with your authenticator, and **save the ten backup codes** where you
can reach them without the phone. They are the way back in when it is lost.

Only now open the door. `analytics.readqurantoday.com.conf` is certbot's file,
so a deploy never touches it — this is a hand edit, once:

```bash
sudo sed -i '/umami-allow.conf/d' /etc/nginx/sites-available/analytics.readqurantoday.com.conf
sudo rm -f /etc/nginx/snippets/umami-allow.conf
sudo nginx -t && sudo systemctl reload nginx
```

Copy the `location = /api/auth/login` block out of
`deploy/analytics.readqurantoday.com.conf` into the same file while you are in
it, above `location /`. That is what replaces the allow-list for anyone
guessing: ten attempts a minute, per address, counted on the reader's own
address rather than Cloudflare's edge. The zone it names is installed by a
deploy, so run one (or `sudo /usr/local/sbin/readquran-sync-nginx`) before
reloading, or `nginx -t` will not find it.

Check it from a phone on mobile data: the login should appear, the password
alone should not be enough, and a wrong code should be refused.

## 6b. Backups, and what is worth backing up

Almost nothing here needs a backup. The code, the data and all 604 page fonts
are in git, and this guide rebuilds the box from scratch in about twenty
minutes — the instance is disposable on purpose.

The one thing that exists only on the server is Umami's history, and that is
analytics, not the Quran. Losing it costs you visitor numbers, nothing a reader
would notice. So the provider's paid backup is not worth it here; a weekly dump
covers the failure you are actually likely to hit, which is breaking Umami
during an upgrade:

```bash
sudo tee /etc/cron.weekly/umami-dump >/dev/null <<'EOF'
#!/bin/sh
cd /home/linuxuser/umami || exit 0
docker compose exec -T db pg_dump -U umami umami | gzip > "/home/linuxuser/umami-$(date +%F).sql.gz"
ls -1t /home/linuxuser/umami-*.sql.gz | tail -n +5 | xargs -r rm
EOF
sudo chmod +x /etc/cron.weekly/umami-dump
```

Four weeks kept, a few kilobytes each. Restore with:

```bash
gunzip -c umami-YYYY-MM-DD.sql.gz | docker compose exec -T db psql -U umami umami
```

This deliberately does not protect against losing the whole instance — the
dumps go down with it. That is the accepted trade for analytics history. If it
ever stops being acceptable, copy the dump off the box or turn the provider's
backups on then.

## 6c. Feedback from the Android app

The app's "Report an issue or suggest" form posts to `/api/feedback`, and you
read the reports at **https://readqurantoday.com/feedback/reports/** from any
browser, phone included.

How it fits together:

- `feedback/` is a small Node service (Express, SQLite via better-sqlite3) on
  `127.0.0.1:8787`. It checks every field, limits each address to 5 reports an
  hour and 20 a day, caps the box at 500 a day, and never returns addresses.
- `feedback/admin/` is the reports page: plain HTML, CSS and JS, served by nginx
  as static files. It loads the reports as JSON from `/feedback/api/reports`.
- nginx (`deploy/feedback-location.conf`) accepts only POST with a 16 KB body on
  `/api/feedback`, rate limits both parts, and puts the page and its data behind
  a password.
- `npm test` in `feedback/` runs in CI; a deploy installs its packages when the
  lockfile changes and restarts the service when `feedback/` changes.

Work on it locally:

```bash
cd feedback
npm install
npm test
npm run dev        # then open http://127.0.0.1:8787/feedback/reports/
```

### One-time setup on the box

Everything below is run once. Deploys keep it current after that.

```bash
cd /var/www/readqurantoday

# Node 22 LTS, if the box does not have it yet (bootstrap.sh does this on a new box)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# the service's packages
(cd feedback && npm ci --omit=dev)

# the service, locked down: throwaway user, own data folder, 128 MB cap
sudo cp deploy/readquran-feedback.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now readquran-feedback

# lets a deploy restart it, and nothing else
sudo install -m 755 deploy/restart-feedback.sh /usr/local/sbin/readquran-restart-feedback
echo 'linuxuser ALL=(root) NOPASSWD: /usr/local/sbin/readquran-restart-feedback' | sudo tee /etc/sudoers.d/readquran-feedback
sudo chmod 440 /etc/sudoers.d/readquran-feedback

# the password for the reports page (it asks you to type it); run again to change it
printf 'admin:%s
' "$(openssl passwd -apr1)" | sudo tee /etc/nginx/readquran-feedback.htpasswd > /dev/null
sudo chown root:www-data /etc/nginx/readquran-feedback.htpasswd
sudo chmod 640 /etc/nginx/readquran-feedback.htpasswd

# the sync script now also installs the feedback snippets
sudo install -m 755 deploy/sync-nginx.sh /usr/local/sbin/readquran-sync-nginx
sudo install -m 755 deploy/pull-deploy.sh /usr/local/sbin/readquran-pull-deploy
sudo /usr/local/sbin/readquran-sync-nginx
```

Then add one line inside the HTTPS `server { ... }` block of
`/etc/nginx/sites-available/readqurantoday.com.conf`, next to the other
`location` blocks:

```nginx
include /etc/nginx/snippets/readquran-feedback.conf;
```

```bash
sudo nginx -t && sudo systemctl reload nginx
systemctl status readquran-feedback --no-pager
```

Save the username (`admin`) and password in your phone's password manager so
the browser fills them in.

## 6d. The admin pages

`public/admin/` holds the tools for whoever runs the site, starting with
**https://readqurantoday.com/admin/links/** — every url in the sitemap, in a
table, with what kind of page it is and whether it is accessible. It asks the
server itself, so it answers the question a crawler would ask.

They are static files inside the web root, so the password is nginx's:

```bash
cd /var/www/readqurantoday

# the password (it asks you to type it); run again to change it
printf 'admin:%s\n' "$(openssl passwd -apr1)" | sudo tee /etc/nginx/readquran-admin.htpasswd > /dev/null
sudo chown root:www-data /etc/nginx/readquran-admin.htpasswd
sudo chmod 640 /etc/nginx/readquran-admin.htpasswd

sudo install -m 755 deploy/sync-nginx.sh /usr/local/sbin/readquran-sync-nginx
sudo /usr/local/sbin/readquran-sync-nginx
```

Then one line inside the HTTPS `server { ... }` block of
`/etc/nginx/sites-available/readqurantoday.com.conf`, beside the feedback one:

```nginx
include /etc/nginx/snippets/readquran-admin.conf;
```

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -so /dev/null -w '%{http_code}\n' https://readqurantoday.com/admin/links/       # 401
curl -so /dev/null -w '%{http_code}\n' https://readqurantoday.com/admin/links/links.js  # 401, not 200
```

That second check is the one worth doing. The site's `location ~* .(css|js)$`
would take the page's script if the admin location were not `^~`, and serve it
with no password at all.

The page is also `noindex` in its own markup and behind `Disallow: /admin/` in
`robots.txt` — belt and braces, since neither of those keeps anyone out.

Locally there is no nginx, so `server.js` asks only when you tell it to:

```bash
ADMIN_PASSWORD=whatever npm run dev
```

Without that variable a dev session is not a login, which is how it ships.

## 7. Updating the site

```bash
cd /var/www/readqurantoday && git pull
```

That is the whole deploy. No build step, no restart — nginx picks up the new
files immediately. `index.html`, the CSS and the JS are served
`must-revalidate`, so returning readers get the new version on their next load
rather than whenever a cache happens to expire. The page fonts are pinned for a
year because a given page's font never changes.

To roll back, `git checkout <previous-sha>`.

### Doing it on push instead

Push to main, and within a minute the site is serving it. There is no image and
no build — the app is static files, so the pipeline is "check, mark, pull".

**The server does the reaching.** GitHub's runners come from Microsoft's
address ranges, and the firewall answers to one address, so nothing can be
pushed *in*. Instead `readquran-deploy.timer` asks GitHub once a minute whether
there is anything new. That is what lets SSH stay shut to the whole internet.

**It follows `release`, not `main`.** CI moves that branch only after the checks
pass, so a red build is never picked up. The workflow moves the ref over the
API rather than cloning: the page fonts are in history, and cloning 100 MB to
push one ref would be silly.

    push to main
      -> checks run on GitHub
      -> release branch fast-forwarded  (only if green)
      -> the box notices within 60s, resets to it, reloads nginx if deploy/ changed

Watch a deploy land:

```bash
journalctl -u readquran-deploy.service -f
```

The checkout is a mirror, not a workspace: the timer does `git reset --hard`,
so anything edited on the server by hand is meant to lose. Edit locally and
push.

No secrets, no deploy key, nothing to rotate — the only credential involved is
the token GitHub gives the workflow itself, which never leaves the runner.

To roll back, point the branch at an older commit and wait a minute:

```bash
gh api -X PATCH repos/Ahmadooof/Quran-On-Web/git/refs/heads/release -f sha=<older-sha>
```

Rollback is deliberately not automatic: one that fired on its own would fight
the next deploy.

## 8. Check it landed

```bash
curl -sI https://readqurantoday.com | grep -i "strict-transport\|content-security\|cache-control"
curl -sI https://readqurantoday.com/fonts/v2/p1.woff2 | grep -i cache-control   # immutable
curl -so /dev/null -w '%{http_code}\n' https://readqurantoday.com/data/.env      # 403 or 404
curl -so /dev/null -w '%{http_code}\n' https://readqurantoday.com/../server.js   # 400 or 404
```

Then load the site in a private window: the mushaf should open on al-Fatihah
with no interaction, and the network panel should show requests to your own
domain only — no fonts.googleapis.com, no code.jquery.com.

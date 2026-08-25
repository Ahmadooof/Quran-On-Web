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
umami**, and change that password immediately. Add a website for
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

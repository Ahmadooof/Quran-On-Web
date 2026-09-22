# The reader, in one image: nginx and 604 page fonts, no Node at runtime.
#
# The pages are built for the domain the copy will answer on, because every one
# of them names it — canonical, og:url, the JSON-LD, the sitemap, and the policy
# that decides whether the recitations play. That is a build argument rather
# than an environment variable for the same reason: it is baked into the files.
#
#   docker build -t quran --build-arg SITE=https://example.com .
#   docker run -p 8080:80 quran
#
# See DOCKER.md.

FROM node:22-alpine AS build
WORKDIR /src

# Where this copy lives. The defaults are what a local run needs.
ARG SITE=http://localhost:8080
# The host the recitations stream from. Empty serves them from /surah, which is
# nothing unless you put them there — see DOCKER.md on audio.
ARG AUDIO=

COPY . .

# build:pages reads only fs and path, so there is nothing to install first.
RUN node -e "const fs=require('fs'); \
      const c=JSON.parse(fs.readFileSync('site.json','utf8')); \
      c.site=process.env.SITE; c.audio=process.env.AUDIO||''; \
      fs.writeFileSync('site.json', JSON.stringify(c,null,2));" \
 && npm run build:pages

FROM nginx:1.27-alpine

COPY --from=build /src/public /usr/share/nginx/html
COPY --from=build /src/deploy/security-headers.conf /etc/nginx/snippets/readquran-security.conf
COPY deploy/docker.conf /etc/nginx/conf.d/default.conf

# The tools for whoever runs the site are not part of a copy someone else runs,
# and nothing here serves the password they sit behind.
RUN rm -rf /usr/share/nginx/html/admin

EXPOSE 80

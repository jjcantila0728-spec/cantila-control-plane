# Native git smart-HTTP serving for Cantila's own git backend (plan §22).
# Serves /srv/cantila-git over https://git.cantila.app via git's built-in
# `git http-backend` CGI, fronted by nginx + fcgiwrap with HTTP Basic auth.
# This REPLACES Gitea's smart-HTTP serving; the bare repos are the same
# /srv/cantila-git store the control-plane operates with git plumbing
# (NativeGitProvider). Read + write (clone/fetch/push) are all gated by the
# Basic-auth realm so private repos stay private — matching Gitea (401 anon).
FROM alpine:3.20

RUN apk add --no-cache git git-daemon fcgiwrap spawn-fcgi nginx apache2-utils tini \
    && mkdir -p /run/nginx /var/lib/git

COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# GIT_PROJECT_ROOT — where the bare repos live (bind-mounted at run time).
ENV GIT_PROJECT_ROOT=/srv/cantila-git \
    NATIVE_GIT_PORT=80

EXPOSE 80
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]

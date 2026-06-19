#!/bin/sh
# Boot the native git smart-HTTP server: build the Basic-auth file from the
# configured token, start fcgiwrap, then nginx in the foreground.
#
# Auth model — reuse the SAME token the deploy/build path already injects as
# `https://oauth2:<token>@git.cantila.app/...` (today Gitea's token; at cutover
# we keep the same value so NO control-plane code change is needed). git/Gitea
# clients pass the token as either the username or the password, so we register
# the token as the password under every username a Cantila client uses, AND as
# a username with an empty-ish password fallback is NOT possible with Basic, so
# we cover the known usernames: oauth2 (build path), cantila, git, x-access-token.
set -eu

: "${NATIVE_GIT_TOKEN:?NATIVE_GIT_TOKEN is required (the shared git access token)}"

HTPASSWD=/etc/nginx/git.htpasswd
: > "$HTPASSWD"
for user in oauth2 cantila git x-access-token; do
  # -b batch, -B bcrypt; append each known username with the token as password.
  htpasswd -bB "$HTPASSWD" "$user" "$NATIVE_GIT_TOKEN" 2>/dev/null
done
# Also allow the token itself AS the username (Gitea accepts token-as-username
# with any password) — register it with a copy of itself as the password.
htpasswd -bB "$HTPASSWD" "$NATIVE_GIT_TOKEN" "$NATIVE_GIT_TOKEN" 2>/dev/null

# git http-backend needs the repos readable; the bind-mount is root-owned and
# the CGI runs as root via fcgiwrap here, so no safe.directory dance needed,
# but set it defensively for any uid drift.
git config --system --add safe.directory '*' || true

# fcgiwrap on a unix socket nginx talks to.
rm -f /run/fcgiwrap.sock
spawn-fcgi -s /run/fcgiwrap.sock -F 4 -- /usr/bin/fcgiwrap >/dev/null 2>&1
chmod 660 /run/fcgiwrap.sock

echo "native-git serving ${GIT_PROJECT_ROOT} on :${NATIVE_GIT_PORT:-80}"
exec nginx -g 'daemon off;'

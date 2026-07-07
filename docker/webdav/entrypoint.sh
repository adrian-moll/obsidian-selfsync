#!/bin/sh
# Generate the WebDAV credentials from env at startup (so users set their own
# without rebuilding) and make the data + lock dirs writable by the httpd worker.
set -e

: "${WEBDAV_USER:=selfsync}"
: "${WEBDAV_PASSWORD:=change-me-please}"

htpasswd -bc /usr/local/apache2/conf/dav.htpasswd "$WEBDAV_USER" "$WEBDAV_PASSWORD"

# Own the data + lock dirs to the user the httpd workers actually run as
# (www-data in the stock image; read it from the config so this survives an
# image change). Without this, mod_dav's lock DB can't be opened → HTTP 500.
run_user="$(awk '/^User /{print $2}' /usr/local/apache2/conf/httpd.conf)"
run_group="$(awk '/^Group /{print $2}' /usr/local/apache2/conf/httpd.conf)"
mkdir -p /var/dav /var/davlock
chown -R "${run_user:-www-data}:${run_group:-www-data}" /var/dav /var/davlock

exec "$@"

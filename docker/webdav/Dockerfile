FROM httpd:2.4
# Enable the modules a DAV + basic-auth server needs (most are on by default in
# the stock image; dav/dav_fs are shipped but commented out).
RUN set -eux; \
    sed -i \
      -e 's|^#\(LoadModule dav_module \)|\1|' \
      -e 's|^#\(LoadModule dav_fs_module \)|\1|' \
      -e 's|^#\(LoadModule auth_basic_module \)|\1|' \
      -e 's|^#\(LoadModule authn_core_module \)|\1|' \
      -e 's|^#\(LoadModule authn_file_module \)|\1|' \
      -e 's|^#\(LoadModule authz_core_module \)|\1|' \
      -e 's|^#\(LoadModule authz_user_module \)|\1|' \
      conf/httpd.conf; \
    echo "Include conf/extra/dav.conf" >> conf/httpd.conf
COPY dav.conf conf/extra/dav.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["httpd-foreground"]

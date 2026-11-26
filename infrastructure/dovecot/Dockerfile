FROM alpine:3.20

RUN apk add --no-cache \
    dovecot \
    dovecot-lmtpd \
    dovecot-pgsql \
    libsodium \
    openssl

RUN addgroup -S vmail && adduser -S -G vmail -u 5000 -h /var/mail/vhosts vmail \
    && mkdir -p /var/mail/vhosts /etc/dovecot/tls \
    && chown -R vmail:vmail /var/mail/vhosts

COPY dovecot.conf /etc/dovecot/dovecot.conf
COPY dovecot-sql.conf.ext /etc/dovecot/dovecot-sql.conf.ext.tmpl
COPY entrypoint.sh /usr/local/bin/dovecot-entrypoint.sh
RUN chmod +x /usr/local/bin/dovecot-entrypoint.sh

EXPOSE 24 143 993
ENTRYPOINT ["/usr/local/bin/dovecot-entrypoint.sh"]

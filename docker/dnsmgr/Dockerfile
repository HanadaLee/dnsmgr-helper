# syntax=docker/dockerfile:1.7

ARG ALPINE_VERSION="3.19"
ARG DNSMGR_VERSION="2.19.0.7"
ARG DNSMGR_REPOSITORY="HanadaLee/dnsmgr"
ARG DNSMGR_REF="ext"

FROM alpine:${ALPINE_VERSION}

ARG DNSMGR_VERSION
ARG DNSMGR_REPOSITORY
ARG DNSMGR_REF

LABEL org.opencontainers.image.title="dnsmgr" \
      org.opencontainers.image.description="Docker image for dnsmgr" \
      org.opencontainers.image.version="${DNSMGR_VERSION}" \
      org.opencontainers.image.source="https://github.com/${DNSMGR_REPOSITORY}/tree/${DNSMGR_REF}"

WORKDIR /app/www

RUN apk add --no-cache \
  bash \
  curl \
  nginx \
  php82 \
  php82-ctype \
  php82-curl \
  php82-dom \
  php82-fileinfo \
  php82-fpm \
  php82-ftp \
  php82-gd \
  php82-gettext \
  php82-intl \
  php82-iconv \
  php82-mbstring \
  php82-mysqli \
  php82-opcache \
  php82-openssl \
  php82-phar \
  php82-sodium \
  php82-session \
  php82-simplexml \
  php82-tokenizer \
  php82-xml \
  php82-xmlreader \
  php82-xmlwriter \
  php82-zip \
  php82-pdo \
  php82-pdo_mysql \
  php82-pdo_sqlite \
  php82-pecl-swoole \
  php82-pecl-ssh2 \
  supervisor

RUN rm -rf /var/cache/apk/* /tmp/*

# Configure nginx - http
COPY config/nginx.conf /etc/nginx/nginx.conf

# Configure PHP-FPM
ENV PHP_INI_DIR=/etc/php82
COPY config/fpm-pool.conf ${PHP_INI_DIR}/php-fpm.d/www.conf
COPY config/php.ini ${PHP_INI_DIR}/conf.d/custom.ini

# Configure supervisord
COPY config/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Run task scripts
COPY config/run_tasks.sh /app/run_tasks.sh

# Application
RUN mkdir -p /usr/src \
    && wget --no-cache "https://github.com/${DNSMGR_REPOSITORY}/archive/refs/heads/${DNSMGR_REF}.zip" -O /usr/src/www.zip \
    && unzip /usr/src/www.zip -d /usr/src/ \
    && mv "/usr/src/dnsmgr-${DNSMGR_REF}" /usr/src/www \
    && rm -f /usr/src/www.zip \
    && wget https://getcomposer.org/download/latest-stable/composer.phar -O /usr/local/bin/composer \
    && chmod +x /usr/local/bin/composer \
    && composer install -d /usr/src/www --no-interaction --no-dev --optimize-autoloader --no-cache \
    && adduser -D -s /sbin/nologin -g www www \
    && chown -R www:www /usr/src/www /var/lib/nginx /var/log/nginx \
    && chmod +x /app/run_tasks.sh \
    && echo "* * * * * cd /app/www && /usr/bin/php82 think certtask" | crontab -u www -

# Entrypoint script
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["sh", "/entrypoint.sh"]

# Expose the port nginx is reachable on
EXPOSE 80

# Let supervisord start nginx & php-fpm
CMD /usr/sbin/crond && /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf

# Configure a healthcheck to validate that everything is up&running
HEALTHCHECK --timeout=10s CMD curl --silent --fail http://127.0.0.1/fpm-ping || exit 1

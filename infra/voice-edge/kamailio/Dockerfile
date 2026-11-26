# D-Contact SIP edge Kamailio (ADR-038), using the Debian package rather than an unmaintained external image
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends kamailio kamailio-postgres-modules ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY kamailio.cfg /etc/kamailio/kamailio.cfg
COPY --chmod=0755 entrypoint.sh /usr/local/bin/dcontact-kamailio
# dispatcher.list comes from a volume of each environment
# starts as root to bind 5060, then drops privileges to kamailio with -u/-g
ENTRYPOINT ["/usr/local/bin/dcontact-kamailio"]

# Kamailio ขอบ SIP ของ D-Contact (ADR-038) ใช้แพ็กเกจของ Debian ไม่ใช้ image ภายนอกที่ไม่มีคนดูแล
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends kamailio kamailio-postgres-modules ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY kamailio.cfg /etc/kamailio/kamailio.cfg
COPY --chmod=0755 entrypoint.sh /usr/local/bin/dcontact-kamailio
# dispatcher.list มาจาก volume ของแต่ละ environment
# เริ่มเป็น root เพื่อ bind 5060 แล้วลดสิทธิ์เป็น kamailio ด้วย -u/-g
ENTRYPOINT ["/usr/local/bin/dcontact-kamailio"]

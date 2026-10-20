/** HTTPS loopback เท่านั้น สำหรับ boundary test; ไม่มีข้อมูลหรือ credential ของ UAT */
import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = process.env.UAT_SSO_CERT_DIR;
if (!directory) throw new Error('UAT_SSO_CERT_DIR_REQUIRED');
const server = https.createServer(
  {
    key: readFileSync(join(directory, 'key.pem')),
    cert: readFileSync(join(directory, 'cert.pem')),
  },
  (req, res) => {
    if (!req.url.startsWith('/auth/')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>Sandbox callback</body></html>');
      return;
    }
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: 15441,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: '127.0.0.1:15442',
          'x-forwarded-host': '127.0.0.1',
          'x-forwarded-port': '15442',
          'x-forwarded-proto': 'https',
        },
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end('sandbox upstream unavailable');
    });
    req.pipe(upstream);
  },
);
server.listen(15442, '127.0.0.1', () => console.log('HTTPS loopback sandbox ready'));
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => server.close(() => process.exit()));

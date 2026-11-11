/** HTTP ผ่าน Caddy จริง; upstream ภายนอกเป็น fixture ไม่แทน browser/OIDC acceptance */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const caddy =
  'caddy:2.8.4-alpine@sha256:af32e97399febea808609119bb21544d0265c58a02836576e32a2d082c262c17';
const node =
  'node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0';
const iframe = '/auth/realms/dcontact/dc-account/login-status-iframe.html';
function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  }).trim();
}

test(
  'UAT proxy: iframe ตรวจ session ผ่าน upstream policy แต่หน้าอื่นยังป้องกัน framing',
  { timeout: 180_000 },
  async (t) => {
    const id = randomUUID().slice(0, 8),
      network = `core742-${id}`;
    const client = `${network}-client`,
      proxy = `${network}-proxy`;
    const dir = mkdtempSync(join(tmpdir(), 'core742-'));
    t.after(() => {
      for (const name of [proxy, client]) {
        try {
          docker(['rm', '--force', name]);
        } catch {}
      }
      try {
        docker(['network', 'rm', network]);
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    });
    docker(['network', 'create', '--internal', network]);
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-subj',
        '/CN=session.test',
        '-addext',
        'subjectAltName=DNS:session.test',
      ],
      { stdio: 'ignore' },
    );
    writeFileSync(join(dir, 'index.html'), '<h1>Console fixture</h1>');
    const fence = join(dir, 'admission-fence');
    mkdirSync(fence);
    writeFileSync(
      join(dir, 'upstream.mjs'),
      `
    import http from 'node:http';
    http.createServer((req,res)=>{
      if(new URL(req.url, 'http://keycloak').searchParams.has('native-frame-policy')) res.setHeader('X-Frame-Options','SAMEORIGIN');
      res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"frame-src 'self'; object-src 'none';",'X-Upstream-Proto':req.headers['x-forwarded-proto']??''});
      res.end('<p>upstream session fixture</p>');
    }).listen(8080,'0.0.0.0');
    http.createServer((req,res)=>{
      res.writeHead(200,{'Content-Type':'application/json','X-Upstream':'api'});
      res.end(JSON.stringify({method:req.method,path:req.url}));
    }).listen(3000,'0.0.0.0');
  `,
    );
    docker([
      'run',
      '--detach',
      '--name',
      client,
      '--network',
      network,
      '--network-alias',
      'keycloak',
      '--network-alias',
      'api',
      '-e',
      'NODE_EXTRA_CA_CERTS=/fixtures/cert.pem',
      '-v',
      `${dir}:/fixtures:ro`,
      node,
      'node',
      '/fixtures/upstream.mjs',
    ]);
    const clientIp = docker([
      'inspect',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      client,
    ]);
    let base;
    async function request(path, forwardedFor = '198.51.100.10', method = 'GET') {
      const result = docker([
        'exec',
        client,
        'node',
        '-e',
        `
      fetch(process.argv[1]+process.argv[2],{method:process.argv[4],headers:{Origin:'https://session.test','X-Forwarded-For':process.argv[3]}})
      .then(async r=>console.log(JSON.stringify({status:r.status,headers:Object.fromEntries(r.headers),body:await r.text()})))
      .catch(()=>process.exit(1));
    `,
        base,
        path,
        forwardedFor,
        method,
      ]);
      return JSON.parse(result);
    }
    for (const file of ['Caddyfile.3vm.e1', 'Caddyfile.3vm', 'Caddyfile.3vm.line', 'Caddyfile']) {
      base = file === 'Caddyfile' ? 'https://session.test:8443' : 'http://session.test:8080';
      // เฉพาะ address ของ edge ใน topology sandbox; route/header ของ production ใช้ bytes เดิม
      const source = readFileSync(`infra/uat/${file}`, 'utf8').replaceAll(
        '192.168.102.114/32',
        `${clientIp}/32`,
      );
      writeFileSync(join(dir, 'Caddyfile'), source);
      docker([
        'run',
        '--detach',
        '--name',
        proxy,
        '--network',
        network,
        '--network-alias',
        'session.test',
        '-e',
        'UAT_HOST=session.test',
        '-e',
        `UAT_ALLOWED_CIDRS=${file === 'Caddyfile' ? clientIp : '198.51.100.10'}/32`,
        '-v',
        `${dir}/Caddyfile:/etc/caddy/Caddyfile:ro`,
        '-v',
        `${dir}/index.html:/srv/console/index.html:ro`,
        '-v',
        `${fence}:/run/dcontact-admission-fence:ro`,
        '-v',
        `${dir}/cert.pem:/run/secrets/uat_tls_cert:ro`,
        '-v',
        `${dir}/key.pem:/run/secrets/uat_tls_key:ro`,
        caddy,
      ]);
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          if ((await request('/')).status === 200) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ready, `${file} ต้องพร้อมก่อนตรวจ behavior`);
      await t.test(file, async () => {
        const frame = await request(iframe);
        assert.equal(frame.status, 200);
        assert.equal(
          frame.headers['x-frame-options'],
          undefined,
          `${file}: global DENY ต้องไม่บล็อก protocol iframe`,
        );
        assert.equal(
          frame.headers['content-security-policy'],
          "frame-src 'self'; object-src 'none';",
        );
        assert.equal(frame.headers['x-upstream-proto'], 'https');
        assert.match(frame.body, /upstream session fixture/);
        const query = await request(`${iframe}?version=26.0.5`);
        assert.equal(query.status, 200);
        assert.equal(query.headers['x-frame-options'], undefined);
        const native = await request(`${iframe}?native-frame-policy`);
        assert.equal(
          native.headers['x-frame-options'],
          'SAMEORIGIN',
          'ไม่ลบหรือเขียนทับ framing policy จาก upstream',
        );
        for (const path of [
          '/',
          '/?view=account',
          '/auth/realms/dcontact/protocol/openid-connect/auth',
          '/auth/realms/dcontact/protocol/openid-connect/auth?native-frame-policy',
          `${iframe}/init`,
          `${iframe}/extra`,
          '/auth/realms/other/dc-account/login-status-iframe.html',
        ]) {
          const page = await request(path);
          assert.equal(page.status, 200, path);
          assert.equal(page.headers['x-frame-options'], 'DENY', path);
        }
        for (const path of [
          '/auth/admin',
          '/auth/admin/realms',
          '/auth/realms/master',
          '/auth/health',
        ]) {
          const blocked = await request(path);
          assert.equal(blocked.status, 404, path);
          assert.equal(blocked.headers['x-frame-options'], 'DENY', path);
          assert.doesNotMatch(blocked.body, /upstream session fixture/);
        }
        // #868: admission fence ของ People เปิด/ปิดด้วยไฟล์โดยไม่ reload proxy
        const people = '/api/v1/tenant-voice/people/users';
        const fenced = [
          ['POST', people],
          ['POST', `${people}/`],
          ['POST', '/API/V1/Tenant-Voice/People/Users'],
          ['POST', '/api//v1/tenant-voice//people/users'],
          ['POST', `${people}/u-1/disable`],
          ['POST', `${people}/u-1/reconcile`],
          ['POST', `${people}/u-1/invitation/resend`],
          ['PUT', `${people}/u-1/skills`],
          ['PATCH', `${people}/u-1`],
          ['DELETE', `${people}/u-1`],
        ];
        const passThrough = [
          ['GET', people],
          ['GET', `${people}/u-1`],
          ['HEAD', people],
          ['GET', '/api/v1/tenant-voice/operations/op-1'],
          ['POST', '/api/v1/tenant-voice/peoplex/users'],
          ['POST', '/api/v1/tenant-voice/routing/rules'],
        ];
        const upstream = async (method, path) => {
          const response = await request(path, '198.51.100.10', method);
          assert.equal(response.status, 200, `${method} ${path}`);
          assert.equal(response.headers['x-upstream'], 'api', `${method} ${path}`);
          assert.equal(response.headers['x-dcontact-admission-fence'], undefined);
        };
        for (const [method, path] of [...fenced, ...passThrough]) await upstream(method, path);
        writeFileSync(join(fence, 'people-mutations'), '');
        try {
          for (const [method, path] of fenced) {
            const response = await request(path, '198.51.100.10', method);
            assert.equal(response.status, 503, `${file}: ${method} ${path} ต้องถูก fence`);
            assert.equal(response.headers['x-upstream'], undefined, `${method} ${path}`);
            assert.equal(response.headers['x-dcontact-admission-fence'], 'people');
            assert.equal(response.headers['content-type'], 'application/json');
            assert.equal(response.headers['cache-control'], 'no-store');
            assert.equal(response.headers['retry-after'], '300');
            assert.deepEqual(JSON.parse(response.body), {
              code: 'CAPABILITY_NOT_READY',
              reason: 'ADMISSION_FENCED',
            });
          }
          for (const [method, path] of passThrough) await upstream(method, path);
          if (file !== 'Caddyfile') {
            const outsideFenced = await request(people, '203.0.113.20', 'POST');
            assert.equal(outsideFenced.status, 403, 'fence ต้องไม่ข้าม client allowlist');
          }
        } finally {
          rmSync(join(fence, 'people-mutations'), { force: true });
        }
        for (const [method, path] of fenced) await upstream(method, path);
        if (file !== 'Caddyfile') {
          const outside = await request(iframe, '203.0.113.20');
          assert.equal(outside.status, 403, 'client allowlist ต้องบังคับแม้เป็น iframe');
        }
        // peer นี้ไม่ใช่ trusted edge และไม่อยู่ใน direct allowlist; ห้าม spoof X-Forwarded-For
        const outsider = docker([
          'run',
          '--rm',
          '--network',
          network,
          '-e',
          'NODE_EXTRA_CA_CERTS=/fixtures/cert.pem',
          '-v',
          `${dir}:/fixtures:ro`,
          node,
          'node',
          '-e',
          `fetch(process.argv[1],{headers:{'X-Forwarded-For':'198.51.100.10'}}).then(r=>console.log(r.status)).catch(()=>process.exit(1))`,
          `${base}${iframe}`,
        ]);
        assert.equal(outsider, '403', 'direct peer ต้องผ่าน edge/direct allowlist');
      });
      docker(['rm', '--force', proxy]);
    }
  },
);

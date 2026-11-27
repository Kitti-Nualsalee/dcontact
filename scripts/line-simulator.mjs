#!/usr/bin/env node
/**
 * #1054 LINE simulator for a dev stack and the LINE chat trial. Not for production.
 *
 * It plays both sides D-Contact talks to:
 * - LINE's Messaging API: point the API at it with `LINE_API_BASE_URL=http://127.0.0.1:8890`. It
 *   accepts any access token except `reject-token`, answers the bot info and profiles, and records
 *   push and reply messages. A push repeated with the same `X-Line-Retry-Key` answers 409 like LINE.
 * - LINE users: a page at http://127.0.0.1:8890/ lets a tester write as a LINE user; the simulator
 *   signs the webhook with the channel secret and posts it to the webhook URL the Console shows.
 *
 * JSON helpers for tests:
 *   POST /sim/config   { webhookUrl, channelSecret }        where to deliver and how to sign
 *   POST /sim/send     { userId, text } | { userId, type }  a user writes (type: sticker, image, …)
 *   GET  /sim/messages?userId=…                             what the user sent and received
 *   POST /sim/faults   { push: 'ok' | '429' | '500' | '400' } how the next pushes are answered
 *   POST /sim/reset
 *
 * Usage: node scripts/line-simulator.mjs [--port 8890]
 */
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const portIndex = process.argv.indexOf('--port');
const port = Number(
  portIndex > 0 ? process.argv[portIndex + 1] : (process.env.LINE_SIMULATOR_PORT ?? 8890),
);
const BOT_USER_ID = 'U' + '5'.repeat(32);
const BOT_NAME = 'D-Contact Demo OA';

const state = {
  webhookUrl: process.env.LINE_SIMULATOR_WEBHOOK_URL ?? '',
  channelSecret: process.env.LINE_SIMULATOR_CHANNEL_SECRET ?? '',
  pushFault: 'ok',
  nextMessageId: 900_000_000_000,
  /** userId → [{ at, from: 'user' | 'bot', kind: 'push' | 'reply' | 'message', text?, type? }] */
  threads: new Map(),
  acceptedRetryKeys: new Map(),
  replyTokens: new Map(),
};

const names = ['Somchai', 'Malee', 'Anan', 'Pim', 'Narin', 'Kanya'];
const nameOf = (userId) => `${names[parseInt(userId.slice(-2), 16) % names.length]} (sim)`;

function thread(userId) {
  if (!state.threads.has(userId)) state.threads.set(userId, []);
  return state.threads.get(userId);
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(body === undefined ? '' : JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const bearer = (request) => (request.headers.authorization ?? '').replace(/^Bearer /, '');
const validUser = (value) => typeof value === 'string' && /^U[0-9a-f]{32}$/.test(value);

/** a user writes: sign the webhook and deliver it like LINE does */
async function deliver(userId, message) {
  if (!state.webhookUrl || !state.channelSecret)
    return { status: 0, error: 'configure webhookUrl and channelSecret first' };
  const id = String((state.nextMessageId += 1));
  const replyToken = randomUUID().replace(/-/g, '');
  state.replyTokens.set(replyToken, { userId, expires: Date.now() + 60_000 });
  const event = {
    type: 'message',
    mode: 'active',
    timestamp: Date.now(),
    webhookEventId: randomUUID(),
    deliveryContext: { isRedelivery: false },
    replyToken,
    source: { type: 'user', userId },
    message:
      message.text !== undefined
        ? { id, type: 'text', text: message.text }
        : { id, type: message.type },
  };
  const body = JSON.stringify({ destination: BOT_USER_ID, events: [event] });
  const signature = createHmac('sha256', state.channelSecret).update(body).digest('base64');
  thread(userId).push({
    at: new Date().toISOString(),
    from: 'user',
    kind: 'message',
    ...message,
    id,
  });
  try {
    const answer = await fetch(state.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-line-signature': signature },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: answer.status, messageId: id };
  } catch (error) {
    return { status: 0, error: error instanceof Error ? error.message : 'failed' };
  }
}

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>LINE simulator</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#f2f3f5;color:#1a1a1a}
main{max-width:720px;margin:0 auto;padding:16px}
fieldset{border:1px solid #ccc;border-radius:8px;margin:0 0 12px;padding:12px;background:#fff}
label{display:block;font-size:13px;margin:6px 0 2px}input,select{width:100%;box-sizing:border-box;padding:6px}
#log{background:#fff;border-radius:8px;padding:12px;min-height:240px;display:flex;flex-direction:column;gap:6px}
.m{max-width:75%;padding:8px 10px;border-radius:12px;white-space:pre-wrap}
.user{align-self:flex-end;background:#c8f0c8}.bot{align-self:flex-start;background:#e6e6e6}
.meta{font-size:11px;color:#555}form.row{display:flex;gap:8px;margin-top:8px}form.row input{flex:1}
</style></head><body><main>
<h1>LINE simulator</h1>
<fieldset><legend>Channel</legend>
<label for="url">Webhook URL (from Console)</label><input id="url">
<label for="secret">Channel secret</label><input id="secret">
<button id="save" type="button">Save</button> <span id="saved" class="meta"></span></fieldset>
<fieldset><legend>LINE user</legend><label for="user">User</label><select id="user"></select></fieldset>
<div id="log" role="log" aria-label="Conversation"></div>
<form class="row" id="form"><input id="text" aria-label="Message" autocomplete="off"><button>Send</button>
<button type="button" id="sticker">Sticker</button></form>
<p class="meta">Pushes and replies from D-Contact appear on the left.</p>
</main><script>
const users=['U${'a'.repeat(32)}','U${'b'.repeat(32)}','U${'c'.repeat(32)}'];
const sel=document.getElementById('user');users.forEach((u,i)=>sel.add(new Option('Customer '+(i+1)+' · '+u.slice(-4),u)));
async function load(){const c=await (await fetch('/sim/config')).json();url.value=c.webhookUrl;secret.value=c.channelSecret;}
save.onclick=async()=>{await fetch('/sim/config',{method:'POST',body:JSON.stringify({webhookUrl:url.value.trim(),channelSecret:secret.value.trim()})});saved.textContent='saved';};
async function post(body){const r=await (await fetch('/sim/send',{method:'POST',body:JSON.stringify({userId:sel.value,...body})})).json();if(r.status!==200)alert('Webhook answered '+r.status+' '+(r.error||''));refresh();}
form.onsubmit=e=>{e.preventDefault();const t=text.value.trim();if(t){post({text:t});text.value='';}};
sticker.onclick=()=>post({type:'sticker'});
async function refresh(){const list=await (await fetch('/sim/messages?userId='+sel.value)).json();
log.replaceChildren(...list.messages.map(m=>{const d=document.createElement('div');d.className='m '+(m.from==='user'?'user':'bot');
d.textContent=(m.text??'['+m.type+']');const s=document.createElement('div');s.className='meta';s.textContent=m.kind+' · '+m.at.slice(11,19);d.append(s);return d;}));}
sel.onchange=refresh;setInterval(refresh,1500);load();refresh();
</script></body></html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  const path = url.pathname;
  try {
    // ── LINE's Messaging API ──
    if (path.startsWith('/v2/bot/')) {
      const token = bearer(request);
      if (!token || token === 'reject-token')
        return send(response, 401, { message: 'Authentication failed' });
      if (request.method === 'GET' && path === '/v2/bot/info')
        return send(response, 200, {
          userId: BOT_USER_ID,
          basicId: '@dcontact',
          displayName: BOT_NAME,
        });
      const profile = /^\/v2\/bot\/profile\/(U[0-9a-f]{32})$/.exec(path);
      if (request.method === 'GET' && profile)
        return send(response, 200, { userId: profile[1], displayName: nameOf(profile[1]) });
      if (request.method === 'POST' && path === '/v2/bot/message/push') {
        const body = await readBody(request);
        const retryKey = request.headers['x-line-retry-key'];
        if (!body || !validUser(body.to) || !Array.isArray(body.messages))
          return send(response, 400, { message: 'The request body has 1 error(s)' });
        if (typeof retryKey === 'string' && state.acceptedRetryKeys.has(retryKey))
          return send(
            response,
            409,
            { message: 'The retry key is already accepted' },
            {
              'x-line-accepted-request-id': state.acceptedRetryKeys.get(retryKey),
            },
          );
        if (state.pushFault === '429')
          return send(response, 429, { message: 'Too many requests' }, { 'retry-after': '5' });
        if (state.pushFault === '500') return send(response, 500, { message: 'Internal error' });
        if (state.pushFault === '400') return send(response, 400, { message: 'Invalid' });
        const requestId = randomUUID();
        if (typeof retryKey === 'string') state.acceptedRetryKeys.set(retryKey, requestId);
        for (const message of body.messages)
          thread(body.to).push({
            at: new Date().toISOString(),
            from: 'bot',
            kind: 'push',
            text: message.text,
          });
        return send(
          response,
          200,
          { sentMessages: body.messages.map(() => ({ id: randomUUID() })) },
          {
            'x-line-request-id': requestId,
          },
        );
      }
      if (request.method === 'POST' && path === '/v2/bot/message/reply') {
        const body = await readBody(request);
        const reply = body && state.replyTokens.get(body.replyToken);
        if (!reply || reply.expires < Date.now())
          return send(response, 400, { message: 'Invalid reply token' });
        state.replyTokens.delete(body.replyToken);
        for (const message of body.messages ?? [])
          thread(reply.userId).push({
            at: new Date().toISOString(),
            from: 'bot',
            kind: 'reply',
            text: message.text,
          });
        return send(response, 200, { sentMessages: [] });
      }
      return send(response, 404, { message: 'Not found' });
    }
    // ── the tester's side ──
    if (request.method === 'GET' && path === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return response.end(page);
    }
    if (path === '/sim/config' && request.method === 'GET')
      return send(response, 200, {
        webhookUrl: state.webhookUrl,
        channelSecret: state.channelSecret,
        botUserId: BOT_USER_ID,
      });
    if (path === '/sim/config' && request.method === 'POST') {
      const body = await readBody(request);
      if (!body) return send(response, 400, { error: 'json' });
      if (typeof body.webhookUrl === 'string') state.webhookUrl = body.webhookUrl;
      if (typeof body.channelSecret === 'string') state.channelSecret = body.channelSecret;
      return send(response, 200, { ok: true });
    }
    if (path === '/sim/send' && request.method === 'POST') {
      const body = await readBody(request);
      if (!body || !validUser(body.userId)) return send(response, 400, { error: 'userId' });
      const message =
        typeof body.text === 'string'
          ? { text: body.text }
          : { type: String(body.type ?? 'sticker') };
      return send(response, 200, await deliver(body.userId, message));
    }
    if (path === '/sim/messages' && request.method === 'GET') {
      const userId = url.searchParams.get('userId') ?? '';
      return send(response, 200, { messages: state.threads.get(userId) ?? [] });
    }
    if (path === '/sim/faults' && request.method === 'POST') {
      const body = await readBody(request);
      state.pushFault = ['ok', '429', '500', '400'].includes(body?.push) ? body.push : 'ok';
      return send(response, 200, { push: state.pushFault });
    }
    if (path === '/sim/reset' && request.method === 'POST') {
      state.threads.clear();
      state.acceptedRetryKeys.clear();
      state.replyTokens.clear();
      state.pushFault = 'ok';
      return send(response, 200, { ok: true });
    }
    return send(response, 404, { error: 'not found' });
  } catch (error) {
    return send(response, 500, { error: error instanceof Error ? error.message : 'failed' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(
    JSON.stringify({
      event: 'line_simulator.ready',
      url: `http://127.0.0.1:${port}/`,
      botUserId: BOT_USER_ID,
    }),
  );
});

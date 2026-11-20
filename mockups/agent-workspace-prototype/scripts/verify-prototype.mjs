import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFileSync,unlinkSync,readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);
const esbuild=require(require.resolve('esbuild',{paths:[require.resolve('vite')]}));
await esbuild.build({entryPoints:['src/App.jsx'],outfile:'.qa-app.mjs',bundle:true,platform:'node',format:'esm',jsx:'automatic',external:['react','react-dom'],plugins:[{name:'qa-assets',setup(build){build.onLoad({filter:/\.css$/},()=>({contents:'',loader:'js'}));build.onResolve({filter:/\.png\?inline$/},args=>({path:args.path,namespace:'qa-logo'}));build.onLoad({filter:/.*/,namespace:'qa-logo'},()=>({contents:'export default "data:image/png;base64,AA=="',loader:'js'}))}}]});
const {App,seedItems,seedPeople}=await import('../.qa-app.mjs');
const React=await import('react');const {renderToString}=await import('react-dom/server');
assert.equal(seedPeople.length,9);assert.equal(new Set(seedPeople.map(x=>x.channel)).size,9);
assert.equal(seedItems.length,27);assert.equal(new Set(seedItems.map(i=>i.id)).size,27);
for(const i of seedItems){assert(seedPeople.some(c=>c.id===i.cid));assert(i.messages.length>=2);assert(i.events.length>=3);assert(i.topic);assert(i.messages.every(m=>m.text));}
for(const c of seedPeople){assert.equal(seedItems.filter(i=>i.cid===c.id).length,3);assert.equal(seedItems.filter(i=>i.cid===c.id&&i.status==='Closed').length,2);}
const markup=renderToString(React.createElement(App));
for(const text of ['Customer 360','Agent status','ปรับแผงรายการ Interaction','ปรับแผงบันทึกผล','บันทึกร่าง','AI ผู้ช่วย','ย่อเมนูซ้าย','ขยายแถบเครื่องมือขวา'])assert(markup.includes(text),text);
for(const channel of ['Voice','Video','LINE','Facebook','Instagram','WhatsApp','Web Chat','Email','SMS'])assert(markup.includes(channel));
assert(markup.includes('<svg'));assert(!markup.includes('NaN'));
unlinkSync('.qa-app.mjs');
console.log('PASS: React initial render; 27 linked Interactions, 9 customers, 9 channels, histories, messages, events; required initial controls. Browser actions NOT verified.');

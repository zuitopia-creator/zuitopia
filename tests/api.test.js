import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../backend/worker.js';

function setup() {
 const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('../backend/schema.sql',import.meta.url),'utf8'));
 const DB = {prepare(query) {let args=[]; return {bind(...a){args=a;return this},async first(){return sql.prepare(query).get(...args)||null},async all(){return {results:sql.prepare(query).all(...args)}},async run(){const r=sql.prepare(query).run(...args);return {meta:{changes:r.changes}}}}}, async batch(stmts){return Promise.all(stmts.map(s=>s.run()))}};
 const salt='0123456789abcdef0123456789abcdef';
 return {DB,ADMIN_PASSWORD_HASH:'',INGEST_TOKEN:'ingest-test-token',PUBLIC_ORIGIN:'https://kai.github.io',CONTACT_EMAIL:'kai@example.org',salt};
}
async function passwordHash(password,salt) {
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
 const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:Uint8Array.from(salt.match(/../g),x=>parseInt(x,16)),iterations:100000},key,256);
 return `pbkdf2:100000:${salt}:${Buffer.from(bits).toString('hex')}`;
}
const base='https://zuitopia.workers.dev';
function req(env,path,method='GET',body,cookie,origin=base) {return worker.fetch(new Request(base+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);}
const draft={source_url:'https://www.nasa.gov/solar-system/',source_name:'NASA',topic:'space',en:{title:'A little space fact',summary:'A sourced space fact.'},vi:{title:'Một fact về vũ trụ',summary:'Một fact có nguồn.'},original_title:'Space fact',source_excerpt:'Original text',review_note:'Check source'};

test('private admin and ingest require authentication',async()=>{
 const env=setup(); assert.equal((await req(env,'/api/admin/posts')).status,401);
 assert.equal((await req(env,'/api/ingest','POST',{posts:[draft]})).status,401);
});
test('login, edit, publish, reject, session revoke and public isolation',async()=>{
 const env=setup(); env.ADMIN_PASSWORD_HASH=await passwordHash('correct horse battery staple',env.salt);
 assert.equal((await req(env,'/api/login','POST',{password:'wrong'})).status,401);
 const login=await req(env,'/api/login','POST',{password:'correct horse battery staple'});
 assert.equal(login.status,200); const cookie=login.headers.get('Set-Cookie').split(';')[0];
 assert.match(login.headers.get('Set-Cookie'),/HttpOnly/); assert.match(login.headers.get('Set-Cookie'),/SameSite=Strict/);
 const ingest=await worker.fetch(new Request(base+'/api/ingest',{method:'POST',headers:{Authorization:'Bearer '+env.INGEST_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({posts:[draft]})}),env);
 assert.equal(ingest.status,200);
 const seen=await worker.fetch(new Request(base+'/api/ingest/seen',{method:'POST',headers:{Authorization:'Bearer '+env.INGEST_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({urls:[draft.source_url]})}),env);
 assert.equal(seen.status,200);assert.deepEqual((await seen.json()).urls,[draft.source_url]);
 assert.deepEqual((await (await req(env,'/api/posts')).json()).posts,[]);
 const list=await (await req(env,'/api/admin/posts', 'GET',null,cookie)).json(); const post=list.posts[0];
 assert.equal((await req(env,'/api/admin/posts/'+post.id,'PUT',{...post,status:'published',reviewed:false},cookie)).status,400);
 assert.equal((await req(env,'/api/admin/posts/'+post.id,'PUT',{...post,vi:{title:'',summary:''},status:'published',reviewed:true},cookie)).status,400);
 assert.equal((await req(env,'/api/admin/posts/'+post.id,'PUT',{...post,status:'published',reviewed:true},cookie,'https://evil.example')).status,403);
 const save=await req(env,'/api/admin/posts/'+post.id,'PUT',{...post,status:'published',reviewed:true},cookie); assert.equal(save.status,200);
 assert.equal((await req(env,'/api/admin/posts/'+post.id,'PUT',{...post,status:'published',reviewed:true},cookie)).status,409);
 const feed=await (await req(env,'/api/posts')).json(); assert.equal(feed.posts.length,1); assert.equal(feed.posts[0].source_excerpt,undefined); assert.equal(feed.posts[0].review_note,undefined);
 const current=(await (await req(env,'/api/admin/posts?status=all','GET',null,cookie)).json()).posts[0];
 assert.equal((await req(env,'/api/admin/posts/'+post.id,'PUT',{...current,status:'rejected'},cookie)).status,200);
 assert.equal((await (await req(env,'/api/posts')).json()).posts.length,0);
 await req(env,'/api/logout','POST',{},cookie);
 assert.equal((await req(env,'/api/admin/posts?status=all','GET',null,cookie)).status,401);
});
test('rate limits login attempts and rejects invalid content',async()=>{
 const env=setup();env.ADMIN_PASSWORD_HASH=await passwordHash('test long password',env.salt);
 for(let i=0;i<5;i++) assert.equal((await req(env,'/api/login','POST',{password:'wrong'})).status,401);
 assert.equal((await req(env,'/api/login','POST',{password:'test long password'})).status,429);
 const r=await worker.fetch(new Request(base+'/api/ingest',{method:'POST',headers:{Authorization:'Bearer '+env.INGEST_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({posts:[{...draft,source_url:'javascript:alert(1)'}]})}),env);
 assert.equal(r.status,400);
});

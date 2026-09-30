const enc = new TextEncoder();
const topics = ['space','science','nature','culture','everyday'];
const hex = b => Array.from(new Uint8Array(b),n=>n.toString(16).padStart(2,'0')).join('');
const hash = async text => hex(await crypto.subtle.digest('SHA-256',enc.encode(text)));
const token = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const json = (value,status=200,headers={}) => Response.json(value,{status,headers:{'Cache-Control':'no-store',...headers}});
const fail = (message,status=400) => {throw Object.assign(new Error(message),{status});};
function text(value,max,required=false) {
 if(typeof value!=='string'||value.length>max||(required&&!value.trim())) fail('Invalid or missing text');
 return value.trim();
}
function normalise(p,publishing=false) {
 const source_url=text(p.source_url,2000,true); let u;
 try {u=new URL(source_url);} catch {fail('Invalid source URL');}
 if(u.protocol!=='https:'||u.username||u.password) fail('Source must be an HTTPS link');
 if(!topics.includes(p.topic)) fail('Invalid topic');
 return {source_url:u.href,source_name:text(p.source_name,120,true),topic:p.topic,
 en:{title:text(p.en?.title,180,publishing),summary:text(p.en?.summary,1000,publishing)},
 vi:{title:text(p.vi?.title,180,publishing),summary:text(p.vi?.summary,1000,publishing)},
 original_title:text(p.original_title??'',500),source_excerpt:text(p.source_excerpt??'',6000),review_note:text(p.review_note??'',2000)};
}
function unpack(row,privateFields=true) {
 const p=JSON.parse(row.content);
 if(!privateFields){delete p.original_title;delete p.source_excerpt;delete p.review_note;}
 return {...p,id:row.id,...(privateFields?{status:row.status,version:row.version,updated_at:row.updated_at}:{}),published_at:row.published_at};
}
async function readBody(req,max=65536) {
 if(!req.headers.get('Content-Type')?.startsWith('application/json')) fail('Use application/json',415);
 if(Number(req.headers.get('Content-Length'))>max) fail('Request too large',413);
 const reader=req.body?.getReader();if(!reader)fail('Missing body');let size=0;const chunks=[];
 while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();fail('Request too large',413);}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 try{return JSON.parse(new TextDecoder().decode(bytes));}catch{fail('Invalid JSON');}
}
async function verifyPassword(password,stored) {
 const [kind,iterations,salt,expected]=String(stored).split(':');
 if(kind!=='pbkdf2'||iterations!=='100000'||! /^[a-f0-9]{32}$/.test(salt??'')||! /^[a-f0-9]{64}$/.test(expected??''))fail('Admin password has not been configured',503);
 const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
 const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:Uint8Array.from(salt.match(/../g),s=>parseInt(s,16)),iterations:100000},key,256);
 // Both hashes have fixed length; no early return while comparing.
 const actual=hex(bits);let different=0;for(let i=0;i<expected.length;i++)different|=expected.charCodeAt(i)^actual.charCodeAt(i);return different===0;
}
async function session(req,env) {
 const raw=req.headers.get('Cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith('bf_session='))?.slice(11);
 if(!raw||! /^[a-f0-9]{64}$/.test(raw))return null;
 const key=await hash(raw);const found=await env.DB.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>?').bind(key,Date.now()).first();return found?key:null;
}
function cookie(value,maxAge,req) {return `bf_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(req.url).protocol==='https:'?'; Secure':''}`;}
function requireOrigin(req) {if(req.headers.get('Origin')!==new URL(req.url).origin)fail('Untrusted request origin',403);}
async function route(req,env) {
 const url=new URL(req.url),path=url.pathname,now=Date.now();
 if(path==='/config.js'&&req.method==='GET')return new Response('window.ZUITOPIA={API_BASE:"",DEMO:false};',{headers:{'Content-Type':'application/javascript','Cache-Control':'no-store'}});
 if(path==='/api/config'&&req.method==='GET')return json({contact_email:env.CONTACT_EMAIL||'',admin_url:url.origin+'/admin/'});
 if(path==='/api/posts'&&req.method==='GET') {
  let query="SELECT * FROM posts WHERE status='published'",args=[];
  const topic=url.searchParams.get('topic');if(topic&&topic!=='all'){if(!topics.includes(topic))fail('Invalid topic');query+=' AND topic=?';args.push(topic);}
  const ids=url.searchParams.get('ids');if(ids){const values=ids.split(',');if(values.length>100||values.some(x=>! /^[a-f0-9-]{36}$/.test(x)))fail('Invalid saved IDs');query+=` AND id IN (${values.map(()=>'?').join(',')})`;args.push(...values);}
  const offset=Number(url.searchParams.get('offset')||0);if(!Number.isSafeInteger(offset)||offset<0||offset>100000)fail('Invalid offset');
  const rows=await env.DB.prepare(query+' ORDER BY published_at DESC,id DESC LIMIT 51 OFFSET ?').bind(...args,offset).all();
  return json({posts:rows.results.slice(0,50).map(r=>unpack(r,false)),has_more:rows.results.length>50});
 }
 if(['/api/ingest','/api/ingest/seen'].includes(path)&&req.method==='POST') {
  const auth=req.headers.get('Authorization')||'';
  if(!env.INGEST_TOKEN||await hash(auth)!==await hash('Bearer '+env.INGEST_TOKEN))fail('Unauthorised',401);
  const body=await readBody(req,200000);
  if(path.endsWith('/seen')){
   if(!Array.isArray(body.urls)||body.urls.length>50||body.urls.some(u=>typeof u!=='string'||u.length>2000))fail('Send up to 50 source URLs');
   if(!body.urls.length)return json({urls:[]});
   const rows=await env.DB.prepare(`SELECT source_url FROM posts WHERE source_url IN (${body.urls.map(()=>'?').join(',')})`).bind(...body.urls).all();
   return json({urls:rows.results.map(r=>r.source_url)});
  }
  if(!Array.isArray(body.posts)||body.posts.length>20)fail('Send up to 20 drafts');
  const drafts=body.posts.map(p=>normalise(p)); // Validate the full batch before writing.
  let inserted=0;
  for(const p of drafts){const result=await env.DB.prepare("INSERT OR IGNORE INTO posts(id,source_url,topic,status,content,updated_at) VALUES(?,?,?,'pending',?,?)").bind(crypto.randomUUID(),p.source_url,p.topic,JSON.stringify(p),now).run();inserted+=result.meta.changes;}
  return json({inserted});
 }
 if(path==='/api/login'&&req.method==='POST') {
  requireOrigin(req);const body=await readBody(req,4096);const password=text(body.password,1024,true);
  const ip=await hash(req.headers.get('CF-Connecting-IP')||'local');
  // D1's atomic UPSERT prevents concurrent requests bypassing the attempt count.
  const attempt=await env.DB.prepare('INSERT INTO login_attempts(key,count,resets_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN resets_at<=? THEN 1 ELSE count+1 END,resets_at=CASE WHEN resets_at<=? THEN ? ELSE resets_at END RETURNING count,resets_at').bind(ip,now+900000,now,now,now+900000).first();
  if(attempt.count>5)return json({error:'Too many attempts. Try again in 15 minutes.'},429,{'Retry-After':String(Math.ceil((attempt.resets_at-now)/1000))});
  if(!await verifyPassword(password,env.ADMIN_PASSWORD_HASH))fail('Incorrect password',401);
  const raw=token();await env.DB.batch([
   env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now),
   env.DB.prepare('INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)').bind(await hash(raw),now+28800000),
   env.DB.prepare('DELETE FROM login_attempts WHERE key=? OR resets_at<=?').bind(ip,now)
  ]);
  return json({ok:true},200,{'Set-Cookie':cookie(raw,28800,req)});
 }
 if(path==='/api/logout'&&req.method==='POST') {
  requireOrigin(req);const key=await session(req,env);if(key)await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(key).run();
  return json({ok:true},200,{'Set-Cookie':cookie('',0,req)});
 }
 if(path.startsWith('/api/admin/')) {
  if(!await session(req,env))fail('Unauthorised',401);
  if(req.method!=='GET')requireOrigin(req);
  if(path==='/api/admin/session'&&req.method==='GET')return json({ok:true});
  if(path==='/api/admin/posts'&&req.method==='GET') {
   const status=url.searchParams.get('status')||'pending';if(!['pending','published','rejected','all'].includes(status))fail('Invalid status');
   const offset=Number(url.searchParams.get('offset')||0);if(!Number.isSafeInteger(offset)||offset<0)fail('Invalid offset');
   const rows=await env.DB.prepare('SELECT * FROM posts'+(status==='all'?'':' WHERE status=?')+' ORDER BY updated_at DESC,id DESC LIMIT 51 OFFSET ?').bind(...(status==='all'?[]:[status]),offset).all();
   const counts=(await env.DB.prepare('SELECT status,COUNT(*) AS count FROM posts GROUP BY status').all()).results;
   return json({posts:rows.results.slice(0,50).map(r=>unpack(r)),has_more:rows.results.length>50,counts:Object.fromEntries(counts.map(r=>[r.status,r.count]))});
  }
  if(/^\/api\/admin\/posts\/[a-f0-9-]{36}$/.test(path)&&req.method==='PUT') {
   const id=path.split('/').pop(),body=await readBody(req);
   if(!['pending','published','rejected'].includes(body.status)||!Number.isSafeInteger(body.version))fail('Invalid status or version');
   if(body.status==='published'&&body.reviewed!==true)fail('Read the source and confirm both translations before publishing');
   const p=normalise(body,body.status==='published');
   const result=await env.DB.prepare('UPDATE posts SET source_url=?,topic=?,status=?,content=?,version=version+1,updated_at=?,published_at=CASE WHEN ?=\'published\' THEN COALESCE(published_at,?) ELSE published_at END WHERE id=? AND version=?').bind(p.source_url,p.topic,body.status,JSON.stringify(p),now,body.status,now,id,body.version).run();
   if(!result.meta.changes)fail('This post changed. Reload before saving.',409);
   return json({ok:true});
  }
 }
 if(path.startsWith('/api/'))fail('Not found',404);
 if(path==='/admin')return Response.redirect(url.origin+'/admin/',302);
 return env.ASSETS.fetch(req);
}
export default {async fetch(req,env) {
 let res;try{res=await route(req,env);}catch(error){res=json({error:error.status?error.message:'Something went wrong. Please try again.'},error.status||500);}
 const headers=new Headers(res.headers);
 headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','strict-origin-when-cross-origin');
 headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
 if(req.headers.get('Origin')===env.PUBLIC_ORIGIN&&['/api/posts','/api/config'].includes(new URL(req.url).pathname)&&req.method==='GET'){headers.set('Access-Control-Allow-Origin',env.PUBLIC_ORIGIN);headers.set('Vary','Origin');}
 return new Response(res.body,{status:res.status,headers});
}};

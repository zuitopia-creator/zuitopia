import {randomBytes, pbkdf2Sync} from 'node:crypto';
import {Writable} from 'node:stream';
import readline from 'node:readline/promises';
const write=process.argv.includes('--local');
let password;
if(process.stdin.isTTY){
 let muted=false;
 const output=new Writable({write(chunk,encoding,callback){if(!muted)process.stderr.write(chunk,encoding);callback();}});
 const rl=readline.createInterface({input:process.stdin,output,terminal:true});
 process.stderr.write('Admin password (at least 12 characters; hidden): ');muted=true;
 password=await rl.question('');muted=false;rl.close();process.stderr.write('\n');
}else{let data='';for await (const chunk of process.stdin)data+=chunk;password=data.replace(/\r?\n$/,'');}
if(password.length<12||password.length>1024)throw new Error('Use 12–1024 characters.');
const salt=randomBytes(16).toString('hex');
const hash=`pbkdf2:100000:${salt}:${pbkdf2Sync(password,Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex')}`;
if(write){
 const {writeFileSync}=await import('node:fs');
 // Local-only file, ignored by Git and excluded from deliverables.
 writeFileSync(new URL('../backend/.dev.vars',import.meta.url),`ADMIN_PASSWORD_HASH="${hash}"\nINGEST_TOKEN="${randomBytes(32).toString('hex')}"\n`,{mode:0o600});
 console.log('Local secrets saved. Run npm run db:local, then npm run dev.');
}else console.log(hash);

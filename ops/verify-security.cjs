const fs=require('fs'),vm=require('vm'),assert=require('assert');
const server=fs.readFileSync('server.js','utf8');
const code=server.slice(server.indexOf('async function requireLogin('),server.indexOf('// Helper: arma'));
let outcome={data:{estado:'activa'}},user={data:{user:{id:'verified-user',email:'user@example.com'}}},calls=0;
const chain={select(){return this},eq(k,v){assert.equal(v,'verified-user');return this},async maybeSingle(){if(outcome instanceof Error)throw outcome;return outcome;}};
const c={supabase:{from:()=>chain,auth:{getUser:async()=>user}},createClient:()=>({}),process:{env:{}}};vm.createContext(c);vm.runInContext(code,c);
const response=()=>({code:200,set(){return this},status(n){this.code=n;return this},json(x){this.body=x;return this}});
(async()=>{
let req={headers:{authorization:'Bearer valid'},userId:'attacker-id'},res=response();await c.requireLogin(req,res,()=>calls++);assert.equal(req.userId,'verified-user');assert.equal(calls,1);
res=response();await c.requireLogin({headers:{authorization:'valid'}},res,()=>calls++);assert.equal(res.code,401);
user={error:{message:'expired'}};res=response();await c.requireLogin({headers:{authorization:'Bearer expired'}},res,()=>calls++);assert.equal(res.code,401);assert.equal(calls,1);
const r={userId:'verified-user',userEmail:'user@example.com'};
res=response();await c.requirePremium(r,res,()=>calls++);assert.equal(calls,2);
outcome={data:{estado:'pendiente'}};res=response();await c.requirePremium(r,res,()=>calls++);assert.equal(res.code,403);
outcome={error:{message:'database down'}};res=response();await c.requirePremium(r,res,()=>calls++);assert.equal(res.code,503);
outcome=new Error('database down');res=response();await c.requirePremium(r,res,()=>calls++);assert.equal(res.code,503);assert.equal(calls,2);
const front=fs.readFileSync('public/index.html','utf8');let scripts=0;for(const match of front.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)){new vm.Script(match[1]);scripts++;}
const esc=front.match(/function escaparTextoMes\(valor\) \{[\s\S]*?\n  \}/)[0];vm.runInContext(esc,c);const attack='\"><img src=x onerror=alert(1)>';assert(!c.escaparTextoMes(attack).includes('<img'));assert(c.escaparTextoMes(attack).includes('&lt;img'));
console.log('PASS: authenticated identity, invalid session rejection, subscription errors fail closed, user text escaping and syntax of '+scripts+' inline scripts.');
})().catch(e=>{console.error(e);process.exit(1)});

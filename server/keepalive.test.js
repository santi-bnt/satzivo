import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createKeepaliveHandler} from './keepalive.js';

const secret='test-token-that-is-long-enough-1234567890';
const password='db-password-do-not-log';
const connectionString=`postgresql://satzora_keepalive:${password}@pooler.example.test:5432/postgres`;
const env={KEEPALIVE_TOKEN:secret,KEEPALIVE_DATABASE_URL:connectionString};
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(body){this.body=body;return this;}};}
async function run(handler,authorization=`Bearer ${secret}`,userAgent='satzivo-keepalive/github-actions'){
 const res=response();await handler({method:'POST',headers:{authorization,'user-agent':userAgent}},res);return res;
}
async function captureLogs(action){
 const original=console.info,entries=[];console.info=value=>entries.push(String(value));
 try{return {result:await action(),entries};}finally{console.info=original;}
}

test('rejects bad methods and bearer credentials before contacting PostgreSQL',async()=>{
 let clients=0;const handler=createKeepaliveHandler({env,makeClient:()=>{clients++;throw Error('must not connect');}});
 for(const [method,authorization,status] of [['GET',`Bearer ${secret}`,405],['POST','Bearer wrong',401],['POST','',401]]){
  const res=response();await handler({method,headers:{authorization}},res);assert.equal(res.code,status);assert.equal(res.headers['Cache-Control'],'no-store');
 }
 assert.equal(clients,0);
});

test('uses the Supabase root CA with strict TLS and reports success only after SELECT 1',async()=>{
 const calls=[],ca=readFileSync('supabase/supabase-root-2021.crt','utf8');
 const client={connect:async()=>calls.push('connect'),query:async sql=>{calls.push(sql);return {rows:[{ok:1}]};},end:async()=>calls.push('end')};
 const handler=createKeepaliveHandler({env,makeClient:options=>{
  assert.equal(options.ssl.rejectUnauthorized,true);assert.equal(options.ssl.ca,ca);
  assert.equal(options.connectionTimeoutMillis,5000);return client;
 }});
 const res=await run(handler);assert.equal(res.code,200);assert.deepEqual(res.body,{ok:true,check:'postgres'});
 assert.deepEqual(calls,['connect','SELECT 1 AS ok','end']);
});

test('classifies TLS, authentication and network connect failures without leaking error messages',async()=>{
 const scenarios=[
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE','tls'],
  ['28P01','authentication'],
  ['ECONNRESET','network'],
 ];
 for(const [code,category] of scenarios){
  const {result,entries}=await captureLogs(()=>run(createKeepaliveHandler({env,makeClient:()=>({connect:async()=>{const e=Error(`sensitive ${password} ${secret}`);e.code=code;throw e;},end:async()=>{}})})));
  assert.equal(result.code,503);assert.deepEqual(result.body,{ok:false,error:'database_unavailable',category});
  const logs=entries.join('\n');assert.ok(logs.includes(`"category":"${category}"`));assert.ok(logs.includes(`"code":"${code}"`));
  assert.ok(!logs.includes(password));assert.ok(!logs.includes(secret));assert.ok(!logs.includes('pooler.example.test'));
  assert.ok(!JSON.stringify(result.body).includes(password));assert.ok(!JSON.stringify(result.body).includes(secret));assert.ok(!JSON.stringify(result.body).includes('pooler.example.test'));
 }
});

test('classifies permission and SQL failures during the read-only query',async()=>{
 for(const [code,category] of [['42501','permission'],['42601','sql']]){
  const {result,entries}=await captureLogs(()=>run(createKeepaliveHandler({env,makeClient:()=>({connect:async()=>{},query:async()=>{const e=Error(`database ${password}`);e.code=code;throw e;},end:async()=>{}})})));
  assert.equal(result.code,503);assert.deepEqual(result.body,{ok:false,error:'database_unavailable',category});
  assert.ok(entries.join('\n').includes(`"phase":"query","category":"${category}"`));assert.ok(!entries.join('\n').includes(password));
 }
});

test('does not log arbitrary driver codes or error text',async()=>{
 const driverCode='SECRET_TOKEN_NOT_FOR_LOGS';
 const {result,entries}=await captureLogs(()=>run(createKeepaliveHandler({env,makeClient:()=>({connect:async()=>{const e=Error(`private ${connectionString} ${secret}`);e.code=driverCode;throw e;},end:async()=>{}})})));
 assert.equal(result.code,503);assert.deepEqual(result.body,{ok:false,error:'database_unavailable',category:'unknown'});
 const logs=entries.join('\n');assert.ok(!logs.includes(driverCode));assert.ok(!logs.includes(password));assert.ok(!logs.includes(secret));assert.ok(!logs.includes('pooler.example.test'));
});

test('rejects insecure or malformed database configuration without constructing a client',async()=>{
 for(const connection of [
  'postgresql://user:password@pooler.example.test/postgres?sslmode=disable',
  'not a database URL',
 ]){
  const handler=createKeepaliveHandler({env:{...env,KEEPALIVE_DATABASE_URL:connection},makeClient:()=>assert.fail('must not construct client')});
  const res=await run(handler);assert.equal(res.code,503);assert.deepEqual(res.body,{ok:false,error:'not_configured'});
 }
});

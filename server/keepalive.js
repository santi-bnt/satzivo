import {createHash,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';

const digest=value=>createHash('sha256').update(value).digest();
const log=(event,fields={})=>console.info(JSON.stringify({component:'keepalive',event,...fields}));
const supabaseCa=readFileSync(new URL('../supabase/supabase-root-2021.crt',import.meta.url),'utf8');
const tlsCodes=new Set(['CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','CERT_REVOKED','CERT_SIGNATURE_FAILURE','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_GET_ISSUER_CERT','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
const networkCodes=new Set(['ECONNABORTED','ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETDOWN','ENETUNREACH','ENOTFOUND','EAI_AGAIN','EPIPE','ERR_SOCKET_CLOSED','ETIMEDOUT','57P03','53300']);
function classifyDatabaseError(error,phase){
 const code=typeof error?.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(error.code)?error.code:'';
 if(tlsCodes.has(code)||/^ERR_TLS_|^CERT_/.test(code)||/certificate (?:has expired|is not yet valid|verify failed|is invalid)/i.test(error?.message??''))return {category:'tls',code};
 if(code==='28P01'||code==='28000'||code.startsWith('28'))return {category:'authentication',code};
 if(code==='42501')return {category:'permission',code};
 if(networkCodes.has(code)||code.startsWith('08'))return {category:'network',code};
 if(phase==='query'||/^[0-9A-Z]{5}$/.test(code))return {category:'sql',code};
 return {category:'unknown',code};
}
export function createKeepaliveHandler({env=process.env,makeClient=options=>new pg.Client(options)}={}){
 return async function keepalive(req,res){
  res.setHeader('Cache-Control','no-store');
  const userAgent=typeof req.headers['user-agent']==='string'?req.headers['user-agent']:'';
  const scheduler=userAgent.toLowerCase().includes('github-actions')?'github-actions':userAgent.toLowerCase().includes('vercel-cron')?'vercel-cron':'unknown';
  if(req.method!=='POST'){log('request_rejected',{stage:'method',scheduler,status:405});return res.status(405).json({ok:false,error:'method_not_allowed'});}
  const secret=env.KEEPALIVE_TOKEN,connectionString=env.KEEPALIVE_DATABASE_URL;
  if(!secret||secret.length<32||!connectionString){log('configuration_failed',{stage:'configuration',scheduler});return res.status(503).json({ok:false,error:'not_configured'});}
  try{const url=new URL(connectionString);if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||[...url.searchParams.keys()].some(k=>k.toLowerCase().startsWith('ssl')))throw new Error();}catch{log('configuration_failed',{stage:'configuration',scheduler});return res.status(503).json({ok:false,error:'not_configured'});}
  const authorization=typeof req.headers.authorization==='string'?req.headers.authorization:'';
  const match=authorization.match(/^Bearer ([^\s]+)$/i),provided=match?.[1]??'';
  if(!provided||!timingSafeEqual(digest(provided),digest(secret))){log('authentication_failed',{stage:'authentication',scheduler,status:401});return res.status(401).json({ok:false,error:'unauthorized'});}
  log('database_check_started',{stage:'database',scheduler});
  let client,phase='connect';
  try{
   client=makeClient({connectionString,ssl:{ca:supabaseCa,rejectUnauthorized:true},connectionTimeoutMillis:5000,query_timeout:5000,statement_timeout:5000});
   await client.connect();
   phase='query';
   const result=await client.query('SELECT 1 AS ok');
   if(result.rows?.length!==1||result.rows[0]?.ok!==1)throw new Error('unexpected_result');
   log('database_check_succeeded',{stage:'database',scheduler});return res.status(200).json({ok:true,check:'postgres'});
  }catch(error){
   // Log only an allow-listed error code and category; never provider messages or connection details.
   const failure=classifyDatabaseError(error,phase);
   log('database_check_failed',{stage:'database',scheduler,phase,category:failure.category,...(failure.code?{code:failure.code}:{})});
   return res.status(503).json({ok:false,error:'database_unavailable',category:failure.category});
  }finally{if(client)try{await client.end();}catch{}}
 };
}
export default createKeepaliveHandler();

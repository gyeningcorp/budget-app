import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApp } from '../server/app.js'
import { approvedConnectURL, matchesProvider, validDay, statementFields } from '../shared/billing.js'
test('bill facts keep unknown values blank and allow only the actual connector host', () => {
 assert(matchesProvider('columbia-gas','Columbia Gas of Pennsylvania'))
 assert(!matchesProvider('t-mobile','Some other telephone company'))
 assert(!validDay('2026-02-30')); assert(validDay('2028-02-29'))
 assert.equal(statementFields({amount:null,due:'unknown',accountLast4:'123456'}).amount,null)
 assert.equal(statementFields({amount:0,due:'2026-11-23'}).amount,0)
 assert(approvedConnectURL('https://platform-connect.arcadia.com/encoded-token'))
 for(const url of ['javascript:alert(1)','https://platform-connect.arcadia.com.evil.example/','https://user:password@platform-connect.arcadia.com/'])assert(!approvedConnectURL(url))
})
test('bill connections and extraction are private, consented, deduplicated and isolated', async () => {
 const origin='http://127.0.0.1:3000', dir=mkdtempSync(join(tmpdir(),'bill-test-'))
 let correlation='', aiCalls=0, invalidURL=false, invalidAuth=false
 const fakeStatement={id:'statement-a',accountData:[{accountId:'account-a'}],provider:{name:'Columbia Gas of Pennsylvania'},currencyCode:'USD',amountDue:85.42,dueDate:'2026-11-23',statementDate:'2026-11-02'}
 const service=await createApp({databasePath:join(dir,'test.sqlite'),baseURL:origin,secret:'billing-tests-only-long-secret-for-encryption',billFetch:async(url,options)=>{
  if(url.endsWith('/oauth2/token'))return new Response(JSON.stringify(invalidAuth?{error:'bad_credentials'}:{access_token:'fake-connector-token',expires_in:300}),{status:invalidAuth?401:200})
  if(url.includes('/plug/providers'))return Response.json({providers:[{id:'provider-a',name:'Columbia Gas of Pennsylvania',statements:{isSupported:true}}]})
  if(url.endsWith('/encodedConnectUrl')){correlation=JSON.parse(options.body).correlationId;return Response.json({url:invalidURL?'https://evil.example/steal':'https://platform-connect.arcadia.com/test-only-encoded-url'})}
  if(url.includes('/plug/statements'))return Response.json({page:{totalPages:1},statements:[{...fakeStatement,correlationIds:[correlation]},{...fakeStatement,id:'old',statementDate:'2026-10-02',amountDue:500,correlationIds:[correlation]},{...fakeStatement,id:'private-other-family',accountData:[{accountId:'private'}],correlationIds:['another-household']},{...fakeStatement,id:'wrong-provider',provider:{name:'Other company'},accountData:[{accountId:'wrong'}],correlationIds:[correlation]}]})
  throw new Error('Unexpected test request '+url)
 },aiFetch:async(url,options)=>{aiCalls++;const payload=JSON.parse(options.body);assert(payload.system.includes('untrusted'));return Response.json({content:[{type:'text',text:JSON.stringify({providerName:'Columbia Gas of Pennsylvania',amount:85.42,due:'2026-11-23',statementDate:'2026-11-02',accountLast4:'1234',notes:''})}]})}})
 const server=service.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`,cookies=new Map()
 async function request(who,path,body){const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin,'x-forwarded-for':`203.0.113.${['owner','member','outsider','anon'].indexOf(who)+70}`,'content-type':'application/json',cookie:cookies.get(who)||''},...(body===undefined?{}:{body:JSON.stringify(body)})});const set=response.headers.getSetCookie();if(set.length)cookies.set(who,set.map(x=>x.split(';')[0]).join('; '));return {status:response.status,data:await response.json()}}
 try {
  assert.equal((await request('anon','/api/family/billing')).status,401)
  for(const who of ['owner','member','outsider'])assert.equal((await request(who,'/api/auth/sign-up/email',{name:who,email:who+'@billing-test.example',password:'billing-test-passphrase!'})).status,200)
  await request('owner','/api/family/create',{name:'Our family'});await request('outsider','/api/family/create',{name:'Different family'})
  const invite=await request('owner','/api/family/invite',{});await request('member','/api/family/join',{token:invite.data.url.split('#invite=')[1]})
  assert.equal((await request('owner','/api/family/billing/connect',{providerId:'columbia-gas',consent:true})).status,503)
  const keys={clientId:'fake-test-client',clientSecret:'fake-test-secret'}
  assert.equal((await request('member','/api/family/billing/settings',keys)).status,403)
  assert.equal((await request('owner','/api/family/billing/settings',keys)).status,200)
  assert(!service.db.prepare('SELECT encrypted_keys FROM billing_settings').get().encrypted_keys.includes('fake-test-secret'))
  assert.equal((await request('outsider','/api/family/billing')).data.configured,false)
  const coverage=await request('owner','/api/family/billing/coverage',{providerId:'columbia-gas'});assert.equal(coverage.data.matches[0].statementsSupported,true)
  assert.equal((await request('owner','/api/family/billing/connect',{providerId:'columbia-gas',consent:false})).status,400)
  invalidURL=true;assert.equal((await request('owner','/api/family/billing/connect',{providerId:'columbia-gas',consent:true})).status,502);assert.equal((await request('owner','/api/family/billing')).data.connections.length,0)
  invalidURL=false;assert.equal((await request('owner','/api/family/billing/connect',{providerId:'columbia-gas',consent:true})).data.status,'authorization_started')
  assert.equal((await request('owner','/api/family/billing/sync',{providerId:'columbia-gas'})).data.imported,1)
  await request('owner','/api/family/billing/sync',{providerId:'columbia-gas'})
  const own=await request('owner','/api/family/state');assert.equal(own.data.state.bills.length,1);assert.equal(own.data.state.bills[0].amount,85.42);assert.equal((await request('outsider','/api/family/state')).data.state.bills.length,0)
  invalidAuth=true;assert.equal((await request('owner','/api/family/billing/settings',keys)).status,400);assert.equal((await request('owner','/api/family/billing')).data.configured,true);invalidAuth=false
  await request('owner','/api/family/billing/pause',{providerId:'columbia-gas'});assert.equal((await request('owner','/api/family/billing/sync',{providerId:'columbia-gas'})).status,400)
  const resumed=await request('owner','/api/family/billing/resume',{providerId:'columbia-gas'});assert.equal(resumed.status,200);assert.equal(resumed.data.resumed,true)
  assert.equal((await request('owner','/api/family/billing/sync',{providerId:'columbia-gas'})).data.imported,1)
  await request('owner','/api/family/ai-key',{key:'sk-ant-fake-test-bill-key-only'})
  const bill={providerId:'columbia-gas',text:'Columbia Gas amount due $85.42 on November 23, 2026',consent:true}
  assert.equal((await request('member','/api/family/billing/extract',{...bill,consent:false})).status,400);assert.equal(aiCalls,0)
  assert.equal((await request('member','/api/family/billing/extract',{...bill,file:{type:'application/pdf',data:Buffer.from('not really a pdf').toString('base64')}})).status,400);assert.equal(aiCalls,0)
  const extracted=await request('member','/api/family/billing/extract',bill);assert.equal(extracted.status,200);assert.equal(extracted.data.draft.amount,85.42);assert.equal(extracted.data.providerMatches,true)
  assert.equal((await request('member','/api/family/state')).data.state.bills.length,1,'extracting does not save a second bill until reviewed')
  const other=await request('outsider','/api/family/billing/extract',bill);assert.equal(other.status,400,'cannot use another household Claude key')
  assert(!JSON.stringify((await request('member','/api/family/billing')).data).includes('fake-test-secret'))
 } finally {await new Promise(r=>server.close(r));service.close();rmSync(dir,{recursive:true,force:true})}
})

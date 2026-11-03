import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createApp } from '../server/app.js'
import { applyOps, differences, emptyShared } from '../shared/sync.js'
import { holidays, eventsForYear } from '../src/family.js'
import { addStaplesToList } from '../shared/groceries.js'
import { allCategories, categoryBudgets } from '../shared/budgets.js'
test('budget line items and custom categories sum per category and sync cleanly', () => {
  const original=emptyShared()
  const items=[{id:'bi1',category:'Utilities',name:'Columbia Gas',amount:90,actual:85.42,notes:'Autopay'},{id:'bi2',category:'Utilities',name:'American Water',amount:60,actual:54.58},{id:'bi3',category:'Subscriptions',name:'Netflix',amount:18,actual:18}]
  const saved=applyOps(original,differences(original,{...original,budgets:{Food:600,Utilities:300},budgetItems:items}),true)
  assert.equal(saved.budgetItems.length,3)
  assert.throws(()=>applyOps(original,[{field:'budgetItems',id:'bad',before:null,value:{id:'bad',category:'Food',name:'',amount:10}}]),/Invalid budgetItems/)
  const summary=categoryBudgets(saved,{Food:200})
  assert.equal(summary.find(x=>x.category==='Food').effective,600)
  assert.equal(summary.find(x=>x.category==='Food').actual,200)
  assert.equal(summary.find(x=>x.category==='Utilities').effective,150,'line items override static category limit')
  assert.equal(summary.find(x=>x.category==='Utilities').actual,140,'typed line-item actuals sum per category')
  assert.equal(summary.find(x=>x.category==='Subscriptions').effective,18,'custom category created from line items')
  assert(allCategories(saved).includes('Subscriptions'))
})
test('always-list groceries sync as household records and load without duplicates', () => {
  const original=emptyShared(), staples=[{id:'s1',name:'Milk',quantity:'1 gallon'},{id:'s2',name:'Eggs',quantity:''},{id:'s3',name:'Bread',quantity:''}]
  const saved=applyOps(original,differences(original,{...original,groceryStaples:staples}),true);assert.equal(saved.groceryStaples.length,3)
  assert.throws(()=>applyOps(original,[{field:'groceryStaples',id:'bad',before:null,value:{id:'bad',name:'  '}}]),/Invalid groceryStaples/)
  let n=0;const list=[{id:'g1',name:'milk',quantity:'',checked:false},{id:'g2',name:'Eggs',quantity:'6',checked:true},{id:'g3',name:'Apples',quantity:'',checked:false}]
  const result=addStaplesToList(list,staples,()=>'new-'+(++n))
  assert.equal(result.added,2);assert.equal(result.skipped,1)
  assert.equal(result.groceries.length,4,'unchecked milk is kept, checked eggs are reused, bread is added')
  assert.equal(result.groceries.find(g=>g.id==='g2').checked,false)
  assert.equal(result.groceries.find(g=>g.name==='Bread').id,'new-1')
  assert.equal(addStaplesToList(result.groceries,staples).added,0,'loading twice adds nothing')
})
const origin = 'http://127.0.0.1:3000'
const secret = 'test-only-family-auth-secret-at-least-32-chars'
test('date rules and independent edits preserve each other, conflicting edits are rejected', () => {
  for (const date of ['2026-01-01','2026-01-19','2026-02-16','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-10-12','2026-11-11','2026-11-26','2026-12-25']) assert(holidays(2026).some(e => e.date === date && e.kind === 'Federal holiday'))
  assert(holidays(2027).some(e => e.date === '2027-12-31' && e.title === "New Year's Day (observed)"))
  assert.equal(eventsForYear([{date:'2024-02-29',repeat:'Yearly'}],2025).length,0)
  const original=emptyShared(), a={...original,groceries:[{id:'a',name:'Bread',checked:false}]}, b={...original,groceries:[{id:'b',name:'Rice',checked:false}]}
  const merged=applyOps(a,differences(original,b),true);assert.equal(merged.groceries.length,2)
  assert.throws(()=>applyOps(a,[{field:'groceries',id:'a',before:{id:'a',name:'Milk'},value:null}],true),/Someone changed/)
  assert.throws(()=>applyOps(a,[{field:'apiKey',id:'key',before:null,value:'secret'}]),/Invalid change/)
  assert.throws(()=>applyOps(a,[{field:'budgets',id:'__proto__',before:null,value:3}]),/Invalid change/)
})
test('accounts, private households, invitations, sync, encrypted shared AI and durable storage', async () => {
  const directory=mkdtempSync(join(tmpdir(),'family-test-')), path=join(directory,'family.sqlite')
  let upstreamCalls=0
  let service=await createApp({databasePath:path,baseURL:origin,secret,aiFetch:async(url,options)=>{upstreamCalls++;assert.equal(options.headers['x-api-key'],'sk-ant-test-only-fake-key-never-live');assert.equal(JSON.parse(options.body).max_tokens,2048);return new Response(JSON.stringify({content:[{type:'text',text:'Test idea'}]}),{headers:{'content-type':'application/json'}})}})
  let server=service.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));let base=`http://127.0.0.1:${server.address().port}`
  const cookies=new Map()
  async function request(who,path,body,other={}) {const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin,'x-forwarded-for':`203.0.113.${['owner','partner','outsider','fourth','anon'].indexOf(who)+10}`,'content-type':'application/json',...(cookies.get(who)?{cookie:cookies.get(who)}:{}),...other},...(body===undefined?{}:{body:JSON.stringify(body)})});const set=response.headers.getSetCookie();if(set.length)cookies.set(who,set.map(x=>x.split(';')[0]).join('; '));return {status:response.status,data:await response.json()}}
  const signup=who=>request(who,'/api/auth/sign-up/email',{name:who,email:`${who}@example.com`,password:'test-passphrase-12345!'})
  try {
    assert.equal((await request('anon','/api/family/state')).status,401)
    for(const who of ['owner','partner','outsider','fourth'])assert.equal((await signup(who)).status,200)
    assert.equal((await request('owner','/api/family/create',{name:'Test family'})).status,201)
    assert.equal((await request('outsider','/api/family/create',{name:'Other family'})).status,201)
    assert.equal((await request('owner','/api/family/invite',{}, {origin:'https://evil.example'})).status,403)
    const invited=await request('owner','/api/family/invite',{}), token=invited.data.url.split('#invite=')[1]
    assert.equal((await request('partner','/api/family/join',{token})).status,200)
    assert.equal((await request('fourth','/api/family/join',{token})).status,400)
    const mutation={id:randomUUID(),ops:[{field:'dateNights',id:'date-1',before:null,value:{id:'date-1',title:'Coffee',date:'2026-11-10',budget:'',spent:'',notes:'',status:'Planned'}}]}
    assert.equal((await request('owner','/api/family/state',mutation)).status,200)
    assert.equal((await request('owner','/api/family/state',mutation)).data.revision,1)
    assert.equal((await request('partner','/api/family/state')).data.state.dateNights[0].title,'Coffee')
    assert.equal((await request('outsider','/api/family/state')).data.state.dateNights.length,0)
    const change=who=>request(who,'/api/family/state',{id:randomUUID(),ops:[{field:'dateNights',id:'date-1',before:mutation.ops[0].value,value:{...mutation.ops[0].value,title:who}}]})
    assert.equal((await change('partner')).status,200);assert.equal((await change('owner')).status,409)
    assert.equal((await request('partner','/api/family/ai-key',{key:'sk-ant-test-only-fake-key-never-live'})).status,403)
    assert.equal((await request('owner','/api/family/ai-key',{key:'sk-ant-test-only-fake-key-never-live'})).status,200)
    assert(!(service.db.prepare('SELECT encrypted_key FROM ai_settings').get().encrypted_key.includes('sk-ant-')))
    const info=await request('partner','/api/family');assert(info.data.ai.configured);assert(!JSON.stringify(info).includes('sk-ant-'))
    assert.equal((await request('partner','/api/family/ai',{messages:[{role:'user',content:'A date idea'}],max_tokens:9000})).status,200);assert.equal(upstreamCalls,1)
    const hid=info.data.household.id;service.db.prepare('UPDATE ai_usage SET requests=100 WHERE household_id=?').run(hid)
    assert.equal((await request('partner','/api/family/ai',{messages:[{role:'user',content:'Another'}]})).status,429)
    const partnerId=info.data.user.id
    assert.equal((await request('outsider','/api/family/remove-member',{userId:partnerId})).status,200)
    assert.equal((await request('partner','/api/family/state')).status,200)
    assert.equal((await request('owner','/api/family/remove-member',{userId:partnerId})).status,200)
    assert.equal((await request('partner','/api/family/state')).status,403)
    const expired=await request('owner','/api/family/invite',{});service.db.prepare('UPDATE invitations SET expires=0 WHERE id=?').run(expired.data.id);assert.equal((await request('fourth','/api/family/join',{token:expired.data.url.split('#invite=')[1]})).status,400)
    const revoke=await request('owner','/api/family/invite',{});await request('owner','/api/family/revoke-invite',{id:revoke.data.id})
    assert.equal((await request('fourth','/api/family/join',{token:revoke.data.url.split('#invite=')[1]})).status,400)
    await new Promise(r=>server.close(r));service.close()
    service=await createApp({databasePath:path,baseURL:origin,secret});server=service.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`
    assert.equal((await request('owner','/api/family/state')).data.state.dateNights[0].title,'partner')
    assert.equal((await request('owner','/api/family')).data.ai.configured,true)
  } finally {await new Promise(r=>server.close(r));service.close();rmSync(directory,{recursive:true,force:true})}
})

import {createECDH,createPrivateKey,createSign,createCipheriv,hkdfSync,randomBytes} from 'node:crypto'
const b64=value=>Buffer.from(value).toString('base64url')
const derive=(key,salt,info,length)=>Buffer.from(hkdfSync('sha256',key,salt,info,length))
function encryptPayload(subscription,payload){
 const receiver=Buffer.from(subscription.keys.p256dh,'base64url'),auth=Buffer.from(subscription.keys.auth,'base64url')
 const ephemeral=createECDH('prime256v1');ephemeral.generateKeys()
 const sender=ephemeral.getPublicKey(), shared=ephemeral.computeSecret(receiver)
 const ikm=derive(shared,auth,Buffer.concat([Buffer.from('WebPush: info'),Buffer.from([0]),receiver,sender]),32)
 const salt=randomBytes(16),cek=derive(ikm,salt,Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'),Buffer.from([0])]),16),nonce=derive(ikm,salt,Buffer.concat([Buffer.from('Content-Encoding: nonce'),Buffer.from([0])]),12)
 const cipher=createCipheriv('aes-128-gcm',cek,nonce)
 const encrypted=Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload),Buffer.from([2])])),cipher.final(),cipher.getAuthTag()])
 const size=Buffer.alloc(4);size.writeUInt32BE(4096)
 return Buffer.concat([salt,size,Buffer.from([sender.length]),sender,encrypted])
}
async function sendWebPush(subscription,payload,publicKey,privateKey,baseURL){
 const key=Buffer.from(publicKey,'base64url'),x=b64(key.subarray(1,33)),y=b64(key.subarray(33,65))
 const privateObject=createPrivateKey({key:{kty:'EC',crv:'P-256',x,y,d:privateKey},format:'jwk'})
 const origin=new URL(subscription.endpoint).origin
 const header=b64(JSON.stringify({typ:'JWT',alg:'ES256'}))
 const claims=b64(JSON.stringify({aud:origin,exp:Math.floor(Date.now()/1000)+3600,sub:'mailto:notifications@'+new URL(baseURL).hostname}))
 const signing=createSign('SHA256');signing.update(header+'.'+claims);signing.end()
 const token=header+'.'+claims+'.'+b64(signing.sign({key:privateObject,dsaEncoding:'ieee-p1363'}))
 const response=await fetch(subscription.endpoint,{method:'POST',headers:{Authorization:'vapid t='+token+', k='+publicKey,TTL:'3600','Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream'},body:encryptPayload(subscription,payload),signal:AbortSignal.timeout(10000)})
 if(!response.ok){const error=new Error('Push provider rejected notification');error.statusCode=response.status;throw error}
}

const offsets = event => Array.isArray(event.reminders) ? event.reminders : []
const easternDay = date => {const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);const get=type=>parts.find(p=>p.type===type).value;return `${get('year')}-${get('month')}-${get('day')}`}
const validSubscription = value => value && typeof value.endpoint === 'string' && /^https:\/\//.test(value.endpoint) && value.endpoint.length < 2048 && typeof value.keys?.p256dh === 'string' && typeof value.keys?.auth === 'string'
export function registerPush(app,{db,needFamily,baseURL}) {
 db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, household_id TEXT NOT NULL, user_id TEXT NOT NULL, subscription TEXT NOT NULL, created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS push_deliveries (household_id TEXT NOT NULL, event_id TEXT NOT NULL, scheduled_at INTEGER NOT NULL, PRIMARY KEY(household_id,event_id,scheduled_at));`)
 const publicKey=process.env.VAPID_PUBLIC_KEY, privateKey=process.env.VAPID_PRIVATE_KEY
 const configured=Boolean(publicKey && privateKey)

 app.get('/api/family/push/config',needFamily,(req,res)=>res.json({enabled:configured,publicKey:configured?publicKey:null}))
 app.post('/api/family/push/subscribe',needFamily,(req,res)=>{
  if(!configured)return res.status(503).json({error:'Push notifications are not configured.'})
  const subscription=req.body?.subscription
  if(!validSubscription(subscription))return res.status(400).json({error:'Invalid push subscription.'})
  db.prepare('INSERT INTO push_subscriptions(endpoint,household_id,user_id,subscription,created_at) VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET household_id=excluded.household_id,user_id=excluded.user_id,subscription=excluded.subscription,created_at=excluded.created_at').run(subscription.endpoint,req.member.household_id,req.user.id,JSON.stringify(subscription),Date.now())
  res.json({ok:true})
 })
 app.post('/api/family/push/unsubscribe',needFamily,(req,res)=>{
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?').run(String(req.body?.endpoint||''),req.user.id)
  res.json({ok:true})
 })
 async function checkDuePush(){
  if(!configured)return
  const now=Date.now()
  for(const household of db.prepare('SELECT id,data FROM households').all()){
   const state=JSON.parse(household.data), events=state.familyEvents||[]
   for(const event of events){
    if(!event.time || !/^\d{2}:\d{2}$/.test(event.time) || !/^\d{4}-\d{2}-\d{2}$/.test(event.date))continue
    const days=event.repeat==='Weekly'?(event.weekdays||[]):[]
    const dates=[]
    if(event.repeat==='Weekly'){
     for(let shift=-1;shift<8;shift++){const d=new Date(now+shift*86400000);const date=easternDay(d);if(days.includes(new Date(date+'T12:00:00Z').getUTCDay())&&date>=event.date&&(!event.endDate||date<=event.endDate))dates.push(date)}
    }else dates.push(event.date)
    for(const date of dates)for(const offset of offsets(event)){
     if(!Number.isInteger(offset)||offset<0||offset>40320)continue
     // Resolve local event time using the household's current Eastern timezone offset.
     const local=Date.parse(date+'T'+event.time+':00Z')
     const hour=new Date(local).toLocaleString('en-US',{timeZone:'America/New_York',timeZoneName:'shortOffset'}).match(/GMT([+-]\d{1,2})(?::(\d{2}))?/)
     const zone=hour?Number(hour[1])*60+Math.sign(Number(hour[1]))*Number(hour[2]||0):-300
     const due=local-zone*60000-offset*60000
     if(due>now||due<now-90000)continue
     const inserted=db.prepare('INSERT OR IGNORE INTO push_deliveries(household_id,event_id,scheduled_at) VALUES(?,?,?)').run(household.id,event.id,due)
     if(!inserted.changes)continue
     const payload=JSON.stringify({title:event.title,body:offset===0?'Starting now':`Starts in ${offset} minutes`,url:'/#calendar'})
     for(const row of db.prepare('SELECT endpoint,subscription FROM push_subscriptions WHERE household_id=?').all(household.id)){
      try{await sendWebPush(JSON.parse(row.subscription),payload,publicKey,privateKey,baseURL)}catch(error){if([404,410].includes(error.statusCode))db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(row.endpoint);else console.error('Push delivery failed:',error.statusCode||error.message)}
     }
    }
   }
  }
  db.prepare('DELETE FROM push_deliveries WHERE scheduled_at<?').run(now-30*86400000)
 }
 return {checkDuePush}
}

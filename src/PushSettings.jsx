import {useEffect,useState} from 'react'
const decodeKey=value=>{const padding='='.repeat((4-value.length%4)%4);const binary=atob((value+padding).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(binary,c=>c.charCodeAt(0))}
export default function PushSettings(){
 const [status,setStatus]=useState(''),[active,setActive]=useState(false),[busy,setBusy]=useState(false)
 useEffect(()=>{if('serviceWorker' in navigator&&'PushManager' in window)navigator.serviceWorker.ready.then(r=>r.pushManager.getSubscription()).then(s=>setActive(Boolean(s))).catch(()=>{})},[])
 const enable=async()=>{
  setBusy(true)
  try{
   if(!('serviceWorker' in navigator)||!('PushManager' in window))throw Error('Install Family Hub to your Home Screen and open it there to enable iPhone notifications.')
   if(Notification.permission==='denied')throw Error('Notifications are blocked. Enable them in iPhone Settings for Family Hub.')
   const configResponse=await fetch('/api/family/push/config',{credentials:'include'})
   if(!configResponse.ok)throw Error('Sign in to your family account first.')
   const config=await configResponse.json()
   if(!config.enabled)throw Error('Push service is not configured yet.')
   const permission=await Notification.requestPermission()
   if(permission!=='granted')throw Error('Notifications permission was not granted.')
   const registration=await navigator.serviceWorker.ready
   const subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decodeKey(config.publicKey)})
   const response=await fetch('/api/family/push/subscribe',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({subscription:subscription.toJSON()})})
   if(!response.ok)throw Error('Could not save the device subscription.')
   setActive(true);setStatus('Push notifications enabled on this device.')
  }catch(error){setStatus(error.message)}finally{setBusy(false)}
 }
 const disable=async()=>{
  setBusy(true)
  try{const registration=await navigator.serviceWorker.ready;const subscription=await registration.pushManager.getSubscription();if(subscription){await fetch('/api/family/push/unsubscribe',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:subscription.endpoint})});await subscription.unsubscribe()}setActive(false);setStatus('Notifications disabled on this device.')}catch(error){setStatus(error.message)}finally{setBusy(false)}
 }
 return <div className="family-card"><h3>Phone push notifications</h3><p>Get calendar reminders even when Family Hub is closed. On iPhone, use Safari → Share → Add to Home Screen, then open the installed app.</p><button className="btn" disabled={busy} onClick={active?disable:enable}>{busy?'Working…':active?'Disable notifications':'Enable notifications on this phone'}</button>{status&&<p role="status">{status}</p>}</div>
}

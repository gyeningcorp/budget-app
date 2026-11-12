import { useLayoutEffect, useRef, useState } from 'react'
import { dateKey } from './family.js'
const uid=()=>crypto.randomUUID()
const chores=[
 ['Monday','Chris','Dishes and kitchen reset'],['Monday','Sarah','Evening tidy'],
 ['Tuesday','Sarah','Laundry and kids rooms'],['Tuesday','Chris','Trash, recycling and floors'],
 ['Wednesday','Sarah','Groceries and meal prep'],['Wednesday','Chris','Bathrooms and dishes'],
 ['Thursday','Together','20-minute whole-house reset'],
 ['Friday','Chris','Kids dinner and bedtime'],['Saturday','Chris','Kids laundry and toy pickup'],
 ['Sunday','Together','Prepare lunches and clothes'],['Sunday','Together','15-minute calendar sync']
]
const rhythms=[
 ['Monday','Chris','WFH and childcare'],['Monday','Sarah','Possible work shift'],
 ['Tuesday','Sarah','Childcare coverage'],['Tuesday','Together','Couple time'],
 ['Wednesday','Sarah','Childcare and painting time'],
 ['Thursday','Sarah','Childcare coverage'],['Thursday','Chris','Individual recharge'],
 ['Friday','Chris','WFH and childcare'],['Friday','Sarah','Possible work shift'],
 ['Friday','Together','Family movie or game night'],
 ['Saturday','Chris','Primary childcare'],['Saturday','Sarah','Possible work shift'],
 ['Sunday','Chris','Primary childcare'],['Sunday','Sarah','Possible work shift']
]
const checklist=[
 ['Budget','Review income, expenses and missing bills'],['Budget','Agree on equal personal allowances'],
 ['Banking','Confirm joint bills account and individual account setup'],
 ['Banking','Confirm each autopay due date and funding source'],
 ['Debt','Choose Capital One freeze, payoff or closure plan'],
 ['Communication','Agree on a shared response to extended family'],
 ['Career','Chris: review flexible primary roles'],['Career','Sarah: explore flexible income options']
]
const priorities=[['Tier 1 — Essentials','Housing, electricity, water, heat, groceries, medical needs and essential transport'],['Tier 2 — Obligations','Debt minimums, phone and internet'],['Tier 3 — Pause first','Dining out, impulse purchases, optional subscriptions and extra debt payments']]
const defaults=()=>({
 allowance:'', capitalOne:'Freeze new spending', familyMessage:'',
 tasks:chores.map(([day,owner,title])=>({id:uid(),day,owner,title,done:false})),
 goals:checklist.map(([category,title])=>({id:uid(),category,title,done:false})),
 schedules:rhythms.map(([day,owner,title])=>({id:uid(),day,owner,title})),
 accounts:[{name:'Joint bills',purpose:'Shared household bills, groceries and childcare'},{name:'Chris personal',purpose:'Personal allowance and spending'},{name:'Sarah personal',purpose:'Personal allowance and spending'}]
})
export default function FamilyHQ({state,setState,onNavigate}){
 const plan=state.familyPlan
 const pendingScroll=useRef(null)
 const preserveScroll=()=>{pendingScroll.current={x:window.scrollX,y:window.scrollY}}
 useLayoutEffect(()=>{if(pendingScroll.current){const {x,y}=pendingScroll.current;pendingScroll.current=null;window.scrollTo({left:x,top:y,behavior:'instant'})}})
 const [message,setMessage]=useState('')
 const [newTask,setNewTask]=useState('')
 const [owner,setOwner]=useState('Together')
 const [day,setDay]=useState('Monday')
 const update=patch=>{preserveScroll();setState(s=>({...s,familyPlan:{...s.familyPlan,...patch}}))}
 const begin=()=>{preserveScroll();setState(s=>({...s,familyPlan:defaults()}));setMessage('Editable household plan created. Nothing has been sent to a bank or scheduled for autopay.')}
 const addCalendar=()=>{
  const start=dateKey(),weekday=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
  const events=(plan.schedules||[]).map(item=>{
   const d=new Date(start+'T12:00:00');d.setDate(d.getDate()+(weekday.indexOf(item.day)-d.getDay()+7)%7)
   return {id:uid(),title:item.title,date:dateKey(d),time:'',kind:'Family',owner:item.owner,location:'',notes:'Family HQ schedule — editable',repeat:'Weekly',weekdays:[weekday.indexOf(item.day)],endDate:''}
  })
  preserveScroll()
  setState(s=>({...s,familyEvents:[...(s.familyEvents||[]),...events],familyPlan:{...s.familyPlan,calendarAdded:true}}))
  setMessage('Weekly schedule added to your calendar. Edit event times and details in Calendar.')
 }
 return <section className="family-space">
  <div className="family-heading"><div><p className="family-eyebrow">HOUSE OF GYENING</p><h2>Family HQ</h2><p>Shared priorities, clear responsibilities and protected family time.</p></div></div>
  {!plan?<div className="family-card"><h3>Start your family plan</h3><p>Load your proposed Chris and Sarah household schedule as an editable template. This does not connect accounts, activate autopay or change existing bills.</p><button className="btn" onClick={begin}>Load our editable family plan</button></div>:<>
   {message&&<p role="status" className="family-notice">{message}</p>}
   <div className="family-card"><h3>Financial agreement</h3><p>Three-account structure — planning only, no bank transfers or autopay enabled.</p>
    {plan.accounts.map(a=><p key={a.name}><b>{a.name}:</b> {a.purpose}</p>)}
    <label className="family-field"><span>Equal personal allowance per person, per paycheck ($)</span><input type="number" min="0" step="0.01" value={plan.allowance} onChange={e=>update({allowance:e.target.value})}/></label>
    <p>Payday review: 1st — housing, utilities, first-half groceries and transport. 15th — remaining bills, debt minimums and second-half essentials. Confirm actual pay dates and bill due dates before changing autopay with providers.</p>
    {priorities.map(([title,description])=><p key={title}><b>{title}:</b> {description}</p>)}
    <label className="family-field"><span>Capital One decision</span><select value={plan.capitalOne} onChange={e=>update({capitalOne:e.target.value})}><option>Freeze new spending</option><option>Pay minimums while tight</option><option>Pay down with extra income</option><option>Consider closing after payoff</option></select></label>
    <p>Late-bill agreement: check together three days before a due date if funds are short, and resolve it without blame.</p>
    <button className="btn ghost" onClick={()=>onNavigate('Paychecks')}>Review bills and paychecks</button>
   </div>
   <div className="family-card"><h3>Weekly work, childcare and quality time</h3><p>Sarah's Friday–Monday shifts are tentative. Confirm before relying on childcare coverage. WFH is not automatically childcare availability.</p>
    {(plan.schedules||[]).map(item=><div key={item.id} className="family-agenda"><div><small>{item.day} · {item.owner}</small><p>{item.title}</p></div><button className="btn ghost" onClick={()=>update({schedules:plan.schedules.filter(x=>x.id!==item.id)})}>Remove</button></div>)}
    <button className="btn" disabled={!!plan.calendarAdded} onClick={addCalendar}>{plan.calendarAdded?'Schedule added to calendar':'Add weekly schedule to calendar'}</button>
    <button className="btn ghost" onClick={()=>onNavigate('Calendar')}>Open calendar</button>
   </div>
   <div className="family-card"><h3>Chores and childcare</h3><p>Check off responsibilities as completed. Reset when starting a new week.</p>
    {(plan.tasks||[]).map(t=><label key={t.id} className="family-task"><input type="checkbox" checked={t.done} onChange={e=>update({tasks:plan.tasks.map(x=>x.id===t.id?{...x,done:e.target.checked}:x)})}/><span>{t.day} · {t.owner} — {t.title}</span></label>)}
    <div className="family-form-grid"><label className="family-field"><span>Day</span><select value={day} onChange={e=>setDay(e.target.value)}>{['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map(x=><option key={x}>{x}</option>)}</select></label><label className="family-field"><span>Responsible</span><select value={owner} onChange={e=>setOwner(e.target.value)}>{['Chris','Sarah','Together'].map(x=><option key={x}>{x}</option>)}</select></label></div>
    <label className="family-field"><span>New responsibility</span><input value={newTask} onChange={e=>setNewTask(e.target.value)}/></label>
    <div className="family-actions"><button className="btn" disabled={!newTask.trim()} onClick={()=>{update({tasks:[...plan.tasks,{id:uid(),day,owner,title:newTask.trim(),done:false}]});setNewTask('')}}>Add task</button><button className="btn ghost" onClick={()=>update({tasks:plan.tasks.map(t=>({...t,done:false}))})}>Reset weekly checkboxes</button></div>
   </div>
   <div className="family-card"><h3>Budget meeting and shared goals</h3><p>Schedule a distraction-free 45–60 minute meeting. Review your existing budget, decide together and track progress.</p>
    {plan.goals.map(g=><label key={g.id} className="family-task"><input type="checkbox" checked={g.done} onChange={e=>update({goals:plan.goals.map(x=>x.id===g.id?{...x,done:e.target.checked}:x)})}/><span>{g.category} · {g.title}</span></label>)}
    <button className="btn ghost" onClick={()=>onNavigate('Calendar')}>Schedule budget meeting</button>
   </div>
   <div className="family-card"><h3>Our shared message</h3><p>Agree on what to say when extended family asks about returning home.</p><textarea value={plan.familyMessage} onChange={e=>update({familyMessage:e.target.value})} placeholder="We're working through our family and financial plans together. We'll share an update once we've made a decision."/>
   </div>
  </>}
 </section>
}

import { JSDOM } from 'jsdom'
import { build } from 'esbuild'
import { createApp } from '../server/app.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const origin='http://127.0.0.1:3000', dir=mkdtempSync(join(tmpdir(),'family-ui-'))
const service=await createApp({databasePath:join(dir,'app.sqlite'),baseURL:origin,secret:'test-only-ui-integration-long-random-secret'})
const server=service.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`
const bundled=await build({entryPoints:['src/main.jsx'],absWorkingDir:process.cwd(),bundle:true,write:false,format:'iife',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'},jsx:'automatic'})
const errors=[], windows=[]
function client(id){const dom=new JSDOM('<div id="root"></div>',{url:origin,runScripts:'dangerously',pretendToBeVisual:true});const w=dom.window;windows.push(w);w.structuredClone=structuredClone;w.confirm=()=>true;w.addEventListener('error',e=>errors.push(e.message));w.fetch=async(path,options={})=>{const res=await fetch(base+path,{...options,headers:{...options.headers,origin,'x-forwarded-for':`203.0.113.${id}`,cookie:dom.cookieJar.getCookieStringSync(origin)}});for(const c of res.headers.getSetCookie())dom.cookieJar.setCookieSync(c,origin);return res};w.eval(bundled.outputFiles[0].text);return w}
const sleep=()=>new Promise(r=>setTimeout(r,100))
async function until(fn){for(let i=0;i<50;i++){if(fn())return;await sleep()}throw new Error('Timed out waiting for UI')}
function findButton(w,text){return [...w.document.querySelectorAll('button')].find(b=>b.textContent.trim()===text)}
async function click(w,text){await until(()=>findButton(w,text));const b=findButton(w,text);assert(!b.disabled,`Disabled ${text}`);b.click();await sleep()}
function fill(w,label,value){const l=[...w.document.querySelectorAll('label')].find(x=>([...x.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim()===label || x.querySelector('span')?.textContent===label));assert(l,`Missing label ${label}`);const el=l.querySelector('input,select,textarea');const proto=el.tagName==='SELECT'?w.HTMLSelectElement:el.tagName==='TEXTAREA'?w.HTMLTextAreaElement:w.HTMLInputElement;Object.getOwnPropertyDescriptor(proto.prototype,'value').set.call(el,value);el.dispatchEvent(new w.Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}))}
async function submit(w){const form=w.document.querySelector('.family-dialog form')||w.document.querySelector('.family-card form')||w.document.querySelector('form');assert(form);form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await sleep()}
try {
 const owner=client(20);await sleep();await click(owner,'Family');await until(()=>findButton(owner,'Create an account'));await click(owner,'Create an account');fill(owner,'Your name','Owner');fill(owner,'Email','owner-ui@example.com');fill(owner,'Password','family-test-passphrase!');await submit(owner);await until(()=>findButton(owner,'Create household'));await submit(owner);await until(()=>findButton(owner,'Create invitation link'));
 await click(owner,'Create invitation link');await until(()=>owner.document.querySelector('input[readonly]'));const link=owner.document.querySelector('input[readonly]').value;
 await click(owner,'Date nights');await click(owner,'Make this our plan →');fill(owner,'Date-night name','Our coffee date');fill(owner,'Date','2026-11-14');fill(owner,'Childcare plan','Arrange with family');fill(owner,'Status','Planned');await submit(owner);await until(()=>owner.document.body.textContent.includes('Family is up to date'));
 const partner=client(21);partner.history.replaceState(null,'','/#invite='+link.split('#invite=')[1]);await click(partner,'Family');await until(()=>findButton(partner,'Create an account'));await click(partner,'Create an account');fill(partner,'Your name','Partner');fill(partner,'Email','partner-ui@example.com');fill(partner,'Password','family-test-passphrase!');await submit(partner);await until(()=>findButton(partner,'Accept family invitation'));await click(partner,'Accept family invitation');await until(()=>partner.document.body.textContent.includes('Bring your existing budget'));
 await click(partner,'Date nights');assert(partner.document.body.textContent.includes('Our coffee date'));
 await click(partner,'Groceries');fill(partner,'Item','Bread');fill(partner,'Quantity','2 loaves');await submit(partner);await until(()=>partner.document.body.textContent.includes('Family is up to date'));
 owner.dispatchEvent(new owner.Event('focus'));await sleep();await click(owner,'Groceries');await until(()=>owner.document.body.textContent.includes('2 loaves'));
 await click(owner,'Meals');fill(owner,'What are we making?','Chicken and rice');fill(owner,'Ingredients (one per line)','Chicken\nRice');await submit(owner);await click(owner,'Add ingredients to groceries');await click(owner,'Groceries');assert(owner.document.body.textContent.includes('Chicken'));assert(owner.document.body.textContent.includes('Rice'));
 await click(owner,'Paychecks');await click(owner,'+ Add bill');fill(owner,'Bill name','Electric');fill(owner,'Due date','2026-11-16');fill(owner,'Amount ($)','80');await submit(owner);fill(owner,'Next payday','2026-11-20');fill(owner,'Money available now ($)','400');await sleep();assert(owner.document.body.textContent.includes('$320.00'));
 await click(owner,'Calendar');fill(owner,'Month','2026-11');await sleep();assert(owner.document.body.textContent.includes('Our coffee date'));assert(owner.document.body.textContent.includes('Electric'));
 await until(()=>owner.document.body.textContent.includes('Family is up to date'));
 console.log('PASS: two separate browser DOMs signed up, joined by invitation, shared date plans and grocery updates, meals-to-groceries, paycheck math, calendar links; no real API calls.')
 assert.deepEqual(errors,[])
} finally {for(const w of windows)w.close();await new Promise(r=>server.close(r));service.close();rmSync(dir,{recursive:true,force:true})}

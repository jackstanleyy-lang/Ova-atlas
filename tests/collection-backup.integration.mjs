import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {JSDOM,VirtualConsole} from 'jsdom';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(fn){for(let i=0;i<400;i++){if(fn())return;await tick();}throw Error('Timed out waiting for backup UI');}
async function screen(){
 const factory=new IDBFactory(),urls=new Map(),errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));let sequence=0;
 const dom=new JSDOM(html,{url:'https://example.test/Ova-atlas/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
  w.indexedDB=factory;w.IDBKeyRange=IDBKeyRange;w.Blob=Blob;w.File=File;w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;
  Object.defineProperty(w,'crypto',{value:webcrypto});w.fetch=async()=>{throw Error('Unexpected network request');};
  w.URL.createObjectURL=blob=>{const url=`blob:https://example.test/${++sequence}`;urls.set(url,blob);return url;};w.URL.revokeObjectURL=url=>urls.delete(url);
  w.HTMLCanvasElement.prototype.getContext=()=>({clearRect(){},save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},fill(){},arc(){},rect(){},ellipse(){},fillRect(){},drawImage(){},getImageData(){return {data:new Uint8ClampedArray(4)}}});
  w.Image=class{constructor(){this.naturalWidth=64;this.naturalHeight=64;}set src(value){this._src=value;queueMicrotask(()=>this.onload?.());}get src(){return this._src;}};
  w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};w.confirm=()=>false;
  w.addEventListener('error',e=>errors.push(e.message));w.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
 }});
 const w=dom.window,d=w.document;await tick();
 async function connection(){return await new Promise((resolve,reject)=>{const q=factory.open('ova-atlas-6',5);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});}
 async function read(store='images'){const db=await connection();try{return await new Promise((resolve,reject)=>{const q=db.transaction(store).objectStore(store).getAll();q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});}finally{db.close();}}
 async function put(rows,store='images'){const db=await connection();try{await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');for(const row of rows)tx.objectStore(store).put(row);tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error);});}finally{db.close();}}
 async function choose(blob){const input=d.querySelector('#backup-input');Object.defineProperty(input,'files',{configurable:true,value:[new File([blob],'test.ova-collection')]});input.dispatchEvent(new w.Event('change'));}
 async function review(blob){await choose(blob);await until(()=>d.querySelector('#backup-restore-dialog').open||d.querySelector('#backup-status').textContent.startsWith('Nothing restored:'));}
 async function confirm(){d.querySelector('#backup-restore-confirm').click();await until(()=>!d.querySelector('#backup-restore-confirm').disabled);}
 return {w,d,urls,errors,read,put,choose,review,confirm,close(){assert.deepEqual(errors,[]);dom.window.close();}};
}
function records(){
 const original=new Blob(['source bytes'],{type:'image/jpeg'}),parent=new Blob(['accepted bytes'],{type:'image/png'});
 return [
  {id:'original',created:1,name:'Original',blob:original,seriesId:'',tags:{hairColor:'brunette'}},
  {id:'parent',created:2,name:'Accepted',blob:parent,original,base:original,seriesId:'original',revisionStatus:'accepted'},
  {id:'child',created:3,name:'Child',blob:new Blob(['child bytes'],{type:'image/png'}),original,base:parent,seriesId:'original',parentRevisionId:'parent',prompt:'Only local change'},
  {id:'unrelated',created:4,name:'Separate source',blob:new Blob(['separate bytes'],{type:'image/webp'}),seriesId:''}
 ];
}
async function makeFile(s){return (await s.w.OVA_COLLECTION_BACKUP.create(records())).file;}
async function sentinels(s){for(const store of ['archive','privateCatalog','drafts'])await s.put([{id:'sentinel',note:store+' untouched'}],store);}
async function assertSentinels(s){for(const store of ['archive','privateCatalog','drafts'])assert.equal((await s.read(store))[0].note,store+' untouched');}

test('backup UI exports the entire Collection despite filters and preserves all file roles',async()=>{
 const s=await screen();try{
  await s.put(records());await sentinels(s);s.d.querySelector('[data-tab="gallery"]').click();
  const search=s.d.querySelector('#gallery-search');search.value='matches nothing';search.dispatchEvent(new s.w.Event('input'));
  s.d.querySelector('#backup-export').click();await until(()=>!s.d.querySelector('#backup-download').hidden);
  const output=s.urls.get(s.d.querySelector('#backup-download').href),verified=await s.w.OVA_COLLECTION_BACKUP.verify(output);
  assert.equal(verified.rows.length,4);assert.equal(verified.assetCount,4);assert.equal(await verified.rows.find(r=>r.id==='child').base.text(),'accepted bytes');
  assert.equal(await verified.rows.find(r=>r.id==='child').original.text(),'source bytes');assert.equal((await s.read()).length,4);await assertSentinels(s);
 }finally{s.close();}
});

test('restore UI previews before writing, preserves complete lineage and skips repeat imports',async()=>{
 const s=await screen();try{
  await sentinels(s);const file=await makeFile(s);await s.review(file);assert.equal((await s.read()).length,0);assert.match(s.d.querySelector('#backup-restore-summary').textContent,/4 will be added/);
  await s.confirm();assert.match(s.d.querySelector('#backup-status').textContent,/Restore complete: 4 added/);
  const restored=await s.read(),child=restored.find(r=>r.id==='child');assert.equal(child.parentRevisionId,'parent');assert.equal(child.seriesId,'original');assert.equal(await child.original.text(),'source bytes');assert.equal(await child.base.text(),'accepted bytes');
  await s.review(file);assert.match(s.d.querySelector('#backup-restore-summary').textContent,/0 will be added; 4 are already present/);await s.confirm();assert.equal((await s.read()).length,4);await assertSentinels(s);
 }finally{s.close();}
});

test('changed local accepted takes survive restore beside an intact isolated snapshot',async()=>{
 const s=await screen();try{
  const rows=records(),file=await makeFile(s);rows[1]={...rows[1],name:'Local accepted update',blob:new Blob(['local current'],{type:'image/png'})};await s.put(rows);
  await s.review(file);await s.confirm();const all=await s.read();assert.equal(all.length,8);assert.equal(await all.find(r=>r.id==='parent').blob.text(),'local current');
  const imported=all.filter(r=>r.id.startsWith('restored-')),child=imported.find(r=>r.name==='Child'),parent=imported.find(r=>r.name==='Accepted'),root=imported.find(r=>r.name==='Original');
  assert.equal(child.parentRevisionId,parent.id);assert.equal(child.seriesId,root.id);assert.equal(await parent.blob.text(),'accepted bytes');
  await s.review(file);await s.confirm();assert.equal((await s.read()).length,8);
 }finally{s.close();}
});

test('corrupt backup files never open a restore dialog or change stored images',async()=>{
 const s=await screen();try{
  await s.put(records());const file=await makeFile(s),bytes=new Uint8Array(await file.arrayBuffer());bytes[bytes.length-1]^=1;
  await s.review(new Blob([bytes]));assert.equal(s.d.querySelector('#backup-restore-dialog').open,false);assert.match(s.d.querySelector('#backup-status').textContent,/image checksum failed/);assert.equal((await s.read()).length,4);
 }finally{s.close();}
});

test('cancelling backup verification writes no Collection records',async()=>{
 const s=await screen();try{
  const file=await makeFile(s);await s.choose(file);s.d.querySelector('#backup-stop').click();await until(()=>!s.d.querySelector('#backup-open').disabled);
  assert.equal(s.d.querySelector('#backup-restore-dialog').open,false);assert.equal((await s.read()).length,0);
 }finally{s.close();}
});

test('a mid-restore storage failure rolls back all new records and permits a clean retry',async()=>{
 const s=await screen(),realAdd=IDBObjectStore.prototype.add;try{
  await sentinels(s);await s.review(await makeFile(s));let writes=0;
  IDBObjectStore.prototype.add=function(...args){if(++writes===2)throw new DOMException('Simulated full storage','QuotaExceededError');return realAdd.apply(this,args);};
  await s.confirm();IDBObjectStore.prototype.add=realAdd;
  assert.match(s.d.querySelector('#backup-status').textContent,/Nothing restored/);assert.equal((await s.read()).length,0,'the first enqueued image must roll back too');await assertSentinels(s);
  await s.confirm();assert.equal((await s.read()).length,4);assert.match(s.d.querySelector('#backup-status').textContent,/Restore complete/);
 }finally{IDBObjectStore.prototype.add=realAdd;s.close();}
});

test('a Collection change after preview requires a new review instead of overwriting it',async()=>{
 const s=await screen();try{
  await s.review(await makeFile(s));await s.put([{...records()[0],name:'New local original'}]);await s.confirm();
  assert.match(s.d.querySelector('#backup-status').textContent,/Collection changed/);assert.equal((await s.read()).length,1);assert.equal(s.d.querySelector('#backup-restore-dialog').open,true);
  await s.confirm();const all=await s.read();assert.equal(all.length,5);assert.equal(all.find(r=>r.id==='original').name,'New local original');
 }finally{s.close();}
});

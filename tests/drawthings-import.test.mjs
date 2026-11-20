// Draw Things importer checks. Every project, JPEG and history record here is
// synthetic and generated at test time; no real artwork or user files are used.
// These run in Node with an in-memory IndexedDB (and jsdom for the Collection
// UI); they do not prove behaviour in iPhone Safari or with every real project.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {webcrypto,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {JSDOM,VirtualConsole} from 'jsdom';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
import {parseLocalDrawThingsProject,saveLocalDrawThingsCandidate,verifyLocalDrawThingsCandidate,mountLocalDrawThingsImporter,QA_HOLD}
  from '../drawthings_local_import.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const concat=parts=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let o=0;for(const p of parts){out.set(p,o);o+=p.length;}return out;};
const u16=n=>Uint8Array.of(n>>8&255,n&255);
const seg=(marker,body)=>concat([Uint8Array.of(255,marker),u16(body.length+2),body]);
function entropy(length,seed){ // pseudo-random scan bytes with JPEG byte stuffing (FF -> FF00)
  const out=[];let x=seed*2654435761>>>0;
  while(out.length<length){x=(x*1103515245+12345)>>>0;const b=x>>>16&255;out.push(b);if(b===255)out.push(0);}
  return Uint8Array.from(out);
}
/** A structurally valid (not visually meaningful) baseline JPEG byte stream. */
function jpeg({width,height,seed=1,scanBytes=256,exifThumbnail=false}){
  const parts=[Uint8Array.of(255,216)];
  if(exifThumbnail){
    const thumb=concat([Uint8Array.of(255,216),seg(0xC0,Uint8Array.of(8,0,8,0,8,1,1,0x11,0)),
      seg(0xDA,Uint8Array.of(1,1,0,0,63,0)),entropy(40,seed+99),Uint8Array.of(255,217)]);
    parts.push(seg(0xE1,concat([new TextEncoder().encode('Exif\0\0MM\0*'),new Uint8Array(12),thumb])));
  }
  parts.push(seg(0xDB,new Uint8Array(65)));
  parts.push(seg(0xC0,Uint8Array.of(8,height>>8,height&255,width>>8,width&255,3,1,0x22,0,2,0x11,1,3,0x11,1)));
  parts.push(seg(0xDA,Uint8Array.of(3,1,0,2,0x11,3,0x11,0,63,0)),entropy(scanBytes,seed),Uint8Array.of(255,217));
  return concat(parts);
}
/** Minimal FlatBuffer table using the Draw Things history field slots the importer reads. */
function history(fields){
  const max=Math.max(...Object.keys(fields).map(Number)),vtLen=4+2*(max+1),T=4+vtLen;
  const data=[],strings=[];let tableLen=4;const offsets=new Array(max+1).fill(0);
  for(const [k,[type,value]] of Object.entries(fields)){
    const size={u8:1,u32:4,i32:4,f32:4,f64:8,i64:8,str:4}[type],b=new Uint8Array(size),v=new DataView(b.buffer);
    offsets[k]=tableLen;
    if(type==='u8')v.setUint8(0,value);else if(type==='u32')v.setUint32(0,value,true);else if(type==='i32')v.setInt32(0,value,true);
    else if(type==='f32')v.setFloat32(0,value,true);else if(type==='f64')v.setFloat64(0,value,true);else if(type==='i64')v.setBigInt64(0,BigInt(value),true);
    else strings.push({at:tableLen,text:new TextEncoder().encode(value)});
    data.push(b);tableLen+=size;
  }
  const out=new Uint8Array(T+tableLen+strings.reduce((n,s)=>n+4+s.text.length,0)),v=new DataView(out.buffer);
  v.setUint32(0,T,true);v.setUint16(4,vtLen,true);v.setUint16(6,tableLen,true);
  offsets.forEach((o,i)=>v.setUint16(8+i*2,o,true));v.setInt32(T,T-4,true);
  let o=T+4;for(const b of data){out.set(b,o);o+=b.length;}
  for(const s of strings){v.setUint32(T+s.at,o-(T+s.at),true);v.setUint32(o,s.text.length,true);out.set(s.text,o+4);o+=4+s.text.length;}
  return out;
}
const wrap=bytes=>concat([Uint8Array.of(12,0,0,0,8,0,12,0,4,0,8,0),bytes,Uint8Array.of(0,0,0,0)]);
const SOURCE=2,RESULT=1;
/** frames: [{canvas,version,reason,previewId,jpeg,prompt?}] */
function project(frames,{wal=false,pageSize=4096}={}){
  const dir=mkdtempSync(join(tmpdir(),'ova-dt-')),file=join(dir,'synthetic.sqlite3');
  try{
    const db=new DatabaseSync(file);
    db.exec(`PRAGMA page_size=${pageSize};`);
    if(wal)db.exec('PRAGMA journal_mode=WAL;');
    db.exec('CREATE TABLE tensorhistorynode (rowid INTEGER PRIMARY KEY ASC, __pk0 INTEGER NOT NULL, __pk1 INTEGER NOT NULL, p BLOB, UNIQUE(__pk0,__pk1));'+
            'CREATE TABLE thumbnailhistorynode (rowid INTEGER PRIMARY KEY ASC, __pk0 INTEGER NOT NULL, p BLOB, UNIQUE(__pk0));');
    const t=db.prepare('INSERT INTO tensorhistorynode (__pk0,__pk1,p) VALUES (?,?,?)'),th=db.prepare('INSERT INTO thumbnailhistorynode (__pk0,p) VALUES (?,?)');
    for(const f of frames){
      t.run(f.canvas,f.version,history({1:['i64',f.version],4:['u32',1234+f.version],5:['u32',30],6:['f32',f.guidance??4.5],7:['f32',0.6],
        8:['str','synthetic_model.ckpt'],11:['i64',1700000000000000+f.version],41:['i64',f.previewId],98:['str',f.prompt||'synthetic prompt'],108:['i32',f.reason]}));
      if(f.jpeg)th.run(f.previewId,wrap(f.jpeg));
    }
    db.close();
    return new Uint8Array(readFileSync(file));
  }finally{rmSync(dir,{recursive:true,force:true});}
}
const pair=(o={})=>[
  {canvas:0,version:1,reason:SOURCE,previewId:11,jpeg:jpeg({width:640,height:960,seed:1,...o.source})},
  {canvas:0,version:2,reason:RESULT,previewId:12,jpeg:jpeg({width:640,height:960,seed:2,...o.result})}
];
async function openDB(factory){
  return await new Promise((resolve,reject)=>{const q=factory.open('ova-atlas-6',5);
    q.onupgradeneeded=()=>{for(const s of ['images','pending','drafts','archive','privateCatalog'])q.result.createObjectStore(s,{keyPath:'id'});};
    q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
}
async function all(factory){const db=await openDB(factory);try{return await new Promise((res,rej)=>{const q=db.transaction('images').objectStore('images').getAll();q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});}finally{db.close();}}

test('parses source/result history frames with exact bytes, frame dimensions, hashes and lineage',async()=>{
  const frames=[...pair(),{canvas:1,version:1,reason:RESULT,previewId:21,jpeg:jpeg({width:512,height:512,seed:3,scanBytes:150000})}];
  const p=await parseLocalDrawThingsProject(project(frames));
  assert.equal(p.entries.length,3);assert.deepEqual(p.warnings,[]);
  assert.equal(p.nativeImageBytesProvenFullResolution,false,'history JPEGs are never presented as native full resolution');
  const [src,out,orphan]=p.entries;
  assert.equal(src.role,'source');assert.equal(out.role,'result');assert.equal(out.source,src);
  assert.equal(orphan.source,null,'a result with no earlier source frame in its canvas gets no invented provenance');
  for(const [entry,frame] of [[src,frames[0]],[out,frames[1]],[orphan,frames[2]]]){
    const bytes=new Uint8Array(await entry.blob.arrayBuffer());
    assert.deepEqual(bytes,frame.jpeg,'extracted JPEG is byte-identical (overflow pages included)');
    assert.equal(entry.sha256,sha(frame.jpeg));assert.equal(entry.sourceImageIsHistoryPreview,true);
    assert.match(entry.representation,/not verified native full resolution/);
  }
  assert.deepEqual([out.width,out.height],[640,960]);assert.equal(orphan.blob.size,frames[2].jpeg.length);
  assert.equal(out.metadata.prompt,'synthetic prompt');assert.equal(out.metadata.modelFilename,'synthetic_model.ckpt');
});

test('JPEGs carrying an EXIF thumbnail import whole, with dimensions from the main frame',async()=>{
  const frames=pair({source:{exifThumbnail:true},result:{exifThumbnail:true}});
  const p=await parseLocalDrawThingsProject(project(frames));
  assert.deepEqual(p.warnings,[]);assert.equal(p.entries.length,2);
  for(const [i,e] of p.entries.entries()){
    assert.deepEqual([e.width,e.height],[640,960],'never the 8x8 thumbnail');
    assert.deepEqual(new Uint8Array(await e.blob.arrayBuffer()),frames[i].jpeg,'not cut short at the thumbnail end marker');
  }
});

test('non-finite generation numbers are stored as null so PR #7 backups still accept the record',async()=>{
  const frames=pair();frames[1].guidance=NaN;
  const out=(await parseLocalDrawThingsProject(project(frames))).entries[1];
  assert.equal(out.metadata.guidanceScale,null);
});

test('WAL-mode, non-SQLite, truncated and oversized inputs fail closed with a clear error',async()=>{
  await assert.rejects(parseLocalDrawThingsProject(project(pair(),{wal:true})),/WAL\/journal-dependent database not supported; close the project/);
  await assert.rejects(parseLocalDrawThingsProject(new Uint8Array(4096)),/not a SQLite 3 database/);
  const good=project(pair());
  await assert.rejects(parseLocalDrawThingsProject(good.slice(0,good.length-100)),/Draw Things project:/);
  await assert.rejects(parseLocalDrawThingsProject('not bytes'),/ArrayBuffer or Uint8Array/);
  const noThumbs=pair();for(const f of noThumbs)delete f.jpeg;
  await assert.rejects(parseLocalDrawThingsProject(project(noThumbs)),/no decodable Draw Things history images/);
  const tiny=pair({source:{width:8,height:8}});
  const p=await parseLocalDrawThingsProject(project(tiny));
  assert.equal(p.entries.length,1);assert.match(p.warnings[0].error,/bad JPEG dimensions/);
});

test('randomly corrupted projects only ever produce an importer error, never a crash or a bogus image',async()=>{
  const good=project(pair());let x=7;
  for(let i=0;i<300;i++){
    const bad=good.slice();
    for(let j=0;j<4;j++){x=(x*1103515245+12345)>>>0;bad[x%bad.length]^=1+(x>>>8)%255;}
    try{
      const p=await parseLocalDrawThingsProject(bad);
      for(const e of p.entries)assert.equal(e.sha256,sha(new Uint8Array(await e.blob.arrayBuffer())));
    }catch(error){assert.match(error.message,/^Draw Things project: /,`iteration ${i}: ${error.stack}`);}
  }
});

test('saving creates a source and a QA HOLD result in one transaction, never accepted, and survives reopening',async()=>{
  const factory=new IDBFactory(),dbOpen=()=>openDB(factory);
  const p=await parseLocalDrawThingsProject(project(pair())),result=p.entries[1];
  const r=await saveLocalDrawThingsCandidate({project:p,result,seriesId:'W001',dbOpen});
  assert.equal(r.rowsCreated,2);assert.equal(r.qualityHold,true);
  const rows=await all(factory),src=rows.find(x=>x.id===r.sourceId),out=rows.find(x=>x.id===r.resultId);
  assert.equal(rows.length,2);
  assert.equal(out.revisionStatus,QA_HOLD);assert.equal(out.qualityHold,true);assert.notEqual(out.revisionStatus,'accepted');
  assert.equal(out.parentRevisionId,src.id);assert.equal(out.sourceRecordId,src.id);assert.equal(out.sourceSha256,src.sha256);
  assert.equal(sha(new Uint8Array(await out.original.arrayBuffer())),src.sha256,'the source is preserved as the original');
  // A second save of the same frame is idempotent.
  assert.equal((await saveLocalDrawThingsCandidate({project:p,result,seriesId:'W001',dbOpen})).rowsCreated,0);
  // "Reopening": a fresh connection to the same database still verifies bytes, lineage and hold.
  const v=await verifyLocalDrawThingsCandidate({project:p,result,seriesId:'W001',dbOpen});
  assert.equal(v.verified,true);assert.equal((await all(factory)).length,2);
});

test('an accepted decision is never overwritten and conflicting stored bytes are refused',async()=>{
  const factory=new IDBFactory(),dbOpen=()=>openDB(factory);
  const p=await parseLocalDrawThingsProject(project(pair())),result=p.entries[1];
  const r=await saveLocalDrawThingsCandidate({project:p,result,dbOpen});
  const db=await dbOpen();const row=(await all(factory)).find(x=>x.id===r.resultId);
  await new Promise((res,rej)=>{const tx=db.transaction('images','readwrite');tx.objectStore('images').put({...row,revisionStatus:'accepted'});tx.oncomplete=res;tx.onerror=rej;});db.close();
  assert.equal((await saveLocalDrawThingsCandidate({project:p,result,dbOpen})).rowsCreated,0);
  assert.equal((await all(factory)).find(x=>x.id===r.resultId).revisionStatus,'accepted','person-made decision preserved');
  const db2=await dbOpen();
  await new Promise((res,rej)=>{const tx=db2.transaction('images','readwrite');tx.objectStore('images').put({...row,blob:new Blob(['other'],{type:'image/jpeg'})});tx.oncomplete=res;tx.onerror=rej;});db2.close();
  await assert.rejects(saveLocalDrawThingsCandidate({project:p,result,dbOpen}),/corrupted or conflicting|does not match/);
});

test('a storage failure during save rolls back both records',async()=>{
  const factory=new IDBFactory(),dbOpen=()=>openDB(factory),realAdd=IDBObjectStore.prototype.add;
  const p=await parseLocalDrawThingsProject(project(pair()));let writes=0;
  IDBObjectStore.prototype.add=function(...a){if(++writes===2)throw new DOMException('Simulated full storage','QuotaExceededError');return realAdd.apply(this,a);};
  try{await assert.rejects(saveLocalDrawThingsCandidate({project:p,result:p.entries[1],dbOpen}));}
  finally{IDBObjectStore.prototype.add=realAdd;}
  assert.equal((await all(factory)).length,0,'the first enqueued record rolled back too');
  assert.equal((await saveLocalDrawThingsCandidate({project:p,result:p.entries[1],dbOpen})).rowsCreated,2,'clean retry succeeds');
});

test('a result without a source frame, or a tampered blob, is refused before anything is written',async()=>{
  const factory=new IDBFactory(),dbOpen=()=>openDB(factory);
  const p=await parseLocalDrawThingsProject(project([pair()[1]]));
  await assert.rejects(saveLocalDrawThingsCandidate({project:p,result:p.entries[0],dbOpen}),/ambiguous provenance/);
  const q=await parseLocalDrawThingsProject(project(pair()));q.entries[1].blob=new Blob(['tampered']);
  await assert.rejects(saveLocalDrawThingsCandidate({project:q,result:q.entries[1],dbOpen}),/pixels changed/);
  assert.equal((await all(factory)).length,0);
});

test('imported frames appear in the Collection UI and survive a PR #7 backup and restore',async()=>{
  const factory=new IDBFactory(),errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://example.test/Ova-atlas/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
    w.indexedDB=factory;w.IDBKeyRange=IDBKeyRange;w.Blob=Blob;w.File=File;w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;
    Object.defineProperty(w,'crypto',{value:webcrypto});w.fetch=async()=>{throw Error('Unexpected network request');};
    let n=0;w.URL.createObjectURL=()=>`blob:https://example.test/${++n}`;w.URL.revokeObjectURL=()=>{};
    w.HTMLCanvasElement.prototype.getContext=()=>({clearRect(){},save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},fill(){},arc(){},rect(){},ellipse(){},fillRect(){},drawImage(){},getImageData(){return {data:new Uint8ClampedArray(4)}}});
    w.Image=class{constructor(){this.naturalWidth=64;this.naturalHeight=64;}set src(v){this._src=v;queueMicrotask(()=>this.onload?.());}get src(){return this._src;}};
    w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};w.confirm=()=>false;
    w.addEventListener('error',e=>errors.push(e.message));w.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
  }});
  const w=dom.window,d=w.document,tick=()=>new Promise(r=>setTimeout(r,5));
  try{
    // jsdom does not execute module scripts, so the module is mounted directly into this document.
    globalThis.document=d;
    try{assert.equal(mountLocalDrawThingsImporter(),true);assert.equal(mountLocalDrawThingsImporter(),false,'mounted once');}
    finally{delete globalThis.document;}
    const panel=d.querySelector('#gallery-tab > #atlas-rc8-local-dt');
    assert.ok(panel,'importer panel sits in the Collection tab');assert.match(panel.textContent,/no backend upload/);
    const dbOpen=()=>openDB(factory),p=await parseLocalDrawThingsProject(project(pair()));
    const r=await saveLocalDrawThingsCandidate({project:p,result:p.entries[1],dbOpen});
    d.querySelector('[data-tab="gallery"]').click();
    for(let i=0;i<400&&!d.querySelector('#gallery-grid').textContent.includes(QA_HOLD);i++)await tick();
    assert.match(d.querySelector('#gallery-grid').textContent,/QA HOLD/,'the held result is listed in Collection');
    const backup=await w.OVA_COLLECTION_BACKUP.create(await all(factory));
    const verified=await w.OVA_COLLECTION_BACKUP.verify(backup.file);
    const restoredFactory=new IDBFactory(),restoredOpen=()=>openDB(restoredFactory);
    const plan=await w.OVA_COLLECTION_BACKUP.planRestore(verified,[]);assert.equal(plan.rows.length,2);assert.equal(plan.isolated,false);
    const db=await restoredOpen();
    await new Promise((res,rej)=>{const tx=db.transaction('images','readwrite');for(const row of plan.rows)tx.objectStore('images').add(row);tx.oncomplete=res;tx.onerror=rej;});db.close();
    const v=await verifyLocalDrawThingsCandidate({project:p,result:p.entries[1],dbOpen:restoredOpen});
    assert.equal(v.verified,true);assert.equal(v.resultId,r.resultId);
    assert.deepEqual(errors,[]);
  }finally{w.close();}
});

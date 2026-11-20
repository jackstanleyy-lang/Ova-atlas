// RC9 Draw Things generation checks.
// EVERYTHING HERE IS A MOCK: Draw Things itself is simulated (a fake `canvas` /
// `pipeline` / `filesystem` script host, a fake HTTP server and fake fetch), all
// images are synthetic PNGs generated at test time, and IndexedDB is in-memory.
// Passing these tests does NOT prove real Draw Things generation on any device.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import {deflateSync} from 'node:zlib';
import {webcrypto,createHash} from 'node:crypto';
import {JSDOM,VirtualConsole} from 'jsdom';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {PRESETS,QA_HOLD,imageInfo,drawThingsFrame,buildGenerationRequest,buildDrawThingsScript,verifyReturnedImage,generateViaHttp,
  savePendingJob,listPendingJobs,discardPendingJob,saveGeneratedCandidate,mountDrawThingsGeneration} from '../drawthings_generation.mjs';
import {createBridge} from '../tools/drawthings_http_bridge.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^c>>>1:c>>>1;return c>>>0;});
const crc=b=>{let c=~0;for(const x of b)c=crcTable[(c^x)&255]^c>>>8;return ~c>>>0;};
const chunk=(type,data)=>{const t=Buffer.from(type),len=Buffer.alloc(4),c=Buffer.alloc(4);len.writeUInt32BE(data.length);c.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([len,t,data,c]);};
/** A real, decodable synthetic PNG (gray gradient plus seed noise). */
function png(width,height,seed=1){
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=0;
  const raw=Buffer.alloc((width+1)*height);let x=seed;
  for(let y=0;y<height;y++)for(let i=0;i<width;i++){x=(x*1103515245+12345)>>>0;raw[y*(width+1)+1+i]=(i+y+(x>>>24))&255;}
  return new Uint8Array(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
}
const blob=(b,type='image/png')=>new Blob([b],{type});
async function openDB(factory){
  return await new Promise((resolve,reject)=>{const q=factory.open('ova-atlas-6',5);
    q.onupgradeneeded=()=>{for(const s of ['images','pending','drafts','archive','privateCatalog'])q.result.createObjectStore(s,{keyPath:'id'});};
    q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
}
async function all(factory,store='images'){const db=await openDB(factory);try{return await new Promise((res,rej)=>{const q=db.transaction(store).objectStore(store).getAll();q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});}finally{db.close();}}
const ORIGINAL=png(512,768,1),BASE=png(512,768,2),MASK=png(512,768,3),RESULT=png(512,768,4);
const ctx=(o={})=>({original:blob(ORIGINAL),editBase:blob(BASE),mask:blob(MASK),prompt:'repair the sleeve',seriesId:'W001',
  parentRevisionId:'rev-1',sourceRecordId:'src-1',baseIsAcceptedRevision:true,preset:'FIX',...o});

/** MOCK Draw Things script host implementing only the documented API surface the script uses. */
function mockDrawThings({result=RESULT}={}){
  const calls=[],pictures=new Map();let canvasImage=null,mask=null;
  const configuration={width:512,height:512,strength:1,seed:0,steps:20,guidanceScale:4.5,model:'user_selected.ckpt',maskBlur:0,batchCount:3,batchSize:1};
  const sandbox={
    console:{log:m=>calls.push(['log',m])},
    pipeline:{get configuration(){return {...configuration};},run(args){calls.push(['run',args]);if(!canvasImage)throw Error('no image');canvasImage=result;}},
    filesystem:{pictures:{path:'/var/mobile/DrawThings/Pictures'}},
    canvas:{clear(){calls.push(['clear']);canvasImage=null;},updateCanvasSize(c){calls.push(['updateCanvasSize',c.width,c.height]);},
      set canvasZoom(z){calls.push(['zoom',z]);},moveCanvas(x,y){calls.push(['move',x,y]);},
      loadImageSrc(src){calls.push(['loadImageSrc',src.slice(0,30)]);canvasImage=Buffer.from(src.split(',')[1],'base64');sandbox.__loaded=canvasImage;},
      loadMaskFromSrc(src){calls.push(['loadMaskFromSrc']);mask=Buffer.from(src.split(',')[1],'base64');sandbox.__mask=mask;},
      get currentMask(){return mask?{handle:7}:null;},
      saveImage(file,visible){calls.push(['saveImage',file,visible]);pictures.set(file,new Uint8Array(canvasImage));}}
  };
  return {sandbox,calls,pictures,run:script=>vm.runInNewContext(`(function(){${script}\n})()`,sandbox)};
}

test('presets map to real Draw Things configuration values and recorded seeds',async()=>{
  assert.deepEqual(Object.keys(PRESETS),['FIDELITY','FIX','CONTINUE','RETRY','MORE_FIDELITY']);
  for(const p of Object.values(PRESETS)){assert.ok(p.strength>0&&p.strength<=1);assert.ok(Number.isFinite(p.maskBlur));assert.doesNotMatch(p.note,/identity lock(?!\.)/i);}
  const r=await buildGenerationRequest(ctx());
  assert.equal(r.settings.strength,0.7);assert.equal(r.settings.maskBlur,8);assert.equal(r.settings.preserveOriginalAfterInpaint,true);
  assert.match(r.settings.prompt,/^repair the sleeve, seamless repair/);assert.ok(Number.isInteger(r.settings.seed));
  assert.equal(r.settings.width,512);assert.equal(r.frame.exact,true);assert.equal(r.originalSha256,sha(ORIGINAL));assert.equal(r.maskSha256,sha(MASK));
  assert.equal((await buildGenerationRequest(ctx({seed:42}))).settings.seed,42);
  assert.notEqual((await buildGenerationRequest(ctx({preset:'RETRY',seed:42}))).settings.seed,42,'RETRY always draws a new seed');
  assert.equal((await buildGenerationRequest(ctx({preset:'MORE_FIDELITY',mask:null}))).settings.strength,0.2);
});

test('requests fail closed on missing mask, unaccepted base, bad input and HTTP limits',async()=>{
  const bad=async(o,re)=>assert.rejects(buildGenerationRequest(ctx(o)),re);
  await bad({mask:null},/needs a painted mask/);
  await bad({preset:'CONTINUE',baseIsAcceptedRevision:false},/accepted revision/);
  await bad({preset:'RETRY',parentRevisionId:null},/accepted revision/);
  await bad({editBase:blob(new TextEncoder().encode('not an image at all, just text bytes'))},/Not a PNG, JPEG or WebP/);
  await bad({mask:blob(png(256,256,3))},/Mask size/);
  await bad({seriesId:'../x'},/series ID/);
  await bad({strength:2},/Strength/);
  await bad({model:'../../etc/passwd'},/model file/i);
  await bad({preset:'FIX',transport:'drawthings-http'},/ignores masks/);
  await bad({preset:'FIDELITY',mask:null,transport:'drawthings-http',editBase:blob(png(500,700,2))},/divisible by 64/);
  await bad({transport:'cloud'},/Unsupported generation transport/);
  assert.deepEqual(drawThingsFrame(1000,1500),{width:960,height:1472,exact:false});
  assert.throws(()=>drawThingsFrame(100,900),/at least 128/);
});

test('MOCK Draw Things host: generated script loads exact bytes, mask, settings and saves the job file',async()=>{
  const r=await buildGenerationRequest(ctx({prompt:'quote " back\\slash */ </script> \u2028 line',seed:99,model:'sd_v1.5_f16.ckpt',steps:30}));
  const script=await buildDrawThingsScript(r);
  new vm.Script(`(function(){${script}\n})`);
  assert.match(script,/^\/\/@api-1\.0\n/);
  assert.doesNotMatch(script,/fetch|XMLHttpRequest|https?:\/\//,'script has no network access');
  const dt=mockDrawThings();dt.run(script);
  assert.deepEqual(dt.calls.filter(c=>c[0]!=='log').map(c=>c[0]),['clear','updateCanvasSize','zoom','move','loadImageSrc','loadMaskFromSrc','run','saveImage']);
  assert.equal(sha(dt.sandbox.__loaded),sha(BASE),'edit base reaches Draw Things byte-for-byte');
  assert.equal(sha(dt.sandbox.__mask),sha(MASK),'mask reaches Draw Things byte-for-byte');
  const run=dt.calls.find(c=>c[0]==='run')[1];
  assert.equal(run.prompt,r.settings.prompt,'prompt survives quoting');assert.deepEqual(run.mask,{handle:7});
  assert.equal(run.configuration.strength,0.7);assert.equal(run.configuration.seed,99);assert.equal(run.configuration.model,'sd_v1.5_f16.ckpt');
  assert.equal(run.configuration.steps,30);assert.equal(run.configuration.guidanceScale,4.5,'unset values keep the Draw Things setting');
  assert.equal(run.configuration.batchCount,1);
  const save=dt.calls.find(c=>c[0]==='saveImage');assert.equal(save[1],`/var/mobile/DrawThings/Pictures/${r.outputName}`);
  // Without a mask, no mask is loaded and none is passed.
  const r2=await buildGenerationRequest(ctx({preset:'FIDELITY',mask:null}));const dt2=mockDrawThings();dt2.run(await buildDrawThingsScript(r2));
  assert.equal(dt2.calls.some(c=>c[0]==='loadMaskFromSrc'),false);assert.equal(dt2.calls.find(c=>c[0]==='run')[1].mask,null);
  // A changed edit base after preparation is refused.
  await assert.rejects(buildDrawThingsScript({...r,editBase:blob(RESULT)}),/changed/);
});

test('returned files must be real, new images named for the job; size differences are recorded, not fixed',async()=>{
  const r=await buildGenerationRequest(ctx());
  const named=(b,name=r.outputName)=>new File([b],name,{type:'image/png'});
  await assert.rejects(verifyReturnedImage(r,named(BASE)),/identical to the source/);
  await assert.rejects(verifyReturnedImage(r,named(ORIGINAL)),/identical to the source/);
  await assert.rejects(verifyReturnedImage(r,named(RESULT,'IMG_0001.png')),/not named for job/);
  await assert.rejects(verifyReturnedImage(r,named(RESULT.slice(0,20))),/truncated|Not a PNG/);
  await assert.rejects(verifyReturnedImage(r,named(new Uint8Array(64))),/Not a PNG/);
  const ok=await verifyReturnedImage(r,named(RESULT));assert.equal(ok.sha256,sha(RESULT));assert.equal(ok.matchesSourceSize,true);
  const forced=await verifyReturnedImage(r,named(RESULT,'IMG_0001.png'),{allowNameMismatch:true});assert.equal(forced.nameMatchesJob,false);
  const smaller=await verifyReturnedImage(r,named(png(448,768,9)));assert.equal(smaller.matchesSourceSize,false);assert.equal(smaller.info.width,448);
  assert.deepEqual(imageInfo(Uint8Array.from([255,216,255,192,0,17,8,1,0,2,0,3,1,34,0,2,17,1,3,17,1,255,217,0])),{type:'image/jpeg',width:512,height:256});
});

test('MOCK HTTP transport: loopback only, no masks, verified bytes, visible errors and cancellation',async()=>{
  const r=await buildGenerationRequest(ctx({preset:'FIDELITY',mask:null,transport:'drawthings-http',seed:7}));
  const seen=[];
  const okFetch=async(url,init)=>{seen.push([url,JSON.parse(init.body)]);return {ok:true,status:200,json:async()=>({images:[Buffer.from(RESULT).toString('base64')]})};};
  const out=await generateViaHttp(r,{fetchImpl:okFetch});
  assert.equal(out.sha256,sha(RESULT));assert.equal(seen[0][0],'http://127.0.0.1:7861/sdapi/v1/img2img');
  const body=seen[0][1];assert.deepEqual(Object.keys(body).sort(),['batch_count','height','init_images','negative_prompt','prompt','seed','strength','width']);
  assert.equal(sha(Buffer.from(body.init_images[0],'base64')),sha(BASE));assert.equal('mask' in body,false);
  let called=false;const spy=async()=>{called=true;return {ok:true,json:async()=>({})};};
  await assert.rejects(generateViaHttp(r,{baseUrl:'http://192.168.1.20:7860',fetchImpl:spy}),/this computer/);
  await assert.rejects(generateViaHttp(r,{baseUrl:'https://example.com',fetchImpl:spy}),/this computer/);
  await assert.rejects(generateViaHttp({...r,mask:blob(MASK)},{fetchImpl:spy}),/ignores masks/);assert.equal(called,false,'nothing sent');
  await assert.rejects(generateViaHttp(r,{fetchImpl:async()=>({ok:false,status:422,json:async()=>({error:'Unrecognized keys: [\"mask\"]'})})}),/refused the request \(422\)/);
  await assert.rejects(generateViaHttp(r,{fetchImpl:async()=>({ok:true,json:async()=>({images:[]})})}),/no image/);
  await assert.rejects(generateViaHttp(r,{fetchImpl:async()=>({ok:true,json:async()=>({images:['%%%']})})}),/malformed/);
  await assert.rejects(generateViaHttp(r,{fetchImpl:async()=>({ok:true,json:async()=>({images:[Buffer.from('hello world, not image data at all').toString('base64')]})})}),/Not a PNG/);
  await assert.rejects(generateViaHttp(r,{fetchImpl:async()=>({ok:true,json:async()=>({images:[Buffer.from(BASE).toString('base64')]})})}),/identical to the source/);
  await assert.rejects(generateViaHttp(r,{fetchImpl:async()=>{throw new TypeError('Failed to fetch');}}),/Could not reach/);
  const ac=new AbortController();
  const hanging=(url,{signal})=>new Promise((_,rej)=>{const stop=()=>rej(new DOMException('aborted','AbortError'));if(signal.aborted)stop();else signal.addEventListener('abort',stop);});
  // Cancelling both before and during the request.
  await assert.rejects(generateViaHttp(r,{fetchImpl:hanging,signal:AbortSignal.abort()}),/cancelled/);
  const p=generateViaHttp(r,{fetchImpl:hanging,signal:ac.signal});ac.abort();await assert.rejects(p,/cancelled/);
  await assert.rejects(generateViaHttp(r,{fetchImpl:hanging,timeoutMs:20}),/did not answer in time/);
});

test('MOCK end to end: script result saves in QA HOLD with lineage and mask, survives reopening, and is idempotent',async()=>{
  const factory=new IDBFactory(),dbOpen=()=>openDB(factory);
  const r=await buildGenerationRequest(ctx());
  await savePendingJob(r,{dbOpen});
  // "Reload": a new connection still has the job and its exact source bytes.
  const [job]=await listPendingJobs({dbOpen});
  assert.equal(job.jobId,r.jobId);assert.equal(job.status,'sent');assert.equal(sha(new Uint8Array(await job.editBase.arrayBuffer())),sha(BASE));
  const dt=mockDrawThings();dt.run(await buildDrawThingsScript(job));
  const file=new File([dt.pictures.get(`/var/mobile/DrawThings/Pictures/${job.outputName}`)],job.outputName,{type:'image/png'});
  const returned=await verifyReturnedImage(job,file);
  const saved=await saveGeneratedCandidate(job,returned,{dbOpen});
  assert.equal(saved.created,true);assert.equal(saved.revisionStatus,QA_HOLD);
  const rows=await all(factory),out=rows.find(x=>x.id===saved.id),mask=rows.find(x=>x.id===saved.maskId);
  assert.equal(rows.length,2);
  assert.equal(out.revisionStatus,QA_HOLD);assert.equal(out.qualityHold,true);assert.equal(out.parentRevisionId,'rev-1');assert.equal(out.sourceRecordId,'src-1');assert.equal(out.seriesId,'W001');
  assert.equal(sha(new Uint8Array(await out.original.arrayBuffer())),sha(ORIGINAL),'original bytes untouched');
  assert.equal(sha(new Uint8Array(await out.base.arrayBuffer())),sha(BASE),'edit base bytes untouched');
  assert.equal(sha(new Uint8Array(await out.blob.arrayBuffer())),sha(RESULT));
  assert.equal(out.generation.requestedSettings.seed,job.settings.seed);assert.equal(out.generation.maskSha256,sha(MASK));assert.equal(out.generation.transport,'drawthings-script');
  assert.equal(mask.revisionStatus,'mask');assert.equal(sha(new Uint8Array(await mask.blob.arrayBuffer())),sha(MASK));
  assert.equal((await saveGeneratedCandidate(job,returned,{dbOpen})).created,false,'same bytes twice: no duplicate');
  // A second, different generation of the same job is kept as its own candidate.
  const again=await saveGeneratedCandidate(job,await verifyReturnedImage(job,new File([png(512,768,5)],job.outputName,{type:'image/png'})),{dbOpen});
  assert.notEqual(again.id,saved.id);assert.equal((await all(factory)).length,3);
  assert.equal((await listPendingJobs({dbOpen}))[0].status,'imported');
  await discardPendingJob(job.jobId,{dbOpen});
  assert.equal((await listPendingJobs({dbOpen})).length,0);assert.equal((await all(factory)).length,3,'discarding a job never touches Collection');
});

test('storage failures and changed source bytes save nothing',async()=>{
  const r=await buildGenerationRequest(ctx());const returned=await verifyReturnedImage(r,new File([RESULT],r.outputName,{type:'image/png'}));
  await assert.rejects(saveGeneratedCandidate(r,returned,{dbOpen:async()=>{throw Error('QuotaExceededError');}}),/Quota/);
  const factory=new IDBFactory(),dbOpen=()=>openDB(factory);
  await assert.rejects(saveGeneratedCandidate({...r,original:blob(RESULT)},returned,{dbOpen}),/Original bytes changed/);
  await assert.rejects(saveGeneratedCandidate(r,{...returned,sha256:'0'.repeat(64)},{dbOpen}),/changed before saving/);
  assert.equal((await all(factory)).length,0);
  // A conflicting record under the same ID is never overwritten.
  const db=await dbOpen();const id=`gen-${r.jobId}-${returned.sha256.slice(0,16)}`;
  await new Promise((res,rej)=>{const tx=db.transaction('images','readwrite');tx.objectStore('images').add({id,sha256:'f'.repeat(64),blob:blob(BASE)});tx.oncomplete=res;tx.onerror=rej;});db.close();
  await assert.rejects(saveGeneratedCandidate(r,returned,{dbOpen}),/nothing overwritten/);
});

test('generated results appear in Collection, the panel mounts in Studio, and PR #7 backup round-trips them',async()=>{
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
    assert.equal(typeof w.OVA_STUDIO?.snapshot,'function','Studio exposes a read-only snapshot');
    assert.equal(await w.OVA_STUDIO.snapshot(),null,'no image open: nothing to generate from');
    const dbOpen=()=>openDB(factory);
    globalThis.document=d;
    try{
      assert.equal(mountDrawThingsGeneration({studio:async()=>null,dbOpen}),true);assert.equal(mountDrawThingsGeneration({dbOpen}),false,'mounted once');
      const panel=d.getElementById('atlas-rc9-generate');assert.ok(panel.nextElementSibling.id==='resume-panel','panel sits in Studio');
      assert.equal(panel.querySelectorAll('[data-preset]').length,5);
      panel.querySelector('#rc9-generate').click();
      for(let i=0;i<50&&!panel.querySelector('#rc9-status').textContent;i++)await tick();
      assert.match(panel.querySelector('#rc9-status').textContent,/Open an image in Studio first/,'errors are shown, not swallowed');
    }finally{delete globalThis.document;}
    const r=await buildGenerationRequest(ctx());
    const saved=await saveGeneratedCandidate(r,await verifyReturnedImage(r,new File([RESULT],r.outputName,{type:'image/png'})),{dbOpen});
    d.querySelector('[data-tab="gallery"]').click();
    for(let i=0;i<400&&!d.querySelector('#gallery-grid').textContent.includes(QA_HOLD);i++)await tick();
    assert.match(d.querySelector('#gallery-grid').textContent,/QA HOLD/,'the held result is listed in Collection');
    const backup=await w.OVA_COLLECTION_BACKUP.create(await all(factory));
    const verified=await w.OVA_COLLECTION_BACKUP.verify(backup.file);
    const plan=await w.OVA_COLLECTION_BACKUP.planRestore(verified,[]);assert.equal(plan.rows.length,2);
    const restored=plan.rows.find(x=>x.id===saved.id);
    assert.equal(restored.revisionStatus,QA_HOLD);assert.equal(restored.generation.jobId,r.jobId);assert.equal(restored.generation.requestedSettings.seed,r.settings.seed);
    assert.equal(sha(new Uint8Array(await restored.original.arrayBuffer())),sha(ORIGINAL));
    assert.deepEqual(errors,[]);
  }finally{w.close();}
});

test('MOCK bridge: forwards only to local Draw Things, only for the Atlas origin, with CORS',async()=>{
  assert.throws(()=>createBridge({upstream:'http://192.168.1.5:7860'}),/this computer/);
  const upstream=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({images:['eA=='],echo:JSON.parse(b||'{}')}));});});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const bridge=createBridge({upstream:`http://127.0.0.1:${upstream.address().port}`,origins:['https://jackstanleyy-lang.github.io']});
  await new Promise(r=>bridge.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${bridge.address().port}`;
  try{
    const pre=await fetch(`${base}/sdapi/v1/img2img`,{method:'OPTIONS',headers:{Origin:'https://jackstanleyy-lang.github.io'}});
    assert.equal(pre.status,204);assert.equal(pre.headers.get('access-control-allow-origin'),'https://jackstanleyy-lang.github.io');assert.equal(pre.headers.get('access-control-allow-private-network'),'true');
    const ok=await fetch(`${base}/sdapi/v1/img2img`,{method:'POST',headers:{Origin:'https://jackstanleyy-lang.github.io','Content-Type':'application/json'},body:JSON.stringify({prompt:'x'})});
    assert.equal(ok.status,200);assert.equal((await ok.json()).echo.prompt,'x');
    assert.equal((await fetch(`${base}/sdapi/v1/img2img`,{method:'POST',headers:{Origin:'https://evil.example'},body:'{}'})).status,403);
    assert.equal((await fetch(`${base}/sdapi/v1/txt2img`,{method:'POST',headers:{Origin:'https://jackstanleyy-lang.github.io'},body:'{}'})).status,404);
  }finally{bridge.close();upstream.close();}
});

test('local Draw Things generation needs no confirmation checkbox; the locked cloud button still does',async()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  // The legacy paid/cloud path keeps every gate: server unlock, free-only lock, prompt and the checkbox.
  assert.match(html,/\$\('generate'\)\.disabled=!\(cloudAllowed && ready && \$\('prompt'\)\.value\.trim\(\) && \$\('attest'\)\.checked\)/);
  assert.match(html,/if \(!cloudAllowed \|\| FREE_ONLY\) \{ toast\('Cloud generation is locked/);
  assert.match(html,/data-free-only="true"/i);
  const generator=readFileSync(new URL('../drawthings_generation.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(generator,/attest/i,'local generation does not read the checkbox');
  const factory=new IDBFactory(),dbOpen=()=>openDB(factory);
  const dom=new JSDOM('<!doctype html><body><div id="resume-panel"></div></body>',{url:'https://example.test/Ova-atlas/'});
  globalThis.document=dom.window.document;
  try{
    // MOCK Studio context with no checkbox field at all: the script hand-off still proceeds.
    assert.equal(mountDrawThingsGeneration({studio:async()=>ctx(),dbOpen}),true);
    const d=dom.window.document;d.getElementById('rc9-generate').click();
    const status=()=>d.getElementById('rc9-status').textContent;
    for(let i=0;i<200&&!/Script (downloaded|shared)/.test(status());i++)await new Promise(r=>setTimeout(r,5));
    assert.match(status(),/Script downloaded/);
    const [job]=await listPendingJobs({dbOpen});assert.equal(job.status,'sent');assert.equal(job.preset,'FIX');
    assert.equal((await all(factory)).length,0,'nothing enters Collection until a verified result is imported');
  }finally{delete globalThis.document;dom.window.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const html=readFileSync(join(root,'index.html'),'utf8');
const sw=readFileSync(join(root,'sw.js'),'utf8');
const manifest=JSON.parse(readFileSync(join(root,'manifest.webmanifest'),'utf8'));
const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].filter(m=>!m[0].includes('type="application/json"')).map(m=>m[1]);
const pureScript=scripts.find(s=>s.includes('root.OVA_LOCAL_PREVIEW'));

test('app is self-contained, static, and syntactically valid',()=>{
  assert.equal(scripts.length,4,'archive starter, preview helpers, app logic and worker registration remain present');
  assert.ok(pureScript);
  for(const [i,script] of scripts.entries()) new vm.Script(script,{filename:`inline-${i}.js`});
  new vm.Script(sw,{filename:'sw.js'});
  assert.doesNotMatch(html,/<script[^>]+src\s*=/i,'no external scripts');
  assert.doesNotMatch(html,/<link[^>]+href=["']https?:/i,'no external styles/assets');
  assert.ok(existsSync(join(root,'.nojekyll')));
  assert.match(html,/data-free-only="true"/i);
});

test('Home Screen manifest and icon files are internally consistent',()=>{
  assert.equal(manifest.display,'standalone');
  assert.equal(manifest.start_url,'./');
  assert.equal(manifest.scope,'./');
  assert.equal(manifest.id,'./');
  assert.ok(manifest.icons.length>=2);
  for(const icon of manifest.icons){
    assert.ok(icon.src.startsWith('./icons/'));
    const buf=readFileSync(join(root,icon.src));
    assert.equal(buf.subarray(1,4).toString(),'PNG');
    const [width,height]=[buf.readUInt32BE(16),buf.readUInt32BE(20)];
    const [declaredWidth,declaredHeight]=icon.sizes.split('x').map(Number);
    assert.deepEqual([width,height],[declaredWidth,declaredHeight]);
  }
  assert.ok(existsSync(join(root,'icons/atlas-180.png')));
});

test('iPhone camera and ordinary Photos/Files use one safe input flow',()=>{
  assert.match(html,/<input[^>]*id="file-input"[^>]*accept="image\/\*"/);
  assert.match(html,/<input[^>]*id="camera-input"[^>]*accept="image\/\*"[^>]*capture="environment"/);
  assert.match(html,/id="intro-camera"/);
  assert.match(html,/id="intro-camera"/);
  assert.match(html,/\$\('camera-input'\)\.onchange=e=>\{void chooseFile\(e\.target\.files\?\.\[0\]\)/);
  assert.match(html,/if\(!skipDraftSave && state\.width/,'photo replacement retains unsaved edit confirmation');
});

test('four local masked color variants preserve every unmasked byte',()=>{
  const context={globalThis:{},Uint8ClampedArray,Math};
  vm.runInNewContext(pureScript,context);
  const api=context.globalThis.OVA_LOCAL_PREVIEW;
  assert.equal(api.names.length,4);
  const src=new Uint8ClampedArray([11,22,33,255, 100,120,140,255, 200,150,99,128]);
  const mask=new Uint8ClampedArray([0,0,0,255, 255,0,0,255, 0,0,0,0]);
  for(let variation=0;variation<4;variation++){
    const pixels=api.applyMaskedPreview(src,mask,variation);
    assert.deepEqual(Array.from(pixels.slice(0,4)),Array.from(src.slice(0,4)));
    assert.deepEqual(Array.from(pixels.slice(8,12)),Array.from(src.slice(8,12)));
    assert.equal(pixels[7],255,'alpha channel is preserved');
    assert.notDeepEqual(Array.from(pixels.slice(4,7)),Array.from(src.slice(4,7)));
  }
  assert.deepEqual(Array.from(src),[11,22,33,255,100,120,140,255,200,150,99,128],'source unchanged');
});

test('service worker caches only the named app shell and never intercepts user data',async()=>{
  const handlers={};
  const scope='https://example.org/Ova-atlas/';
  const cacheRows=new Map(), removed=[];
  const cache={
    async addAll(paths){for(const p of paths)cacheRows.set(new URL(p,scope).href,{ok:true,clone(){return this;}});},
    async put(k,v){cacheRows.set(k,v);}
  };
  const caches={async open(){return cache;},async keys(){return ['ova-atlas-shell-v8.4','ova-atlas-shell-v8.5','ova-atlas-shell-v8.6','ova-atlas-shell-v8.7'];},async delete(k){removed.push(k);return true;},async match(url){return cacheRows.get(typeof url==='string'?url:url.url);}};
  const worker={registration:{scope},location:{origin:'https://example.org'},clients:{async claim(){}},async skipWaiting(){},addEventListener(name,handler){handlers[name]=handler;}};
  vm.runInNewContext(sw,{self:worker,caches,URL,fetch:async()=>({ok:true,clone(){return this;}})});
  let installation;handlers.install({waitUntil(p){installation=p;}});await installation;
  assert.equal(cacheRows.size,5,'only listed shell assets are cached');
  let activation;handlers.activate({waitUntil(p){activation=p;}});await activation;
  assert.deepEqual(removed,['ova-atlas-shell-v8.4','ova-atlas-shell-v8.5','ova-atlas-shell-v8.6','ova-atlas-shell-v8.7']);
  const fire=(url,{method='GET',mode='cors'}={})=>{
    let responded=false,promise;
    handlers.fetch({request:{url,method,mode},respondWith(p){responded=true;promise=p;}});
    return {responded,promise};
  };
  for(const [url,opts] of [
    ['https://example.org/Ova-atlas/api/edit',{method:'POST'}],
    ['https://example.org/Ova-atlas/api/edit',{}],
    ['https://example.org/Ova-atlas/personal-photo.png',{}],
    ['https://example.org/Ova-atlas/index.html?token=secret',{mode:'navigate'}],
    ['https://private.example/secret.png',{}],
    ['blob:https://example.org/deadbeef',{}]
  ])assert.equal(fire(url,opts).responded,false,`must not intercept ${url}`);
  assert.equal(fire(`${scope}index.html`,{mode:'navigate'}).responded,true);
  assert.equal(fire(`${scope}icons/atlas-192.png`).responded,true);
});


test('manual visual labels preserve legacy entries and reject unexpected attributes',()=>{
  const context={globalThis:{},Uint8ClampedArray,Math};
  vm.runInNewContext(pureScript,context);
  const {FIELDS,safeTags,safeTitle}=context.globalThis.OVA_COLLECTION_TOOLS;
  assert.deepEqual(Object.keys(FIELDS),['hairColor','hairStyle','skinTone','proportions','outfit','pose','angle']);
  const tags=safeTags({hairColor:'brunette',outfit:'latex',pose:'reclining',skinTone:'nonexistent',identity:'guessed'});
  assert.equal(tags.hairColor,'brunette');assert.equal(tags.outfit,'latex');assert.equal(tags.pose,'reclining');
  assert.equal(tags.skinTone,'');assert.equal('identity' in tags,false,'unexpected sensitive fields are not accepted');
  assert.equal(safeTags(null).outfit,'','older saved images without labels remain compatible');
  assert.equal(safeTitle('  Dawn \n  scene  '),'Dawn scene');
});

test('collection filtering combines facets, text search, series and date order',()=>{
  const context={globalThis:{},Uint8ClampedArray,Math};
  vm.runInNewContext(pureScript,context);
  const {filterRows}=context.globalThis.OVA_COLLECTION_TOOLS;
  const rows=[
    {id:'a',created:1,name:'Sunset',seriesId:'same',tags:{hairColor:'blonde',pose:'seated'}},
    {id:'b',created:4,name:'Night portrait',seriesId:'same',tags:{hairColor:'brunette',outfit:'latex'}},
    {id:'c',created:3,name:'Night portrait',seriesId:'other',tags:{hairColor:'brunette',outfit:'latex'}},
    {id:'d',created:2,name:'Untitled',seriesId:'older'}
  ];
  assert.deepEqual(Array.from(filterRows(rows,{}),r=>r.id),['b','c','d','a']);
  assert.deepEqual(Array.from(filterRows(rows,{search:'night',tags:{hairColor:'brunette'},seriesId:'same'}),r=>r.id),['b']);
  assert.deepEqual(Array.from(filterRows(rows,{tags:{outfit:'latex'},sort:'oldest'}),r=>r.id),['c','b']);
  assert.deepEqual(Array.from(filterRows(rows,{tags:{hairColor:'redhead'}}),r=>r.id),[]);
  assert.deepEqual(Array.from(filterRows(rows,{untagged:true}),r=>r.id),['d']);
  assert.equal(rows.length,4,'filtering does not change source collection');
});

test('gallery loads saved images in pages and stores metadata without touching pixels',()=>{
  assert.match(html,/const PAGE_SIZE=48/);
  assert.match(html,/function dbMetadataAll\(\)/);
  assert.match(html,/store\.get\(id\)/);
  assert.match(html,/const updated=\{\.\.\.row,name,tags\}/,'only updates labels and name, keeping original blobs');
  assert.match(html,/galleryNeedsRender=true/,'do not invalidate viewer download while editing labels');
  for(const id of ['gallery-search','gallery-facets','gallery-more','meta-title','organize-fields','save-metadata'])
    assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/Manual labels|Labels are manual/);
});


test('bulk photo intake keeps file blobs local with a conservative per-batch limit',()=>{
  assert.match(html,/<input[^>]+id="gallery-import-input"[^>]+accept="image\/\*"[^>]+multiple/);
  assert.match(html,/chosen\.slice\(0,20\)/);
  assert.match(html,/file\.size>25\*1024\*1024/);
  assert.match(html,/blob:file/,'original image Blob is retained without re-encoding');
  assert.doesNotMatch(html,/fetch\(['"]https?:\/\//,'no hardcoded remote upload endpoint');
});


test('unified candidate retains Mask Lab, local Archive, imported vault isolation and privacy erasure',()=>{
 for(const id of ['archive-tab','archive-import','vault-file','mask-overlay','export-mask','privacy-dialog','erase-local-data'])
   assert.match(html,new RegExp(`id="${id}"`));
 for(const shape of ['brush','rect','ellipse'])assert.match(html,new RegExp(`data-mask-tool="${shape}"`));
 assert.match(html,/OVA_STARTER_ARCHIVE=\[\]/,'do not bundle private archive images');
 assert.match(html,/"thumbnails":\{\},"originals":\{\}/,'do not embed private catalog contents');
 assert.match(html,/\['images','pending','drafts','archive','privateCatalog'\]/,'privacy wipe covers all local stores');
 assert.match(html,/indexedDB\.open\('ova-atlas-6',5\)/,'do not downgrade existing Atlas IndexedDB schema');
});


test('SHA-256 identifies identical bytes without conflating different files or entries',async()=>{
 const context={globalThis:{crypto:webcrypto},Uint8ClampedArray,Math,Uint8Array,Map,Array,Blob};
 vm.runInNewContext(pureScript,context);
 const api=context.globalThis.OVA_COLLECTION_TOOLS;
 const a=new Blob(['abc']); const b=new Blob(['abcd']);
 const h=await api.sha256Hex(a);const other=await api.sha256Hex(b);
 assert.equal(h,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
 assert.equal(await api.sha256Hex(new Blob(['abc'])),h);
 assert.notEqual(h,other);
 const rows=[{id:'original',sha256:h},{id:'copy-1',sha256:h},{id:'different',sha256:other},{id:'legacy',name:'no hash'},{id:'copy-2',sha256:h}];
 const groups=api.exactCopyGroups(rows);
 assert.deepEqual(JSON.parse(JSON.stringify(groups)),[['original','copy-1','copy-2']]);
 assert.deepEqual(rows.map(x=>x.id),['original','copy-1','different','legacy','copy-2'],'review does not remove or mutate rows');
});

test('duplicate import and on-demand scan are local, review-only, and preserve image IDs',()=>{
 for(const id of ['duplicate-scan','duplicate-cancel','duplicate-review','duplicate-status'])assert.match(html,new RegExp(`id="${id}"`));
 assert.match(html,/sha256=await COLLECTION\.sha256Hex\(file\)/);
 assert.match(html,/sha256 && known\.has\(sha256\)/);
 assert.match(html,/await dbPut\(\{\.\.\.row,sha256:digest\}\)/,'legacy scan only adds hash to unchanged row');
 assert.match(html,/duplicateOnlyIds=new Set\(groups\.flat\(\)\)/);
 assert.match(html,/duplicateReviewActive=true/);
 assert.match(html,/const filtered=COLLECTION\.filterRows\(rows,currentGalleryCriteria\(\)\)\.filter/);
 assert.doesNotMatch(html,/delete\(.*sha256/i,'fingerprint lookup never deletes originals');
});

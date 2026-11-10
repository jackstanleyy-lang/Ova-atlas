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

function visualAPI(){
 const context={globalThis:{crypto:webcrypto},Uint8ClampedArray,Math,Uint8Array,Map,Array,Blob};
 vm.runInNewContext(pureScript,context);return context.globalThis.OVA_VISUAL_CATALOG;
}
function syntheticVisualCatalog(count=150){
 const records=Array.from({length:count},(_,i)=>({key:`T${i}`,file_id:`file_synthetic_${String(i).padStart(8,'0')}`,filename:`test-${i}.png`,library_path:`/Lost 90s Anime OVA/Test/test-${i}.png`,collection:'Test',inspection_status:'visually_reviewed',media_kind:i<21?'photographic_reference':i<33?'illustration_source_sheet':'illustration',hair:i%2?'brunette bob':'blonde long hair',outfit:'blue jacket',pose:'standing',camera:'rear three quarter',setting:'test studio',interaction:'solo',tags:[i%2?'brunette':'blonde','rear-view'],series_group:i<2?'suggested-scene':null,possible_visual_duplicate_with:null,original_to_edit_lineage:'unverified'}));
 return {schema_version:'ova94-curation-1.1',created_date:'2026-11-09',records,inspection_summary:{total_records:count,possible_visual_duplicate_pairs_review_only:count>1?[['T0','T1']]:[]}};
}
test('visual catalog imports 150 independent records without constructing public image URLs',()=>{
 const raw=syntheticVisualCatalog(),before=JSON.stringify(raw),index=visualAPI().fromVisualReview(raw);
 assert.equal(index.items.length,150);assert.equal(new Set(index.items.map(x=>x[0])).size,150);
 assert.equal(index.items.filter(x=>x[5]==='illustration').length,117);
 assert.equal(index.items.filter(x=>x[5]==='photographic_reference').length,21);
 assert.equal(index.items.filter(x=>x[5]==='illustration_source_sheet').length,12);
 assert.ok(index.items.every(x=>x[3]===''),'private paths are never turned into public URLs');
 assert.equal(Object.keys(index.thumbnails).length,0);assert.equal(Object.keys(index.originals).length,0);
 assert.equal(index.families.length,0,'scene suggestions never become confirmed character identities');
 assert.equal(JSON.stringify(raw),before,'import does not alter the canonical source');
});
test('visual catalog rejects ambiguous identifiers, malformed paths, counts and dangling suggestions',()=>{
 const api=visualAPI();
 for(const mutate of [
  x=>x.records[1].file_id=x.records[0].file_id,
  x=>x.records[1].key=x.records[0].key,
  x=>x.records[1].library_path='/Lost 90s Anime OVA/../secret.png',
  x=>x.records[1].filename='mismatched.png',
  x=>x.records[0].tags='not an array',
  x=>x.records[0].media_kind='guessed identity',
  x=>x.inspection_summary.total_records=999,
  x=>x.inspection_summary.possible_visual_duplicate_pairs_review_only=[['T0','missing']],
  x=>x.records[0].possible_visual_duplicate_with='missing',
  x=>x.schema_version='unknown'
 ]){const raw=syntheticVisualCatalog(3);mutate(raw);assert.throws(()=>api.fromVisualReview(raw));}
});
test('visual similarity suggestions preserve both records and never assert byte identity',()=>{
 const raw=syntheticVisualCatalog(3),index=visualAPI().fromVisualReview(raw);
 assert.equal(index.visualReview.pairs.length,1);assert.equal(index.items.length,3);
 assert.ok(index.visualReview.records.every(r=>r.original_to_edit_lineage==='unverified'));
 assert.ok(index.visualReview.records.every(r=>!('sha256' in r)));
 assert.notEqual(index.items[0][0],index.items[1][0]);
});
test('visual browsing combines recorded tags, scene suggestions and descriptive search',()=>{
 const api=visualAPI(),rows=api.fromVisualReview(syntheticVisualCatalog(5)).visualReview.records;
 assert.deepEqual(Array.from(rows.filter(r=>api.matches(r,{search:'blue jacket',tag:'brunette',group:'suggested-scene'})),r=>r.key),['T1']);
 assert.equal(rows.filter(r=>api.matches(r,{tag:'not cataloged'})).length,0);
 assert.equal(rows.filter(r=>api.matches(r,{search:'rear three quarter'})).length,5);
});
test('continuing an accepted revision keeps the original, parent and complete series',async()=>{
 const api=visualAPI(),original=new Blob(['original bytes']),edited=new Blob(['accepted edit']);
 const row={id:'revision-two',blob:edited,original,seriesId:'series-one',sourceRecordId:'local-source'};
 const next=api.revisionContext(row);assert.equal(next.image,edited);assert.equal(next.original,original);
 assert.equal(next.seriesId,'series-one');assert.equal(next.parentRevisionId,'revision-two');assert.equal(next.sourceRecordId,'local-source');
 const restart=api.revisionContext(row,true);assert.equal(restart.image,original);assert.equal(restart.parentRevisionId,null);assert.equal(restart.seriesId,'series-one');
 const legacy=api.revisionContext({id:'legacy',blob:original});assert.equal(legacy.original,original);assert.equal(legacy.seriesId,'legacy');
 assert.equal(await original.text(),'original bytes');assert.equal(await edited.text(),'accepted edit');
});
test('known catalog fingerprints block mismatched files without changing any record',()=>{
 const api=visualAPI(),record={sha256:'a'.repeat(64)},before=JSON.stringify(record);
 assert.equal(api.checkLocalMatch(record,'a'.repeat(64)),true);
 assert.throws(()=>api.checkLocalMatch(record,'b'.repeat(64)),/does not match/);
 assert.throws(()=>api.checkLocalMatch(record,''),/does not match/);
 assert.equal(api.checkLocalMatch({},'a'.repeat(64)),false,'unknown fingerprints require explicit user matching');
 assert.equal(JSON.stringify(record),before);
});
test('comparison references distinguish the untouched original, accepted base and current result',async()=>{
 const api=visualAPI(),original=new Blob(['untouched original']),base=new Blob(['accepted input']),output=new Blob(['current result']);
 const refs=api.comparisonReferences({blob:output,original,base,parentRevisionId:'accepted-take'});
 assert.equal(refs.original.blob,original);assert.equal(refs.original.label,'Original reference');
 assert.equal(refs.base.blob,base);assert.equal(refs.base.label,'Accepted edit base');assert.notEqual(refs.base.blob,output);
 assert.deepEqual(Object.keys(api.comparisonReferences({blob:output,original})),['original'],'legacy entries do not invent a missing edit base');
 const source=api.comparisonReferences({blob:original});assert.equal(source.original.blob,original);
 assert.equal(await refs.original.blob.text(),'untouched original');assert.equal(await refs.base.blob.text(),'accepted input');assert.equal(await output.text(),'current result');
});
test('series history preserves branches, excludes unrelated images and identifies missing parents',()=>{
 const api=visualAPI(),rows=[
  {id:'root',seriesId:'',created:1,name:'Source'},
  {id:'accepted',seriesId:'root',created:2,name:'Accepted take',revisionStatus:'accepted'},
  {id:'left',seriesId:'root',created:3,name:'Left branch',parentRevisionId:'accepted'},
  {id:'right',seriesId:'root',created:4,name:'Right branch',parentRevisionId:'accepted'},
  {id:'orphan',seriesId:'root',created:5,name:'Imported take',parentRevisionId:'outside-browser'},
  {id:'unrelated',seriesId:'other',created:6,name:'Accepted take'},
  {id:'legacy',seriesId:'',created:7,name:'Legacy'},
  {id:'other-legacy',seriesId:'',created:8,name:'Legacy'}
 ];
 const before=JSON.stringify(rows),history=api.seriesHistory(rows,rows[2]);
 assert.deepEqual(Array.from(history,x=>x.id),['root','accepted','left','right','orphan']);
 assert.equal(history.find(x=>x.id==='left').parentName,'Accepted take');assert.equal(history.find(x=>x.id==='right').parentName,'Accepted take');
 assert.equal(history.find(x=>x.id==='left').current,true);assert.equal(history.find(x=>x.id==='orphan').parentMissing,true);assert.equal(history.find(x=>x.id==='orphan').parentName,null);
 assert.deepEqual(Array.from(api.seriesHistory(rows,rows[6]),x=>x.id),['legacy'],'blank legacy series are not combined');
 assert.equal(JSON.stringify(rows),before,'history is read-only');
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

/* OVA Atlas RC8 — local-only Draw Things SQLite project import.
 * Pure JS, no network, third-party runtime libraries, eval, remote generation,
 * credentials or repository artwork. This parser is deliberately limited to
 * SQLite rowid tables and the observed Draw Things history format. It fails
 * closed on unfamiliar layouts instead of inventing image provenance.
 */
const MAX_DB = 128 * 1024 * 1024;
const MAX_ENTRY = 32 * 1024 * 1024;
const LIMIT_ROWS = 10000;
const REQUIRED_STORES = ['images', 'pending', 'drafts', 'archive', 'privateCatalog'];
const utf8 = new TextDecoder('utf-8', {fatal: true});
const fail = message => { throw Error(`Draw Things project: ${message}`); };
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const hash = async b => {
  if (!globalThis.crypto?.subtle) fail('HTTPS/localhost required for integrity hashes');
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', b)));
};
const bufferize = input => {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input instanceof Uint8Array) return input;
  fail('input must be an ArrayBuffer or Uint8Array');
};
const makeBlob = bytes => new Blob([bytes], {type:'image/jpeg'});

class SQLiteImageReader {
  constructor(input) {
    this.b=bufferize(input);
    if(this.b.byteLength<512||this.b.byteLength>MAX_DB)fail('file size unsupported');
    if(utf8.decode(this.b.subarray(0,15))!=='SQLite format 3'||this.b[15]!==0)
      fail('not a SQLite 3 database');
    this.view=new DataView(this.b.buffer,this.b.byteOffset,this.b.byteLength);
    const n=this.u16(16);this.pageSize=n===1?65536:n;
    if(this.pageSize<512||this.pageSize>65536||(this.pageSize&(this.pageSize-1))||this.b.length%this.pageSize)
      fail('invalid SQLite page size');
    this.usable=this.pageSize-this.b[20];
    if(this.usable<480)fail('unsupported SQLite reserved space');
    if(this.b[18]!==1||this.b[19]!==1)fail('WAL/journal-dependent database not supported; export a complete project');
    if(this.u32(56)!==1)fail('only UTF-8 SQLite databases are supported');
    this.pageCount=this.b.length/this.pageSize;
    const declared=this.u32(28);
    if(declared&&declared>this.pageCount)fail('database pages are missing');
    this.master=this.rows(1).map(({values})=>values);
  }
  bounds(pos,len=1){if(!Number.isSafeInteger(pos)||!Number.isSafeInteger(len)||pos<0||len<0||pos+len>this.b.length)fail('invalid record or page offset');}
  u16(p){this.bounds(p,2);return this.view.getUint16(p,false);}
  u32(p){this.bounds(p,4);return this.view.getUint32(p,false);}
  page(n){if(!Number.isInteger(n)||n<1||n>this.pageCount)fail('invalid page number');return (n-1)*this.pageSize;}
  varint(p,end=this.b.length){
    let result=0n, i=0;
    for(;i<9;i++){
      if(p+i>=end)fail('truncated varint');
      const byte=this.b[p+i];
      if(i===8){result=(result<<8n)|BigInt(byte);break;}
      result=(result<<7n)|BigInt(byte&127);
      if(!(byte&128))break;
    }
    const v=Number(result);
    if(!Number.isSafeInteger(v))fail('unsupported 64-bit value');
    return [v,p+i+1];
  }
  cellPayload(page,payloadLen,at){
    if(payloadLen<0||payloadLen>MAX_ENTRY)fail('database entry exceeds 32 MiB');
    const max=this.usable-35,min=Math.floor((this.usable-12)*32/255)-23;
    let local=payloadLen<=max?payloadLen:min+(payloadLen-min)%(this.usable-4);
    if(local>max)local=min;
    this.bounds(at,local+(local<payloadLen?4:0));
    if(at+local+(local<payloadLen?4:0)>page+this.pageSize)fail('invalid SQLite leaf payload');
    if(local===payloadLen)return this.b.slice(at,at+local);
    const out=new Uint8Array(payloadLen);out.set(this.b.subarray(at,at+local));
    let written=local,p=this.u32(at+local),hops=0;
    const visited=new Set();
    while(written<payloadLen){
      if(++hops>this.pageCount||visited.has(p))fail('cyclic overflow pages');
      visited.add(p);
      const start=this.page(p);const capacity=Math.min(this.usable-4,payloadLen-written);
      this.bounds(start+4,capacity);
      out.set(this.b.subarray(start+4,start+4+capacity),written);
      written+=capacity;p=this.u32(start);
      if((written===payloadLen&&p!==0)||(written<payloadLen&&p===0))
        fail('truncated or extra SQLite overflow pages');
    }
    return out;
  }
  record(payload){
    const r=new SQLiteRecord(payload);
    return r.read();
  }
  rows(root){
    const collected=[],visited=new Set();
    const walk=(pageNumber,depth)=>{
      if(depth>32||visited.has(pageNumber))fail('invalid SQLite table B-tree');
      visited.add(pageNumber);
      const page=this.page(pageNumber), start=page+(pageNumber===1?100:0);
      const type=this.b[start];
      if(type!==0x05&&type!==0x0d)fail('not a rowid table B-tree');
      const count=this.u16(start+3),header=type===0x05?12:8;
      if(count>this.usable/2||start+header+count*2>page+this.pageSize)fail('invalid B-tree cell count');
      for(let i=0;i<count;i++){
        const at=page+this.u16(start+header+i*2);
        if(at<start+header||at>=page+this.pageSize)fail('bad cell pointer');
        if(type===0x05){
          const child=this.u32(at);const key=this.varint(at+4,page+this.pageSize);
          if(!key)fail('bad interior key');walk(child,depth+1);
        }else{
          let [payloadLen,off]=this.varint(at,page+this.pageSize);
          let [rowid,begin]=this.varint(off,page+this.pageSize);
          const bytes=this.cellPayload(page,payloadLen,begin);
          collected.push({rowid,values:this.record(bytes)});
          if(collected.length>LIMIT_ROWS)fail('more than 10,000 history rows');
        }
      }
      if(type===0x05)walk(this.u32(start+8),depth+1);
    };
    walk(root,0);return collected;
  }
  table(name){
    const m=this.master.find(row=>row[0]==='table'&&row[1]===name);
    if(!m||!Number.isInteger(m[3])||m[3]<1)fail(`required history table ${name} is missing`);
    return this.rows(m[3]);
  }
}
class SQLiteRecord {
  constructor(b){this.b=b;this.v=new DataView(b.buffer,b.byteOffset,b.byteLength);}
  varint(p){let v=0n;for(let i=0;i<9;i++){
    if(p+i>=this.b.length)fail('truncated SQLite record');
    let c=this.b[p+i];v=(v<<BigInt(i===8?8:7))|BigInt(i===8?c:c&127);
    if(!(c&128)||i===8){const n=Number(v);if(!Number.isSafeInteger(n))fail('unsupported 64-bit record');return [n,p+i+1];}
  }fail('bad SQLite serial');}
  read(){
    const [headerSize,head]=this.varint(0);
    if(headerSize<head||headerSize>this.b.length)fail('corrupt SQLite record header');
    const types=[];let at=head;
    while(at<headerSize){const [type,next]=this.varint(at);types.push(type);at=next;if(types.length>256)fail('too many record columns');}
    at=headerSize;
    const values=[];
    for(const s of types){
      if(s===0){values.push(null);continue;}
      if(s===8||s===9){values.push(s-8);continue;}
      let n,kind='number';
      if(s>=12){n=Math.floor((s-12)/2);kind=s%2?'text':'blob';}
      else if(s>=1&&s<=6)n=[0,1,2,3,4,6,8][s];
      else if(s===7)n=8;
      else fail('unsupported record serial type');
      if(n>MAX_ENTRY||at+n>this.b.length)fail('record value exceeds payload');
      if(kind==='blob')values.push(this.b.slice(at,at+n));
      else if(kind==='text'){try{values.push(utf8.decode(this.b.subarray(at,at+n)));}catch{fail('malformed UTF-8 value');}}
      else if(s===7)values.push(this.v.getFloat64(at,false));
      else{
        let x=0n;for(let i=0;i<n;i++)x=(x<<8n)|BigInt(this.b[at+i]);
        if(this.b[at]&0x80)x-=(1n<<BigInt(n*8));
        if(x>BigInt(Number.MAX_SAFE_INTEGER)||x<BigInt(Number.MIN_SAFE_INTEGER))fail('unsafe SQLite record integer');
        values.push(Number(x));
      }
      at+=n;
    }
    if(at!==this.b.length)fail('record length mismatch');
    return values;
  }
}
class HistoryFields {
  constructor(bytes){this.b=bytes;this.v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    if(bytes.length<8)fail('invalid Draw Things history FlatBuffer');
    this.root=this.v.getUint32(0,true);
    this.check(this.root,4);
    this.vt=this.root-this.v.getInt32(this.root,true);this.check(this.vt,4);
    this.vtLen=this.v.getUint16(this.vt,true);
    if(this.vtLen<4||this.vtLen>2048)fail('unsupported Draw Things history format');
    this.check(this.vt,this.vtLen);
  }
  check(p,n){if(p<0||n<0||p+n>this.b.length)fail('bad Draw Things FlatBuffer offsets');}
  field(i){const p=this.vt+4+i*2;if(p+2>this.vt+this.vtLen)return null;
    const n=this.v.getUint16(p,true);return n?this.root+n:null;
  }
  num(i,type){const p=this.field(i);if(p===null)return null;
    const t={u32:[4,'getUint32'],i32:[4,'getInt32'],u8:[1,'getUint8'],f32:[4,'getFloat32'],f64:[8,'getFloat64'],i64:[8,'getBigInt64']}[type];
    this.check(p,t[0]);const v=this.v[t[1]](p,true);
    if(typeof v==='bigint'){const n=Number(v);return Number.isSafeInteger(n)?n:null;}return v;
  }
  str(i){const p=this.field(i);if(p===null)return null;
    this.check(p,4);const rel=this.v.getUint32(p,true),target=p+rel;
    this.check(target,4);const n=this.v.getUint32(target,true);
    if(n>300000)fail('text metadata too long');this.check(target+4,n);
    return utf8.decode(this.b.subarray(target+4,target+4+n));
  }
}
const generation = bytes => {
  const f=new HistoryFields(bytes);const ts=f.num(11,'i64');
  const sec=f.num(107,'f64'),strength=f.num(7,'f32'),guidance=f.num(6,'f32');
  return {historySequence:f.num(1,'i64'),modelFilename:f.str(8),seed:f.num(4,'u32'),steps:f.num(5,'u32'),
    guidanceScale:guidance===null?null:+guidance.toFixed(5),
    rawStoredStrength:strength===null?null:+strength.toFixed(6),
    effectiveUiStrength:null,samplerEnum:f.num(15,'u8'),seedModeEnum:f.num(25,'u8'),
    previewId:f.num(41,'i64'),reasonEnum:f.num(108,'i32'),
    timestampUTC:ts?new Date(Math.round(ts/1000)).toISOString():null,
    generationSeconds:sec===null?null:+sec.toFixed(3),prompt:f.str(98),negativePrompt:f.str(99)};
};
const extractJPEG = wrapper => {
  let start=-1,end=-1;
  for(let i=0;i<wrapper.length-2;i++)if(wrapper[i]===255&&wrapper[i+1]===216&&wrapper[i+2]===255){start=i;break;}
  if(start<0)fail('embedded preview is not JPEG');
  for(let i=start+3;i<wrapper.length-1;i++)if(wrapper[i]===255&&wrapper[i+1]===217){end=i+2;break;}
  if(end<0)fail('truncated embedded JPEG');
  const data=wrapper.slice(start,end);
  // Simple JPEG frame header parser; never trust the dimensions stored elsewhere.
  let pos=2,width=0,height=0;
  while(pos<data.length){
    if(data[pos++]!==255)break;
    let marker;do{marker=data[pos++];}while(marker===255&&pos<data.length);
    if(marker===217||marker===218)break;
    if(marker===1||(marker>=208&&marker<=215))continue;
    if(pos+2>data.length)break;
    const n=(data[pos]<<8)|data[pos+1];
    if(n<2||pos+n>data.length)break;
    if([192,193,194,195,198,199,201,202].includes(marker)&&n>=7){
      height=(data[pos+3]<<8)|data[pos+4];width=(data[pos+5]<<8)|data[pos+6];break;
    }
    pos+=n;
  }
  if(width<16||height<16||width>16000||height>16000)fail('bad JPEG dimensions');
  return {data,width,height};
};

/** Read an exported Draw Things SQLite file completely in the browser, without uploading it. */
export async function parseLocalDrawThingsProject(input){
  const bytes=bufferize(input),db=new SQLiteImageReader(bytes);
  const thumb=new Map(db.table('thumbnailhistorynode').map(r=>[r.values[1],r.values[2]]));
  const rows=db.table('tensorhistorynode').sort((a,b)=>a.values[1]-b.values[1]||a.values[2]-b.values[2]||a.rowid-b.rowid);
  const projectSha256=await hash(bytes);
  const entries=[],warnings=[];
  for(const row of rows){
    const p=row.values[3];if(!(p instanceof Uint8Array))fail('missing Draw Things history payload');
    let m;
    try{m=generation(p);}catch(error){warnings.push({row:row.rowid,error:error.message});continue;}
    const wrapped=thumb.get(m.previewId);
    if(!(wrapped instanceof Uint8Array)){warnings.push({row:row.rowid,error:'history thumbnail missing'});continue;}
    try{
      const {data,width,height}=extractJPEG(wrapped);
      const role=m.reasonEnum===2?'source':m.reasonEnum===1?'result':'unknown';
      entries.push({rowid:row.rowid,canvasIndex:row.values[1],historyVersion:row.values[2],
        previewId:m.previewId,role,metadata:m,sha256:await hash(data),width,height,
        blob:makeBlob(data),sourceImageIsHistoryPreview:true,
        representation:'Draw Things embedded history JPEG (not verified native full resolution)'});
    }catch(error){warnings.push({row:row.rowid,error:error.message});}
  }
  if(!entries.length)fail('no decodable Draw Things history images');
  const lastSource=new Map();
  for(const item of entries){
    if(item.role==='source')lastSource.set(item.canvasIndex,item);
    else if(item.role==='result')item.source=lastSource.get(item.canvasIndex)||null;
  }
  return {projectSha256,projectBytes:bytes.byteLength,entries,warnings,
    nativeImageBytesProvenFullResolution:false,historyRows:rows.length};
}

const validSeries = s => typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s);
const atlasDb = () => new Promise((resolve,reject)=>{
  if(!globalThis.indexedDB)return reject(Error('Atlas IndexedDB unavailable; nothing saved'));
  const q=globalThis.indexedDB.open('ova-atlas-6',5);
  q.onupgradeneeded=()=>{for(const s of REQUIRED_STORES)
    if(!q.result.objectStoreNames.contains(s))q.result.createObjectStore(s,{keyPath:'id'});};
  q.onerror=()=>reject(q.error||Error('Atlas storage failed to open'));
  q.onsuccess=()=>{
    const d=q.result;
    if(REQUIRED_STORES.some(s=>!d.objectStoreNames.contains(s))){d.close();reject(Error('Atlas IndexedDB schema incompatible'));return;}
    resolve(d);
  };
});
const txRead = (db,ids) => new Promise((resolve,reject)=>{
  const tx=db.transaction('images','readonly'),store=tx.objectStore('images');
  const found=new Map();
  tx.onerror=()=>reject(tx.error||Error('Atlas read transaction failed'));
  tx.onabort=()=>reject(tx.error||Error('Atlas read transaction aborted'));
  tx.oncomplete=()=>resolve(found);
  for(const id of ids){const q=store.get(id);q.onsuccess=()=>found.set(id,q.result||null);}
});
const txAdd = (db,rows) => new Promise((resolve,reject)=>{
  const tx=db.transaction('images','readwrite');
  tx.onerror=()=>reject(tx.error||Error('Atlas Collection write failed'));
  tx.onabort=()=>reject(tx.error||Error('Atlas Collection write aborted'));
  tx.oncomplete=()=>resolve();
  for(const row of rows)tx.objectStore('images').add(row);
});
const verifyRow=async(row,expected,sourceHash)=>{
  if(!row||row.sha256!==expected||!(row.blob instanceof Blob)||!(row.original instanceof Blob)||!(row.base instanceof Blob))
    fail('stored Collection row does not match the candidate');
  if(await hash(await row.blob.arrayBuffer())!==expected||
     await hash(await row.original.arrayBuffer())!==sourceHash||
     await hash(await row.base.arrayBuffer())!==sourceHash)
    fail('Collection image bytes corrupted or conflicting');
};
/** Atomically save both the source and rejected candidate; never silently accept. */
export async function saveLocalDrawThingsCandidate({project,result,seriesId='W001',dbOpen=atlasDb}={}){
  if(!validSeries(seriesId))fail('invalid series ID');
  if(!project||!result||!project.entries?.includes(result)||result.role!=='result')fail('a generated history result must be selected');
  const source=result.source;
  if(!source||source.role!=='source'||!project.entries.includes(source))
    fail('ambiguous provenance: this result lacks a preceding source frame in the same Draw Things canvas');
  if(await hash(await result.blob.arrayBuffer())!==result.sha256||
     await hash(await source.blob.arrayBuffer())!==source.sha256)
    fail('source or result pixels changed since import');
  const idPart=project.projectSha256.slice(0,24);
  const srcId=`dt-src-${idPart}-${source.rowid}-${seriesId}`;
  const resultId=`dt-out-${idPart}-${result.rowid}-${seriesId}`;
  const now=Date.now();
  const srcRow={id:srcId,created:now,sha256:source.sha256,name:`${seriesId} — Draw Things source (history JPEG)`,
    seriesId,blob:source.blob,original:source.blob,base:source.blob,revisionStatus:'source',
    tags:{},originEngine:'Draw Things',originProjectSha256:project.projectSha256,
    originHistoryRow:source.rowid,sourceImageIsHistoryPreview:true};
  const outRow={id:resultId,created:now+1,sha256:result.sha256,
    name:`${seriesId} — Draw Things generation (QA HOLD · REPAIR)`,seriesId,
    blob:result.blob,original:source.blob,base:source.blob,
    sourceRecordId:srcId,parentRevisionId:srcId,revisionStatus:'candidate',reviewDecision:'repair',
    qualityHold:true,tags:{},prompt:result.metadata?.prompt||'',
    originEngine:'Draw Things',originProjectSha256:project.projectSha256,
    originHistoryRow:result.rowid,sourceSha256:source.sha256,
    sourceImageIsHistoryPreview:true,
    sourceLinkageEvidence:'local history order within the same canvas; not proof of pixel origin',
    generationMetadata:result.metadata};
  const db=await dbOpen();
  try{
    const old=await txRead(db,[srcId,resultId]);
    if(old.get(srcId))await verifyRow(old.get(srcId),source.sha256,source.sha256);
    if(old.get(resultId)){
      if(old.get(resultId).sourceRecordId!==srcId||old.get(resultId).qualityHold!==true||old.get(resultId).reviewDecision!=='repair')
        fail('existing output review or lineage differs; no existing decision overwritten');
      await verifyRow(old.get(resultId),result.sha256,source.sha256);
    }
    const add=[...(old.get(srcId)?[]:[srcRow]),...(old.get(resultId)?[]:[outRow])];
    if(add.length)await txAdd(db,add);
    const saved=await txRead(db,[srcId,resultId]);
    await verifyRow(saved.get(srcId),source.sha256,source.sha256);
    await verifyRow(saved.get(resultId),result.sha256,source.sha256);
    if(saved.get(resultId).sourceRecordId!==srcId||saved.get(resultId).qualityHold!==true)
      fail('Collection readback failed QA hold lineage verification');
    return {created:add.length>0,rowsCreated:add.length,sourceId:srcId,resultId,
      resultSha256:result.sha256,sourceSha256:source.sha256,qualityHold:true,collectionStored:true};
  }finally{db.close();}
}


/** Verify the real browser Collection after reload or native PR #7 restoration.
 * Does not silently recreate, accept, or modify any entries.
 */
export async function verifyLocalDrawThingsCandidate({project,result,seriesId='W001',dbOpen=atlasDb}={}){
  if(!validSeries(seriesId)||!project?.entries?.includes(result)||result?.role!=='result'||
     !result.source||!project.entries.includes(result.source))
    fail('missing or ambiguous source lineage');
  const source=result.source,idPart=project.projectSha256.slice(0,24);
  const srcId=`dt-src-${idPart}-${source.rowid}-${seriesId}`;
  const resultId=`dt-out-${idPart}-${result.rowid}-${seriesId}`;
  const db=await dbOpen();
  try{
    const rows=await txRead(db,[srcId,resultId]);
    await verifyRow(rows.get(srcId),source.sha256,source.sha256);
    await verifyRow(rows.get(resultId),result.sha256,source.sha256);
    const stored=rows.get(resultId);
    if(stored.sourceRecordId!==srcId||stored.parentRevisionId!==srcId||
       stored.qualityHold!==true||stored.reviewDecision!=='repair'||
       stored.revisionStatus!=='candidate'||stored.sourceSha256!==source.sha256)
      fail('restored Collection lost W001 lineage, QA hold or Repair review');
    return {verified:true,sourceId:srcId,resultId,sourceSha256:source.sha256,
      resultSha256:result.sha256,qualityHold:true,reviewDecision:'repair'};
  }finally{db.close();}
}

const el=(tag,text)=>{const x=document.createElement(tag);if(text!==undefined)x.textContent=text;return x;};
/** Adds a local-only importer directly to the existing Atlas Collection tab. */
export function mountLocalDrawThingsImporter(){
  const target=document.getElementById('gallery-tab');
  if(!target||document.getElementById('atlas-rc8-local-dt'))return false;
  const panel=el('section');panel.id='atlas-rc8-local-dt';
  panel.style.cssText='margin:16px 0;padding:14px;border:1px solid #6a4b5c;border-radius:14px;background:#1d1a23';
  panel.append(el('h3','Draw Things project · local import'));
  panel.append(el('p','Choose a complete Draw Things .sqlite3 export from Files. The project stays on this device; no backend upload. History JPEGs are previews, not proven native-resolution exports.'));
  const file=el('input');file.type='file';file.accept='.sqlite3,.sqlite,.db';file.setAttribute('aria-label','Draw Things SQLite project');
  const series=el('input');series.value='W001';series.placeholder='Series ID';series.setAttribute('aria-label','Atlas series ID');
  const scan=el('button','Read project locally');scan.type='button';
  const status=el('p','No project selected');status.setAttribute('role','status');
  const results=el('div');
  for(const x of [file,series,scan,status,results]){x.style.maxWidth='100%';x.style.margin='6px 8px 6px 0';panel.append(x);}
  scan.onclick=async()=>{
    if(!file.files?.length){status.textContent='Select a Draw Things project file first';return;}
    scan.disabled=true;results.replaceChildren();status.textContent='Reading the exported project entirely on this device…';
    try{
      const project=await parseLocalDrawThingsProject(await file.files[0].arrayBuffer());
      const candidates=project.entries.filter(x=>x.role==='result');
      status.textContent=`Found ${project.entries.length} history frames; ${candidates.length} generated candidates. No pixels uploaded.`;
      for(const result of candidates){
        const card=el('div');card.style.cssText='display:inline-flex;flex-direction:column;vertical-align:top;gap:8px;max-width:240px;margin:8px;padding:8px;border:1px solid #4b3b46;border-radius:10px';
        card.append(el('p',`${result.metadata.modelFilename||'Model unknown'} · seed ${result.metadata.seed??'unknown'} · ${result.width}×${result.height}`));
        const img=el('img');img.alt='Local Draw Things result preview';img.style.cssText='width:100%;height:auto';
        const url=URL.createObjectURL(result.blob);img.src=url;
        img.addEventListener('load',()=>URL.revokeObjectURL(url),{once:true});card.append(img);
        const save=el('button','Save source + result · QA HOLD');save.type='button';
        save.onclick=async()=>{
          save.disabled=true;
          try{
            const r=await saveLocalDrawThingsCandidate({project,result,seriesId:series.value.trim()});
            status.textContent=r.created?`Saved ${r.rowsCreated} exact image records to this browser Collection. QA HOLD.`:'Both images already preserved in this browser Collection.';
            document.querySelector('[data-tab="gallery"]')?.click();
          }catch(e){status.textContent=e.message;}finally{save.disabled=false;}
        };
        card.append(save);
        const verify=el('button','Verify saved frame after backup / restore');verify.type='button';
        verify.onclick=async()=>{
          verify.disabled=true;
          try{
            const proof=await verifyLocalDrawThingsCandidate({project,result,seriesId:series.value.trim()});
            status.textContent=`VERIFIED Collection: source and result bytes, W001 lineage, and QA HOLD · REPAIR. Result: ${proof.resultSha256.slice(0,16)}…`;
          }catch(e){status.textContent='NOT VERIFIED: '+e.message;}
          finally{verify.disabled=false;}
        };
        card.append(verify);results.append(card);
      }
    }catch(e){status.textContent=e.message||'Project import failed';}
    finally{scan.disabled=false;}
  };
  target.prepend(panel);return true;
}
if(typeof document!=='undefined'){
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountLocalDrawThingsImporter,{once:true});
  else mountLocalDrawThingsImporter();
}

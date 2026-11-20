// OVA Atlas RC9 — Draw Things generation adapter (local, free, no uploads).
//
// Transports, in order of preference, each limited to what Draw Things
// actually documents or ships:
//  A. 'drawthings-script'  iPhone / iPad / Mac. Atlas writes a self-contained
//     Draw Things JavaScript script (API 1.0: canvas.loadImageSrc,
//     canvas.loadMaskFromSrc, pipeline.run, canvas.saveImage). The person adds
//     it in Draw Things › Scripts and runs it; the result is saved to
//     Files › Draw Things › Pictures and imported back here. Draw Things has no
//     documented URL scheme, App Intent or inbound share action that a web page
//     can trigger, so this hand-off is two taps per direction, not automatic.
//  B. 'drawthings-http'    Optional, computer only. Draw Things' HTTP API
//     (/sdapi/v1/img2img) through tools/drawthings_http_bridge.mjs on the same
//     machine (Draw Things sends no CORS headers). The HTTP API ignores masks,
//     so masked edits are refused rather than silently run unmasked.
//
// Nothing here uploads, compresses, resizes or re-encodes the original or edit
// base: image bytes are passed through exactly, and results are stored exactly
// as returned, in QA HOLD, never accepted automatically.

export const QA_HOLD = 'QA HOLD';
export const ADAPTER_VERSION = 'ova-atlas-generation-1';
export const LIMITS = Object.freeze({ image: 24 * 1024 * 1024, result: 64 * 1024 * 1024, prompt: 1600, dtMin: 128, dtMax: 8192, dtStep: 64 });
export const HTTP_DEFAULT_BRIDGE = 'http://127.0.0.1:7861';

const fail = message => { throw new Error(message); };
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) fail('Secure context (HTTPS) required for image fingerprints');
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
}
async function bytesOf(blob, limit, what) {
  if (!(blob instanceof Blob) || !blob.size) fail(`${what} is missing`);
  if (blob.size > limit) fail(`${what} is larger than ${Math.round(limit / 1048576)} MB`);
  return new Uint8Array(await blob.arrayBuffer());
}

/** Reads format and pixel size from the file header only (no decoding). */
export function imageInfo(b) {
  if (!(b instanceof Uint8Array) || b.length < 24) fail('Not an image: file is empty or truncated');
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return checkSize({ type: 'image/png', width: v.getUint32(16), height: v.getUint32(20) });
  }
  if (b[0] === 0xFF && b[1] === 0xD8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) fail('Malformed JPEG');
      const m = b[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }
      const len = b[i + 2] << 8 | b[i + 3];
      if (len < 2) fail('Malformed JPEG');
      if ((m >= 0xC0 && m <= 0xCF) && m !== 0xC4 && m !== 0xC8 && m !== 0xCC)
        return checkSize({ type: 'image/jpeg', height: b[i + 5] << 8 | b[i + 6], width: b[i + 7] << 8 | b[i + 8] });
      if (m === 0xDA || m === 0xD9) break;
      i += 2 + len;
    }
    fail('Malformed JPEG: no frame header');
  }
  if (b.length >= 30 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') {
    const chunk = String.fromCharCode(...b.subarray(12, 16));
    if (chunk === 'VP8X') return checkSize({ type: 'image/webp', width: 1 + (b[24] | b[25] << 8 | b[26] << 16), height: 1 + (b[27] | b[28] << 8 | b[29] << 16) });
    if (chunk === 'VP8L' && b[20] === 0x2F) { const n = b[21] | b[22] << 8 | b[23] << 16 | b[24] << 24; return checkSize({ type: 'image/webp', width: 1 + (n & 0x3FFF), height: 1 + (n >>> 14 & 0x3FFF) }); }
    if (chunk === 'VP8 ' && b[23] === 0x9D && b[24] === 0x01 && b[25] === 0x2A) return checkSize({ type: 'image/webp', width: (b[26] | b[27] << 8) & 0x3FFF, height: (b[28] | b[29] << 8) & 0x3FFF });
    fail('Malformed WebP');
  }
  fail('Not a PNG, JPEG or WebP image');
}
function checkSize(info) {
  if (!Number.isInteger(info.width) || !Number.isInteger(info.height) || info.width < 1 || info.height < 1 || info.width > 16384 || info.height > 16384)
    fail('Image has invalid dimensions');
  return info;
}

/** The size Draw Things will actually generate at (it rounds down to multiples of 64). */
export function drawThingsFrame(width, height) {
  const down = n => n - n % LIMITS.dtStep;
  const w = down(width), h = down(height);
  if (w < LIMITS.dtMin || h < LIMITS.dtMin) fail(`Draw Things needs at least ${LIMITS.dtMin}×${LIMITS.dtMin} pixels`);
  if (w > LIMITS.dtMax || h > LIMITS.dtMax) fail(`Draw Things accepts at most ${LIMITS.dtMax} pixels per side`);
  return { width: w, height: h, exact: w === width && h === height };
}

// Presets set real Draw Things configuration fields (JSGenerationConfiguration
// keys: strength, maskBlur, preserveOriginalAfterInpaint) plus explicit prompt
// text. None of them can lock identity; that depends on the chosen model.
export const PRESETS = Object.freeze({
  FIDELITY: { label: 'Fidelity', strength: 0.3, maskBlur: 4, requiresMask: false, base: 'current',
    prompt: 'faithful to the source image, same character design, same line art and colors, 1991-1994 hand-painted anime cel',
    negative: 'redesign, different character, modern digital anime style, 3d render, photo',
    note: 'Low denoising strength: small changes everywhere (or inside the mask, if painted).' },
  FIX: { label: 'Fix masked area', strength: 0.7, maskBlur: 8, requiresMask: true, base: 'current',
    prompt: 'seamless repair that matches the surrounding cel artwork',
    negative: 'visible seams, mismatched colors, blur, extra limbs',
    note: 'Inpaints only the painted mask; Draw Things keeps pixels outside it.' },
  CONTINUE: { label: 'Continue', strength: 0.45, maskBlur: 6, requiresMask: false, base: 'accepted',
    prompt: 'continue refining the accepted revision, same character design',
    negative: 'redesign, different character',
    note: 'Requires the Studio image to be an accepted revision opened from Collection.' },
  RETRY: { label: 'Retry', strength: 0.55, maskBlur: 8, requiresMask: false, base: 'accepted', newSeed: true,
    prompt: '', negative: '',
    note: 'Another candidate from the same accepted base with a new recorded seed.' },
  MORE_FIDELITY: { label: 'More fidelity', strength: 0.2, maskBlur: 4, requiresMask: false, base: 'current',
    prompt: 'exactly the same face, same hairstyle and hair color, same body proportions and pose',
    negative: 'different face, changed hairstyle, distorted anatomy, extra fingers, extra limbs, changed proportions',
    note: 'Lowest strength plus protective prompt text. Not an identity lock.' }
});

const SERIES = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const cleanText = (value, max, what) => {
  if (value == null) return '';
  if (typeof value !== 'string') fail(`${what} must be text`);
  if (value.length > max) fail(`${what} is longer than ${max} characters`);
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
};
const randomSeed = () => { const a = new Uint32Array(1); globalThis.crypto.getRandomValues(a); return a[0]; };
const newJobId = () => {
  const a = new Uint8Array(8); globalThis.crypto.getRandomValues(a);
  return `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${hex(a)}`;
};

/**
 * Validates and normalizes one generation request.
 * input: {original, editBase, mask?, prompt, negativePrompt?, strength?, model?, seed?,
 *         steps?, guidanceScale?, preset, seriesId, parentRevisionId?, sourceRecordId?,
 *         baseIsAcceptedRevision?, transport}
 */
export async function buildGenerationRequest(input = {}) {
  const preset = PRESETS[input.preset];
  if (!preset) fail('Choose a generation preset');
  const transport = input.transport || 'drawthings-script';
  if (transport !== 'drawthings-script' && transport !== 'drawthings-http') fail('Unsupported generation transport');
  if (!SERIES.test(String(input.seriesId || ''))) fail('This image has no valid series ID; reopen it from Collection');
  const originalBytes = await bytesOf(input.original, LIMITS.result, 'Original image');
  const baseBytes = await bytesOf(input.editBase, LIMITS.image, 'Edit base image');
  const base = imageInfo(baseBytes), original = imageInfo(originalBytes);
  const maskBytes = input.mask ? await bytesOf(input.mask, LIMITS.image, 'Mask') : null;
  const mask = maskBytes ? imageInfo(maskBytes) : null;
  if (mask && mask.type !== 'image/png') fail('Mask must be a PNG');
  if (mask && (mask.width !== base.width || mask.height !== base.height)) fail('Mask size does not match the edit base');
  if (preset.requiresMask && !mask) fail(`${preset.label} needs a painted mask`);
  if (preset.base === 'accepted' && !(input.baseIsAcceptedRevision && input.parentRevisionId))
    fail(`${preset.label} starts from an accepted revision: open one from Collection with “Accept and continue” first`);
  if (transport === 'drawthings-http' && mask)
    fail('The Draw Things HTTP API ignores masks. Use the Draw Things script hand-off for masked edits, or clear the mask.');
  const frame = drawThingsFrame(base.width, base.height);
  if (transport === 'drawthings-http' && !frame.exact)
    fail(`The HTTP API needs width and height divisible by 64; this image is ${base.width}×${base.height}. Use the script hand-off.`);
  const userPrompt = cleanText(input.prompt, LIMITS.prompt, 'Prompt').trim();
  if (!userPrompt && !preset.prompt) fail('Describe the edit in the prompt');
  const prompt = [userPrompt, preset.prompt].filter(Boolean).join(', ');
  const negativePrompt = [cleanText(input.negativePrompt, LIMITS.prompt, 'Negative prompt').trim(), preset.negative].filter(Boolean).join(', ');
  const strength = input.strength == null || input.strength === '' ? preset.strength : Number(input.strength);
  if (!Number.isFinite(strength) || strength < 0.05 || strength > 1) fail('Strength must be between 0.05 and 1');
  let seed = input.seed == null || input.seed === '' ? null : Number(input.seed);
  if (seed !== null && (!Number.isInteger(seed) || seed < 0 || seed > 4294967295)) fail('Seed must be a whole number from 0 to 4294967295');
  if (seed === null || preset.newSeed) seed = randomSeed();
  const model = cleanText(input.model, 200, 'Model file').trim();
  if (model && !/^[\w.\-]+\.(ckpt|safetensors)$/i.test(model)) fail('Model must be a Draw Things model file name such as sd_v1.5_f16.ckpt');
  const steps = input.steps == null || input.steps === '' ? null : Number(input.steps);
  if (steps !== null && (!Number.isInteger(steps) || steps < 1 || steps > 150)) fail('Steps must be 1–150');
  const guidanceScale = input.guidanceScale == null || input.guidanceScale === '' ? null : Number(input.guidanceScale);
  if (guidanceScale !== null && (!Number.isFinite(guidanceScale) || guidanceScale < 0 || guidanceScale > 50)) fail('Guidance must be 0–50');
  const jobId = newJobId();
  return {
    adapter: ADAPTER_VERSION, jobId, transport, preset: input.preset, created: Date.now(),
    seriesId: input.seriesId, parentRevisionId: input.parentRevisionId || null, sourceRecordId: input.sourceRecordId || '',
    original: input.original, editBase: input.editBase, mask: input.mask || null,
    originalSha256: await sha256(originalBytes), editBaseSha256: await sha256(baseBytes), maskSha256: maskBytes ? await sha256(maskBytes) : null,
    originalInfo: original, editBaseInfo: base, frame,
    settings: { prompt, negativePrompt, strength, seed, model: model || null, steps, guidanceScale, maskBlur: preset.maskBlur,
      preserveOriginalAfterInpaint: Boolean(mask), width: frame.width, height: frame.height, batchCount: 1, batchSize: 1 },
    outputName: `ova-atlas-${jobId}.png`
  };
}

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const jsLiteral = value => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029').replace(/</g, '\\u003c');

/** Writes the Draw Things script for one request. Image bytes are embedded unchanged. */
export async function buildDrawThingsScript(request) {
  if (!request?.jobId || request.transport !== 'drawthings-script') fail('Not a Draw Things script request');
  const baseBytes = new Uint8Array(await request.editBase.arrayBuffer());
  if (await sha256(baseBytes) !== request.editBaseSha256) fail('Edit base changed after the request was prepared');
  const image = `data:${request.editBaseInfo.type};base64,${base64(baseBytes)}`;
  let mask = null;
  if (request.mask) {
    const maskBytes = new Uint8Array(await request.mask.arrayBuffer());
    if (await sha256(maskBytes) !== request.maskSha256) fail('Mask changed after the request was prepared');
    mask = `data:image/png;base64,${base64(maskBytes)}`;
  }
  const s = request.settings;
  const job = { jobId: request.jobId, preset: request.preset, seriesId: request.seriesId, outputName: request.outputName,
    prompt: s.prompt, negativePrompt: s.negativePrompt, width: s.width, height: s.height, strength: s.strength, seed: s.seed,
    model: s.model, steps: s.steps, guidanceScale: s.guidanceScale, maskBlur: s.maskBlur, preserveOriginalAfterInpaint: s.preserveOriginalAfterInpaint,
    sourceWidth: request.editBaseInfo.width, sourceHeight: request.editBaseInfo.height, editBaseSha256: request.editBaseSha256 };
  return `//@api-1.0
// OVA Atlas generation job ${request.jobId} (${request.preset}). Generated by OVA Atlas; runs only inside Draw Things.
// Uses the documented Draw Things script API: canvas.loadImageSrc, canvas.loadMaskFromSrc,
// pipeline.run and canvas.saveImage. No network access. Delete this script from Draw Things when done.
const JOB = ${jsLiteral(job)};
const IMAGE = ${jsLiteral(image)};
const MASK = ${jsLiteral(mask)};
const configuration = pipeline.configuration;
configuration.width = JOB.width;
configuration.height = JOB.height;
configuration.strength = JOB.strength;
configuration.seed = JOB.seed;
configuration.maskBlur = JOB.maskBlur;
configuration.preserveOriginalAfterInpaint = JOB.preserveOriginalAfterInpaint;
configuration.batchCount = 1;
configuration.batchSize = 1;
if (JOB.model) configuration.model = JOB.model;
if (JOB.steps !== null) configuration.steps = JOB.steps;
if (JOB.guidanceScale !== null) configuration.guidanceScale = JOB.guidanceScale;
console.log("OVA Atlas job " + JOB.jobId + ": " + JOB.sourceWidth + "x" + JOB.sourceHeight + " image, generating at " + JOB.width + "x" + JOB.height + (MASK ? " with mask" : " without mask"));
canvas.clear();
canvas.updateCanvasSize(configuration);
canvas.canvasZoom = 1;
canvas.moveCanvas(0, 0);
canvas.loadImageSrc(IMAGE);
if (MASK) canvas.loadMaskFromSrc(MASK);
pipeline.run({ configuration: configuration, prompt: JOB.prompt, negativePrompt: JOB.negativePrompt, mask: MASK ? canvas.currentMask : null });
const folder = filesystem.pictures.path;
canvas.saveImage(folder + "/" + JOB.outputName, false);
console.log("OVA Atlas: saved " + JOB.outputName + " in Files > Draw Things > Pictures. Return to OVA Atlas and import it.");
`;
}

/**
 * Verifies image bytes that came back from Draw Things. Throws unless they are a
 * real, non-identical image. Does not decode, resize or re-encode anything.
 */
export async function verifyReturnedImage(request, file, { fileName = file?.name || '', allowNameMismatch = false } = {}) {
  if (!request?.jobId) fail('No generation job to attach this result to');
  const bytes = await bytesOf(file, LIMITS.result, 'Returned image');
  const info = imageInfo(bytes);
  const digest = await sha256(bytes);
  if (digest === request.editBaseSha256 || digest === request.originalSha256)
    fail('This file is identical to the source image. Draw Things did not return a new generation.');
  const nameMatches = typeof fileName === 'string' && fileName.includes(request.jobId);
  if (request.transport === 'drawthings-script' && !nameMatches && !allowNameMismatch)
    fail(`This file is not named for job ${request.jobId}. Choose ${request.outputName} from Files > Draw Things > Pictures.`);
  const blob = file.type === info.type ? file : new Blob([bytes], { type: info.type });
  return { blob, sha256: digest, info, fileName: String(fileName).slice(0, 200), nameMatchesJob: nameMatches,
    matchesSourceSize: info.width === request.editBaseInfo.width && info.height === request.editBaseInfo.height,
    matchesGenerationFrame: info.width === request.frame.width && info.height === request.frame.height };
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;
/**
 * Optional transport B: Draw Things HTTP API via the local bridge on the same computer.
 * Image-to-image only (no mask). Never reports success without verified image bytes.
 */
export async function generateViaHttp(request, { baseUrl = HTTP_DEFAULT_BRIDGE, signal, fetchImpl = globalThis.fetch, timeoutMs = 15 * 60 * 1000 } = {}) {
  if (request?.transport !== 'drawthings-http') fail('Not an HTTP request');
  if (request.mask) fail('The Draw Things HTTP API ignores masks; refusing to run a masked edit unmasked.');
  const origin = String(baseUrl).replace(/\/+$/, '');
  if (!LOOPBACK.test(origin)) fail('The HTTP bridge must run on this computer (http://127.0.0.1:port). Nothing was sent.');
  const s = request.settings;
  const body = { init_images: [base64(new Uint8Array(await request.editBase.arrayBuffer()))], prompt: s.prompt, negative_prompt: s.negativePrompt,
    strength: s.strength, seed: s.seed, width: s.width, height: s.height, batch_count: 1 };
  if (s.model) body.model = s.model;
  if (s.steps !== null) body.steps = s.steps;
  if (s.guidanceScale !== null) body.guidance_scale = s.guidanceScale;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  let response, data;
  try {
    if (controller.signal.aborted) throw new Error('aborted');
    response = await fetchImpl(`${origin}/sdapi/v1/img2img`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    data = await response.json().catch(() => null);
  } catch (error) {
    if (controller.signal.aborted) fail(signal?.aborted ? 'Generation cancelled. Draw Things may still finish it; nothing was saved.' : 'Draw Things did not answer in time. Nothing was saved.');
    fail('Could not reach the Draw Things bridge on this computer. Start Draw Things’ HTTP API server and tools/drawthings_http_bridge.mjs.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  if (!response.ok) fail(`Draw Things refused the request (${response.status}): ${String(data?.error || data?.detail || 'no details').slice(0, 300)}`);
  const images = data?.images;
  if (!Array.isArray(images) || images.length < 1 || typeof images[0] !== 'string') fail('Draw Things returned no image');
  let bytes;
  try { bytes = Uint8Array.from(atob(images[0]), c => c.charCodeAt(0)); } catch { fail('Draw Things returned a malformed image'); }
  const info = imageInfo(bytes);
  const blob = new Blob([bytes], { type: info.type });
  return verifyReturnedImage(request, blob, { fileName: request.outputName });
}

// ---- Storage: the existing Atlas IndexedDB, no schema change -----------------
const STORES = ['images', 'pending', 'drafts', 'archive', 'privateCatalog'];
export const atlasDb = () => new Promise((resolve, reject) => {
  if (!globalThis.indexedDB) return reject(new Error('Browser storage unavailable; nothing saved'));
  const q = globalThis.indexedDB.open('ova-atlas-6', 5);
  q.onupgradeneeded = () => { for (const s of STORES) if (!q.result.objectStoreNames.contains(s)) q.result.createObjectStore(s, { keyPath: 'id' }); };
  q.onerror = () => reject(q.error || new Error('Atlas storage failed to open'));
  q.onsuccess = () => {
    const d = q.result;
    if (STORES.some(s => !d.objectStoreNames.contains(s))) { d.close(); reject(new Error('Atlas storage schema incompatible; nothing saved')); return; }
    resolve(d);
  };
});
const run = (db, store, mode, work) => new Promise((resolve, reject) => {
  const tx = db.transaction(store, mode), os = tx.objectStore(store);
  let out;
  tx.oncomplete = () => resolve(out);
  tx.onerror = () => reject(tx.error || new Error('Atlas storage write failed'));
  tx.onabort = () => reject(tx.error || new Error('Atlas storage write aborted'));
  try { out = work(os, v => { out = v; }); } catch (error) { try { tx.abort(); } catch {} reject(error); }
});
const pendingKey = jobId => `dt-job-${jobId}`;

/** Persists a sent job (with its exact source bytes) so app switching or reloads lose nothing. */
export async function savePendingJob(request, { dbOpen = atlasDb } = {}) {
  const { original, editBase, mask, ...meta } = request;
  const row = { id: pendingKey(request.jobId), kind: 'drawthings-generation', status: 'sent', ...meta, original, editBase, mask };
  const db = await dbOpen();
  try { await run(db, 'pending', 'readwrite', os => { os.put(row); }); } finally { db.close(); }
  return row;
}
export async function listPendingJobs({ dbOpen = atlasDb } = {}) {
  const db = await dbOpen();
  try {
    const rows = await run(db, 'pending', 'readonly', (os, set) => { const q = os.getAll(); q.onsuccess = () => set(q.result || []); });
    return rows.filter(r => r && r.kind === 'drawthings-generation').sort((a, b) => b.created - a.created);
  } finally { db.close(); }
}
/** Removes a job reference only when the person explicitly discards it. Collection images are untouched. */
export async function discardPendingJob(jobId, { dbOpen = atlasDb } = {}) {
  const db = await dbOpen();
  try { await run(db, 'pending', 'readwrite', os => { os.delete(pendingKey(jobId)); }); } finally { db.close(); }
}

/**
 * Atomically saves the mask (if any) and the verified result in QA HOLD with full
 * lineage, then reads both back and checks bytes. Idempotent for the same bytes.
 */
export async function saveGeneratedCandidate(request, returned, { dbOpen = atlasDb, transportEvidence } = {}) {
  if (!returned?.blob || !/^[0-9a-f]{64}$/.test(returned.sha256 || '')) fail('Only verified returned image bytes can be saved');
  if (await sha256(new Uint8Array(await returned.blob.arrayBuffer())) !== returned.sha256) fail('Returned image changed before saving');
  for (const [blob, expected, what] of [[request.original, request.originalSha256, 'Original'], [request.editBase, request.editBaseSha256, 'Edit base']])
    if (await sha256(new Uint8Array(await blob.arrayBuffer())) !== expected) fail(`${what} bytes changed since the job was sent; nothing saved`);
  const id = `gen-${request.jobId}-${returned.sha256.slice(0, 16)}`;
  const maskId = request.mask ? `gen-mask-${request.jobId}` : null;
  const now = Date.now(), s = request.settings;
  const generation = {
    adapter: ADAPTER_VERSION, engine: 'Draw Things', transport: request.transport, jobId: request.jobId, preset: request.preset,
    requestedSettings: { ...s }, settingsEvidence: 'Settings OVA Atlas asked Draw Things to use. Draw Things may substitute values it does not support.',
    originalSha256: request.originalSha256, editBaseSha256: request.editBaseSha256, maskSha256: request.maskSha256, maskRecordId: maskId,
    sourceWidth: request.editBaseInfo.width, sourceHeight: request.editBaseInfo.height, frameWidth: request.frame.width, frameHeight: request.frame.height,
    resultWidth: returned.info.width, resultHeight: returned.info.height, resultType: returned.info.type, resultFileName: returned.fileName,
    resultMatchesSourceSize: returned.matchesSourceSize, resultNameMatchesJob: returned.nameMatchesJob,
    provenance: transportEvidence || (request.transport === 'drawthings-http'
      ? 'Bytes returned directly by the Draw Things HTTP API to this page.'
      : 'File chosen by the person from Files after running the OVA Atlas script in Draw Things; name matched the job. Atlas cannot prove pixel origin.')
  };
  const rows = [];
  if (maskId) rows.push({ id: maskId, created: now, sha256: request.maskSha256, name: `${request.seriesId} — generation mask ${request.jobId} (white = edit)`,
    seriesId: request.seriesId, blob: request.mask, revisionStatus: 'mask', recordRole: 'generation-mask', tags: {}, generationJobId: request.jobId });
  rows.push({ id, created: now + 1, sha256: returned.sha256, name: `${request.seriesId} — Draw Things ${request.preset} (QA HOLD)`,
    seriesId: request.seriesId, blob: returned.blob, original: request.original, base: request.editBase,
    parentRevisionId: request.parentRevisionId || null, sourceRecordId: request.sourceRecordId || '',
    revisionStatus: QA_HOLD, qualityHold: true, reviewDecision: 'review', prompt: s.prompt, negativePrompt: s.negativePrompt,
    tags: {}, originEngine: 'Draw Things', generation });
  const db = await dbOpen();
  try {
    const existing = await run(db, 'images', 'readonly', (os, set) => { const found = {}; for (const r of rows) { const q = os.get(r.id); q.onsuccess = () => { found[r.id] = q.result || null; set(found); }; } });
    const add = [];
    for (const r of rows) {
      const old = existing?.[r.id];
      if (!old) { add.push(r); continue; }
      if (old.sha256 !== r.sha256) fail('A different image already uses this record ID; nothing overwritten');
    }
    if (add.length) await run(db, 'images', 'readwrite', os => { for (const r of add) os.add(r); });
    const saved = await run(db, 'images', 'readonly', (os, set) => { const found = {}; for (const r of rows) { const q = os.get(r.id); q.onsuccess = () => { found[r.id] = q.result || null; set(found); }; } });
    const out = saved?.[id];
    if (!out || await sha256(new Uint8Array(await out.blob.arrayBuffer())) !== returned.sha256 ||
        await sha256(new Uint8Array(await out.original.arrayBuffer())) !== request.originalSha256 ||
        await sha256(new Uint8Array(await out.base.arrayBuffer())) !== request.editBaseSha256)
      fail('Collection read-back failed; the result was not verified');
    if (maskId && saved[maskId]?.sha256 !== request.maskSha256) fail('Mask read-back failed');
    await run(db, 'pending', 'readwrite', (os) => {
      const q = os.get(pendingKey(request.jobId));
      q.onsuccess = () => { if (q.result) os.put({ ...q.result, status: 'imported', resultRecordIds: [...new Set([...(q.result.resultRecordIds || []), id])] }); };
    });
    return { id, maskId, created: add.some(r => r.id === id), revisionStatus: out.revisionStatus, sha256: returned.sha256 };
  } finally { db.close(); }
}

// ---- Studio panel -----------------------------------------------------------
const el = (tag, props = {}, ...kids) => { const x = document.createElement(tag); Object.assign(x, props); x.append(...kids); return x; };

/** Mounts the generation panel inside Studio. `studio()` returns the current Studio context. */
export function mountDrawThingsGeneration({ studio = () => globalThis.OVA_STUDIO?.snapshot?.(), dbOpen = atlasDb } = {}) {
  const anchor = document.getElementById('resume-panel');
  if (!anchor || document.getElementById('atlas-rc9-generate')) return false;
  const panel = el('section', { id: 'atlas-rc9-generate', className: 'collection-backup' });
  panel.setAttribute('aria-label', 'Draw Things generation');
  const status = el('p', { className: 'tiny', id: 'rc9-status' }); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const say = (text, isError = false) => { status.textContent = text; status.style.color = isError ? '#ff8f8f' : ''; };
  let preset = 'FIX';
  const presetRow = el('div', { className: 'backup-actions' });
  const strength = el('input', { type: 'number', min: '0.05', max: '1', step: '0.05', id: 'rc9-strength', value: String(PRESETS.FIX.strength) });
  const presetNote = el('p', { className: 'tiny' }, PRESETS.FIX.note);
  for (const [key, p] of Object.entries(PRESETS)) {
    const b = el('button', { type: 'button', className: key === preset ? 'subtlebtn selected' : 'subtlebtn', textContent: p.label });
    b.dataset.preset = key;
    b.onclick = () => { preset = key; strength.value = String(p.strength); presetNote.textContent = p.note; presetRow.querySelectorAll('button').forEach(x => x.classList.toggle('selected', x === b)); };
    presetRow.append(b);
  }
  const negative = el('textarea', { id: 'rc9-negative', rows: 2, maxLength: LIMITS.prompt, placeholder: 'Negative prompt (optional)' });
  const seed = el('input', { type: 'number', id: 'rc9-seed', min: '0', max: '4294967295', placeholder: 'random, recorded' });
  const model = el('input', { type: 'text', id: 'rc9-model', placeholder: 'model currently selected in Draw Things', autocomplete: 'off' });
  const transport = el('select', { id: 'rc9-transport' },
    el('option', { value: 'drawthings-script', textContent: 'iPhone / iPad / Mac: Draw Things script hand-off' }),
    el('option', { value: 'drawthings-http', textContent: 'Computer only: Draw Things HTTP API via local bridge (no mask)' }));
  const go = el('button', { type: 'button', className: 'primary generate', id: 'rc9-generate', textContent: 'Generate with Draw Things ✦' });
  const cancel = el('button', { type: 'button', className: 'ghost', textContent: 'Cancel', hidden: true });
  const jobs = el('div', { id: 'rc9-jobs' });
  const compare = el('div', { id: 'rc9-compare', hidden: true, style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px' });
  const label = (text, control) => el('label', { className: 'tiny', style: 'display:block;margin:6px 0' }, text + ' ', control);
  panel.append(
    el('div', { className: 'eyebrow', textContent: 'AI EDIT · DRAW THINGS ON THIS DEVICE' }),
    el('p', { className: 'tiny', textContent: 'Uses the Studio image, painted mask and prompt above. Runs in your own Draw Things app; nothing is uploaded. Results enter Collection in QA HOLD and are never accepted automatically.' }),
    presetRow, presetNote, negative, label('Strength', strength), label('Seed', seed), label('Model file', model), label('Route', transport),
    el('div', { className: 'backup-actions' }, go, cancel), status, compare, jobs);
  anchor.before(panel);

  let controller = null;
  const showCompare = (sourceBlob, resultBlob, info) => {
    for (const img of compare.querySelectorAll('img')) URL.revokeObjectURL(img.src);
    compare.replaceChildren(
      el('figure', {}, el('img', { src: URL.createObjectURL(sourceBlob), alt: 'Edit base', style: 'width:100%' }), el('figcaption', { className: 'tiny', textContent: 'Source (unchanged)' })),
      el('figure', {}, el('img', { src: URL.createObjectURL(resultBlob), alt: 'Draw Things result', style: 'width:100%' }), el('figcaption', { className: 'tiny', textContent: `Result ${info.width}×${info.height} · QA HOLD` })));
    compare.hidden = false;
  };
  const finish = async (request, returned) => {
    const saved = await saveGeneratedCandidate(request, returned, { dbOpen });
    showCompare(request.editBase, returned.blob, returned.info);
    const sizeNote = returned.matchesSourceSize ? '' : ` Size differs from the source (${request.editBaseInfo.width}×${request.editBaseInfo.height} → ${returned.info.width}×${returned.info.height}); recorded, not resized.`;
    say(`Saved to Collection in QA HOLD with its original and edit base${request.parentRevisionId ? ' and parent revision link' : ''}. Fingerprint ${saved.sha256.slice(0, 12)}….${sizeNote}`);
    await renderJobs();
  };
  const importInto = request => {
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    input.onchange = async () => {
      const file = input.files?.[0]; if (!file) return;
      try {
        let returned;
        try { returned = await verifyReturnedImage(request, file); }
        catch (error) {
          if (!/not named for job/.test(error.message) || !globalThis.confirm?.(`${error.message}\n\nUse this file anyway as the result of job ${request.jobId}?`)) throw error;
          returned = await verifyReturnedImage(request, file, { allowNameMismatch: true });
        }
        await finish(request, returned);
      } catch (error) { say(error.message || 'Could not import the result', true); }
    };
    input.click();
  };
  async function renderJobs() {
    let rows = [];
    try { rows = await listPendingJobs({ dbOpen }); } catch (error) { say(error.message, true); }
    jobs.replaceChildren(...rows.filter(r => r.transport === 'drawthings-script').slice(0, 10).map(r => {
      const row = el('div', { className: 'backup-actions', style: 'margin-top:6px' },
        el('span', { className: 'tiny', textContent: `${r.status === 'imported' ? 'Imported' : 'Waiting for result'} · ${r.preset} · ${r.outputName}` }));
      const imp = el('button', { type: 'button', className: 'subtlebtn', textContent: 'Import result' }); imp.onclick = () => importInto(r);
      const share = el('button', { type: 'button', className: 'subtlebtn', textContent: 'Send script again' }); share.onclick = () => void sendScript(r);
      const drop = el('button', { type: 'button', className: 'ghost', textContent: 'Discard job' });
      drop.onclick = async () => { if (!globalThis.confirm?.('Discard this job reference? Images already in Collection are kept.')) return; await discardPendingJob(r.jobId, { dbOpen }); await renderJobs(); };
      row.append(imp, share, drop); return row;
    }));
  }
  async function sendScript(request) {
    const text = await buildDrawThingsScript(request);
    const file = new File([text], `OVA-Atlas-${request.jobId}.js`, { type: 'text/javascript' });
    if (typeof navigator.share === 'function' && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); say(`Script shared. In Draw Things: Scripts › Add Script › choose OVA-Atlas-${request.jobId}.js › Run. Then tap “Import result” and pick ${request.outputName} in Files › Draw Things › Pictures.`); return; }
      catch (error) { if (error?.name === 'AbortError') { say('Sharing cancelled. The job is kept; use “Send script again”.'); return; } }
    }
    const url = URL.createObjectURL(file);
    const a = el('a', { href: url, download: file.name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000)?.unref?.(); // unref: Node test runs only
    say(`Script downloaded as ${file.name}. Add it in Draw Things › Scripts, run it, then import ${request.outputName}.`);
  }
  go.onclick = async () => {
    if (controller) return;
    go.disabled = true;
    try {
      const ctx = await studio();
      if (!ctx?.editBase) fail('Open an image in Studio first');
      const request = await buildGenerationRequest({ ...ctx, preset, transport: transport.value, negativePrompt: negative.value,
        strength: strength.value, seed: seed.value, model: model.value });
      if (!request.frame.exact) say(`Note: Draw Things generates at ${request.frame.width}×${request.frame.height} (multiples of 64); the source is ${request.editBaseInfo.width}×${request.editBaseInfo.height}.`);
      if (request.transport === 'drawthings-script') {
        await savePendingJob(request, { dbOpen });
        await renderJobs();
        await sendScript(request);
      } else {
        controller = new AbortController(); cancel.hidden = false;
        say('Generating in Draw Things on this computer…');
        const returned = await generateViaHttp(request, { signal: controller.signal });
        await finish(request, returned);
      }
    } catch (error) { say(error.message || 'Generation failed', true); }
    finally { controller = null; cancel.hidden = true; go.disabled = false; }
  };
  cancel.onclick = () => controller?.abort();
  void renderJobs();
  return true;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountDrawThingsGeneration(), { once: true });
  else mountDrawThingsGeneration();
}

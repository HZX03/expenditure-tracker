/* ======================================================================
   CONFIG — edit these two after you deploy
   ====================================================================== */
const CONFIG = {
  // Your Cloudflare Worker URL from `wrangler deploy` (no trailing slash).
  API_BASE: 'https://expenditure-tracker-api.expenditure-tracker.workers.dev',
  // Your own OAuth client ID, created in Google Cloud Console for this app.
  GOOGLE_CLIENT_ID: '572760733608-2doa5cv817dcib9m928it6r9sq2blil4.apps.googleusercontent.com',
  GOOGLE_ACCOUNT_HINT: '', // optional: your email, skips the account picker
};

const DEFAULT_CATEGORIES = ["Food & Dining","Groceries","Transport","Housing & Utilities","Shopping","Health","Entertainment","Travel","Education","Subscriptions","Fees & Charges","Other"];
const CURRENCIES = ["SGD","USD","EUR","GBP","JPY","MYR","AUD","CNY","IDR","THB"];
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
const DRIVE_FILE_NAME = 'expenditure-tracker-data.json';
const DRIVE_FOLDER_NAME = 'Expenditure Tracker';

/* ======================================================================
   STATE
   ====================================================================== */
let state = { transactions: [], categories: DEFAULT_CATEGORIES.slice(), loans: [], fx: [], imports: [] };
let tab = 'transactions';
let txAiMeta = null;      // { confidence, reasoning } for the form currently open
let txAiSuggested = false;
let selectedTxIds = new Set();   // rows ticked in the transaction list (always a subset of what is shown)
let visibleTxIds = [];           // ids currently shown, in on-screen order (used for shift-click ranges)
let lastSelectedTxId = null;
let bulkCategory = '';           // category chosen in the bulk bar
let bulkSecondary = '';           // text typed in the bulk bar's secondary-category box
let bulkNotice = '', bulkUndo = null;   // bulkUndo = { undo() -> number restored } for the last bulk action
let importBatches = [];   // set of PDFs currently being read/reviewed in the import panel

function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function fmtMoney(n){ return (Math.round((Number(n)||0)*100)/100).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
// Dates are the one AI-supplied value that used to reach the page unchecked. Anything that
// claims to be a date must pass this before it is stored, and it is still esc()'d on output.
function isValidISODate(v){
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0,10) === v;
}
// dd/mm/yy <-> ISO, for the statement review table. The app stores ISO (YYYY-MM-DD) everywhere; this is
// display/entry only. Two-digit years mean 20yy; anything outside 2000-2099 is shown with four digits.
function isoToDMY(iso){
  if (!isValidISODate(iso)) return '';
  const y = Number(iso.slice(0,4));
  return iso.slice(8,10) + '/' + iso.slice(5,7) + '/' + ((y >= 2000 && y <= 2099) ? iso.slice(2,4) : iso.slice(0,4));
}
function parseDMY(str){
  const s = String(str == null ? '' : str).trim();
  if (isValidISODate(s)) return s;                       // also accept a pasted YYYY-MM-DD
  const m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/);
  if (!m) return '';
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const iso = String(y).padStart(4,'0') + '-' + m[2].padStart(2,'0') + '-' + m[1].padStart(2,'0');
  return isValidISODate(iso) ? iso : '';
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ======================================================================
   GOOGLE DRIVE AUTH + PERSISTENCE  (same pattern as the task tracker app)
   ====================================================================== */
let driveFolderId = null, tokenClient = null, driveAccessToken = null, driveFileId = null;
let appStarted = false, silentAttemptDone = false, saveTimer = null;

function waitForGoogleIdentity(cb, attempts){
  attempts = attempts || 0;
  if (window.google && google.accounts && google.accounts.oauth2) cb();
  else if (attempts < 50) setTimeout(() => waitForGoogleIdentity(cb, attempts+1), 100);
  else { setAuthStatus('Could not load Google Sign-In. Check your connection and reload.', true); revealSignInButton(); }
}
function initGoogleAuth(){
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    hint: CONFIG.GOOGLE_ACCOUNT_HINT || undefined,
    callback: (resp) => { if (resp && resp.access_token){ driveAccessToken = resp.access_token; setAuthStatus(''); onSignedIn(); } else handleAuthAttemptFailed(); },
    error_callback: () => handleAuthAttemptFailed(),
  });
  setAuthStatus('Signing you in…');
  tokenClient.requestAccessToken({ prompt: '' });
}
function handleAuthAttemptFailed(){
  if (!silentAttemptDone){ silentAttemptDone = true; setAuthStatus(''); revealSignInButton(); }
  else setAuthStatus('Sign-in failed or was cancelled. Please try again.', true);
}
function revealSignInButton(){
  document.getElementById('signInBtn').style.display = 'inline-block';
  document.getElementById('authGateText').textContent = 'Sign in with Google to load and sync your ledger via Google Drive.';
}
function setAuthStatus(msg, isError){
  const el = document.getElementById('authStatus');
  el.textContent = msg || ''; el.className = 'auth-status' + (isError ? ' error' : '');
}
function signIn(){
  if (!tokenClient){ setAuthStatus('Still loading Google Sign-In — try again in a moment.', true); return; }
  silentAttemptDone = true; setAuthStatus('Opening Google sign-in…'); tokenClient.requestAccessToken();
}
function signOut(){
  if (driveAccessToken && window.google) { try { google.accounts.oauth2.revoke(driveAccessToken, () => {}); } catch(e){} }
  driveAccessToken = null; driveFileId = null; driveFolderId = null; appStarted = false; silentAttemptDone = true;
  document.getElementById('authGate').style.display = 'flex'; revealSignInButton(); setAuthStatus('');
}
function onSignedIn(){
  if (appStarted) return; appStarted = true;
  document.getElementById('authGate').style.display = 'none';
  loadState();
}
async function driveFetch(url, options){
  options = options || {};
  options.headers = Object.assign({}, options.headers, { Authorization: `Bearer ${driveAccessToken}` });
  let res = await fetch(url, options);
  if (res.status === 401){ await refreshDriveToken(); options.headers.Authorization = `Bearer ${driveAccessToken}`; res = await fetch(url, options); }
  return res;
}
function refreshDriveToken(){
  return new Promise((resolve, reject) => {
    if (!tokenClient){ reject(new Error('No token client')); return; }
    const prev = tokenClient.callback;
    tokenClient.callback = (resp) => { tokenClient.callback = prev; if (resp && resp.access_token){ driveAccessToken = resp.access_token; resolve(); } else reject(new Error('Silent refresh failed')); };
    tokenClient.requestAccessToken({ prompt: '' });
  });
}
async function driveFindOrCreateFolder(){
  const q = encodeURIComponent(`name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`);
  if (!res.ok) throw new Error('Drive folder search failed: ' + res.status);
  const data = await res.json();
  if (data.files && data.files[0]) return data.files[0].id;
  const createRes = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }) });
  if (!createRes.ok) throw new Error('Drive folder create failed: ' + createRes.status);
  return (await createRes.json()).id;
}
async function driveFindFile(){
  if (!driveFolderId) driveFolderId = await driveFindOrCreateFolder();
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false and '${driveFolderId}' in parents`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`);
  if (!res.ok) throw new Error('Drive search failed: ' + res.status);
  const data = await res.json();
  return (data.files && data.files[0]) ? data.files[0].id : null;
}
async function driveGetFileContent(fileId){
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  if (!res.ok) throw new Error('Drive read failed: ' + res.status);
  return await res.text();
}
async function driveCreateFile(content){
  if (!driveFolderId) driveFolderId = await driveFindOrCreateFolder();
  const metadata = { name: DRIVE_FILE_NAME, mimeType: 'application/json', parents: [driveFolderId] };
  const boundary = 'expenditure_tracker_boundary_9d2e';
  const delimiter = '\r\n--' + boundary + '\r\n', closeDelim = '\r\n--' + boundary + '--';
  const body = delimiter + 'Content-Type: application/json\r\n\r\n' + JSON.stringify(metadata) + delimiter + 'Content-Type: application/json\r\n\r\n' + content + closeDelim;
  const res = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method:'POST', headers:{'Content-Type':`multipart/related; boundary="${boundary}"`}, body });
  if (!res.ok) throw new Error('Drive create failed: ' + res.status);
  return (await res.json()).id;
}
async function driveUpdateFile(fileId, content){
  const res = await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: content });
  if (!res.ok) throw new Error('Drive update failed: ' + res.status);
  return true;
}
// Defensive shaping of the saved ledger: right types, dates always strings. Values are still
// esc()'d wherever they are rendered; this just stops odd data from throwing in string methods.
function normalizeLoadedState(parsed){
  const base = { transactions: [], categories: DEFAULT_CATEGORIES.slice(), loans: [], fx: [], imports: [] };
  const src = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  const out = Object.assign(base, src);
  const objs = v => (Array.isArray(v) ? v : []).filter(x => x && typeof x === 'object');
  const str = v => (v == null ? '' : String(v));
  out.transactions = objs(out.transactions).map(t => Object.assign({}, t, { date: str(t.date) }));
  out.loans = objs(out.loans).map(l => Object.assign({}, l, {
    date: str(l.date), dueDate: l.dueDate ? str(l.dueDate) : null,
    payments: objs(l.payments).map(p => Object.assign({}, p, { date: str(p.date) })),
  }));
  out.fx = objs(out.fx).map(r => Object.assign({}, r, { date: str(r.date) }));
  out.imports = objs(out.imports).map(i => Object.assign({}, i, { txIds: Array.isArray(i.txIds) ? i.txIds : [] }));
  out.categories = (Array.isArray(out.categories) ? out.categories : []).map(str).filter(Boolean);
  if (out.categories.length === 0) out.categories = DEFAULT_CATEGORIES.slice();
  return out;
}
async function loadState(){
  let loaded = false;
  for (let attempt = 1; attempt <= 3 && !loaded; attempt++){
    try {
      driveFileId = await driveFindFile();
      if (driveFileId){
        const text = await driveGetFileContent(driveFileId);
        if (text){ state = normalizeLoadedState(JSON.parse(text)); }
      }
      loaded = true;
    } catch(e){ console.log(`Drive load attempt ${attempt}/3 failed:`, e); if (attempt < 3) await new Promise(r => setTimeout(r, 400*attempt)); }
  }
  populateStaticSelects();
  renderAll();
  setSaveBadge('idle');
}
function saveState(){
  setSaveBadge('pending');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSaveState, 800);
}
async function doSaveState(){
  setSaveBadge('saving');
  try {
    const content = JSON.stringify(state);
    if (driveFileId) await driveUpdateFile(driveFileId, content);
    else driveFileId = await driveCreateFile(content);
    setSaveBadge('idle');
  } catch(e){ console.log('Save failed:', e); setSaveBadge('error'); }
}
function setSaveBadge(mode){
  const el = document.getElementById('saveBadge');
  if (mode === 'pending' || mode === 'saving') el.textContent = 'Saving…';
  else if (mode === 'error') el.textContent = '⚠ Save failed — will retry';
  else el.textContent = '✓ Synced to Drive';
}

/* ======================================================================
   AI — classify one item, or parse a whole statement, via the Worker
   ====================================================================== */
function recentHistory(){
  // The "training data": every description -> category the user has ever
  // saved, most recent first. No separate correction log needed — the
  // ledger itself is the training set, and it grows on every save.
  return state.transactions.slice(0, 200).map(t => ({ description: t.description, category: t.category }));
}
async function callWorker(path, body){
  if (!driveAccessToken) throw new Error('Not signed in');
  const res = await fetch(CONFIG.API_BASE + path, {
    method:'POST',
    headers:{'Content-Type':'application/json', 'Authorization': `Bearer ${driveAccessToken}`},
    body: JSON.stringify(body),
  });
  if (!res.ok){
    let detail = '';
    try { const errBody = await res.json(); detail = errBody && errBody.error ? errBody.error : ''; } catch(e){}
    if (res.status === 403) throw new Error(detail || 'Not authorized to use this AI backend');
    throw new Error(detail || ('Worker error ' + res.status));
  }
  return res.json();
}
async function classifyItem(description, amount, currency){
  return callWorker('/classify', { description, amount, currency, categories: state.categories, history: recentHistory() });
}
async function parseStatementPdf(base64, mimeType){
  const result = await callWorker('/parse-statement', { pdfBase64: base64, mimeType, categories: state.categories, history: recentHistory() });
  return normalizeStatementRows(result);
}
// Same as parseStatementPdf but sends pre-extracted, PII-redacted text
// instead of the raw PDF bytes — see extractAndRedactPdf() below.
async function parseStatementText(text){
  const result = await callWorker('/parse-statement', { text, categories: state.categories, history: recentHistory() });
  return normalizeStatementRows(result);
}
function normalizeStatementRows(result){
  // Everything below came from a model reading an untrusted document, so nothing is taken at face value.
  const list = (result && Array.isArray(result.transactions)) ? result.transactions : [];
  const rows = list.filter(r => r && typeof r === 'object').map(r => ({
    rowId: uid(),
    // Unreadable or malformed date -> blank + flagged in the review table; the row can't be imported until fixed.
    date: isValidISODate(r.date) ? r.date : '',
    description: r.item == null ? '' : String(r.item),
    amount: Number(r.amount)||0,
    currency: CURRENCIES.includes(r.currency) ? r.currency : 'SGD',
    category: state.categories.includes(r.category) ? r.category : 'Other',
    confidence: (typeof r.confidence === 'number' && isFinite(r.confidence)) ? Math.max(0, Math.min(100, Math.round(r.confidence))) : null,
    selected: true,
  }));
  const name = (result && typeof result.suggestedName === 'string') ? result.suggestedName.trim() : '';
  return { suggestedName: name, rows };
}
function fileToBase64(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

/* ======================================================================
   CLIENT-SIDE PDF TEXT EXTRACTION + PII REDACTION
   Runs entirely in the browser, before anything is sent to Gemini. Only
   for PDFs (they have a real text layer to work with) — photos still go
   through as full images, since there's no text to extract client-side.
   This is a best-effort redaction, not a guarantee: it catches labeled
   fields (account numbers, IBAN, sort code, card numbers) reliably, and
   a common "Mr/Mrs/Ms Name + address block" pattern heuristically. It
   won't catch every possible statement layout.
   ====================================================================== */
let pdfWorkerConfigured = false;
function ensurePdfWorker(){
  if (pdfWorkerConfigured || typeof pdfjsLib === 'undefined') return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.js', document.baseURI).href;
  pdfWorkerConfigured = true;
}
async function extractPdfText(file){
  if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js not available');
  ensurePdfWorker();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(' ') + '\n\n';
  }
  return text;
}
function redactPii(text){
  let out = text;
  // Labeled identifiers — high-precision, anchored to their field name.
  // The "value" portion is restricted to the SAME LINE only (space/tab,
  // never \n) — an earlier version used \s here, which is a newline too,
  // and could greedily eat into the next line's actual transaction date.
  out = out.replace(/(IBAN|International Bank Account Number)[ \t]*[:\s][ \t]*[A-Z0-9]{10,34}/gi, '$1: [REDACTED]');
  out = out.replace(/(Bank Identifier Code|BIC|SWIFT(?:\s*code)?)[ \t]*[:\s][ \t]*[A-Z0-9]{6,11}/gi, '$1: [REDACTED]');
  out = out.replace(/(Account\s*(?:No\.?|Number)|Acc(?:ount)?\s*No\.?)[ \t]*[:\s]?[ \t]*[\d][\d\- \t]{2,18}\d/gi, '$1: [REDACTED]');
  out = out.replace(/(Sort\s*[Cc]ode)[ \t]*[:\s]?[ \t]*[\d][\d\- \t]{2,10}\d/gi, '$1: [REDACTED]');
  out = out.replace(/\bS\/N[ \t]*[:\s]?[ \t]*[A-Z0-9]{6,}/gi, 'S/N: [REDACTED]');
  // Card-like number sequences (12-19 digits, optionally grouped/dashed) —
  // also same-line only, for the same reason as above.
  out = out.replace(/\b(?:\d[ -]?){12,19}\b/g, '[REDACTED]');
  // "Mr/Mrs/Ms/Dr Name" salutation followed by the next few short lines
  // (the usual shape of a mailing-address block on a bank letter).
  out = out.replace(/((?:Mr|Mrs|Ms|Dr)\.?\s+[A-Z][A-Za-z .'-]+)(\n[^\n]{0,60}){1,4}/g, '[NAME/ADDRESS REDACTED]');
  // Any other bare run of 6+ digits (account/reference/phone numbers) —
  // safe against amounts and dates, which break up into shorter groups
  // around a decimal point or slash.
  out = out.replace(/\b\d{6,}\b/g, '[REDACTED]');
  return out;
}
// Some PDFs embed decorative or barcode/QR "fonts" (common in the footer of
// bank statements) that pdf.js reads as garbled, sometimes invalid Unicode
// (stray symbols, lone surrogate halves) rather than real text. Left in,
// that can make the outbound request to Gemini fail outright. This strips
// control characters and any unpaired surrogate code units before the text
// goes anywhere.
function sanitizeExtractedText(text){
  let out = text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  // Decorative/barcode fonts (common in statement footers, e.g. next to a
  // QR code) render as long runs of near-gibberish when read as "text" by
  // pdf.js. Real prose has a fairly consistent vowel density; this garbage
  // doesn't. Drop any line over 15 characters where vowels make up less
  // than 8% of the line — comfortably below normal English text, even
  // dense transaction lines full of numbers and codes, but well above what
  // font-rendering noise produces.
  out = out.split('\n').filter(line => {
    if (line.length <= 15) return true;
    const vowels = (line.match(/[aeiouAEIOU]/g) || []).length;
    return vowels / line.length >= 0.10;
  }).join('\n');
  return out;
}
// Tries the redact-and-send-text path; falls back to sending the original
// PDF whole if extraction fails or the PDF turns out to have no real text
// layer (e.g. a scanned statement saved as PDF).
async function extractAndRedactPdf(file){
  try {
    let text = await extractPdfText(file);
    text = sanitizeExtractedText(text);
    if (text.trim().length < 200) throw new Error('Too little text extracted — likely a scanned PDF');
    // Generous cap — a normal multi-page statement is nowhere near this;
    // this only guards against something like a barcode font blowing the
    // extracted text up with repeated junk.
    if (text.length > 200000) text = text.slice(0, 200000);
    return { text: redactPii(text) };
  } catch (e){
    const base64 = await fileToBase64(file);
    return { base64, fallback: true };
  }
}

/* ======================================================================
   TABS
   ====================================================================== */
function setTab(t){
  tab = t;
  ['transactions','loans','fx','imports','breakdown'].forEach(id => {
    document.getElementById('view-' + id).classList.toggle('active', id === t);
    document.getElementById('tabBtn-' + id).classList.toggle('active', id === t);
  });
  if (t === 'imports') renderImportsList();
  if (t === 'breakdown') renderBreakdown();
}

/* ======================================================================
   STATIC SELECT POPULATION (run once after load)
   ====================================================================== */
function populateStaticSelects(){
  const currencySelects = ['tx-currency','loan-currency','fx-from-cur','fx-to-cur'];
  currencySelects.forEach(id => {
    const el = document.getElementById(id);
    el.innerHTML = CURRENCIES.map(c => `<option value="${c}">${c}</option>`).join('');
  });
  document.getElementById('fx-to-cur').value = CURRENCIES[1] || CURRENCIES[0];
  const filterCat = document.getElementById('tx-filter-cat');
  filterCat.innerHTML = '<option value="">All categories</option>' + state.categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  const filterCur = document.getElementById('tx-filter-currency');
  filterCur.innerHTML = '<option value="">All currencies</option>' + CURRENCIES.map(c => `<option value="${c}">${c}</option>`).join('');
  const breakdownCur = document.getElementById('breakdown-currency');
  breakdownCur.innerHTML = CURRENCIES.map(c => `<option value="${c}">${c}</option>`).join('');
}
/* ---- Creating new categories ----
   Every category dropdown ends with "+ New category…". Picking it asks for a name (promptForNewCategory),
   adds it to state.categories (saved to Drive with the rest of the ledger), and selects it. The AI sees the
   new category straight away because every AI call already sends state.categories. */
const NEW_CATEGORY_VALUE = '__new_category__';   // value of the "+ New category…" option; never accepted as a real name
const MAX_CATEGORY_LENGTH = 40;
function categoryOptions(selected){
  return '<option value="">Select…</option>' + state.categories.map(c => `<option value="${esc(c)}" ${c===selected?'selected':''}>${esc(c)}</option>`).join('')
    + `<option value="${NEW_CATEGORY_VALUE}">+ New category…</option>`;
}
function cleanCategoryName(raw){
  return String(raw == null ? '' : raw).replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function refreshCategoryFilter(){
  const el = document.getElementById('tx-filter-cat');
  if (!el) return;
  const current = el.value;
  el.innerHTML = '<option value="">All categories</option>' + state.categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  el.value = current;
}
// Returns the category to use, or null if the person cancelled / gave nothing usable. A name that matches an
// existing category (ignoring case) reuses that one rather than creating a near-duplicate. New ones are placed
// just before "Other" so "Other" stays last.
function promptForNewCategory(){
  const raw = prompt(`Name for the new category (max ${MAX_CATEGORY_LENGTH} characters):`);
  if (raw === null) return null;
  const name = cleanCategoryName(raw);
  if (!name || name === NEW_CATEGORY_VALUE) return null;
  if (name.length > MAX_CATEGORY_LENGTH){ alert(`Category names can be at most ${MAX_CATEGORY_LENGTH} characters — that one is ${name.length}.`); return null; }
  const existing = state.categories.find(c => c.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const otherAt = state.categories.indexOf('Other');
  if (otherAt >= 0) state.categories.splice(otherAt, 0, name); else state.categories.push(name);
  saveState();
  refreshCategoryFilter();
  return name;
}
// Import review: add the new option to every row's dropdown in place (a full re-render would reset scroll and
// any half-typed edits). Built with DOM calls, not HTML strings.
function addCategoryOptionToReviewSelects(name){
  document.querySelectorAll('#import-panel select[data-field="category"]').forEach(sel => {
    if (Array.from(sel.options).some(o => o.value === name)) return;
    const opt = document.createElement('option'); opt.value = name; opt.textContent = name;
    const marker = Array.from(sel.options).find(o => o.value === NEW_CATEGORY_VALUE);
    sel.insertBefore(opt, marker || null);
  });
}

/* ======================================================================
   TRANSACTIONS
   ====================================================================== */
function renderAll(){ renderTxSummary(); renderTxList(); renderLoanList(); renderFxList(); }

function openTxForm(editTx){
  document.getElementById('import-panel').style.display = 'none';
  const f = document.getElementById('tx-form');
  f.style.display = 'grid';
  document.getElementById('tx-id').value = editTx ? editTx.id : '';
  document.getElementById('tx-date').value = editTx ? editTx.date : todayISO();
  document.getElementById('tx-currency').value = editTx ? editTx.currency : 'SGD';
  document.getElementById('tx-amount').value = editTx ? editTx.amount : '';
  document.getElementById('tx-item').value = editTx ? editTx.description : '';
  document.getElementById('tx-secondary').value = editTx ? (editTx.secondary || '') : '';
  document.getElementById('tx-comment').value = editTx ? (editTx.comment || '') : '';
  document.getElementById('tx-submit-btn').textContent = editTx ? 'Save changes' : 'Add transaction';
  txAiMeta = null; txAiSuggested = editTx ? !!editTx.aiSuggested : false;
  renderTxCatPicker(editTx ? editTx.category : '');
  document.getElementById('tx-ai-note').style.display = 'none';
  f.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function closeTxForm(){ document.getElementById('tx-form').style.display = 'none'; }

function renderTxCatPicker(selected){
  const el = document.getElementById('tx-cat-picker');
  if (!selected){
    el.innerHTML = `<button type="button" class="chip-btn" data-click="editTxCatPicker"><span class="chip chip-muted">No category yet — click to set</span></button><input type="hidden" id="tx-category" value="">`;
  } else {
    el.innerHTML = `<button type="button" class="chip-btn" data-click="editTxCatPicker"><span class="chip ${txAiSuggested?'chip-ai':''}">${txAiSuggested?'✨ ':''}${esc(selected)}</span></button><input type="hidden" id="tx-category" value="${esc(selected)}">`;
  }
}
function editTxCatPicker(){
  const el = document.getElementById('tx-cat-picker');
  const current = document.getElementById('tx-category').value;
  el.innerHTML = `<select id="tx-category" autofocus data-change="onTxCatPicked" data-blur="onTxCatPicked" data-prev="${esc(current)}">${categoryOptions(current)}</select>`;
  document.getElementById('tx-category').focus();
}
function onTxCatPicked(val){ txAiSuggested = false; renderTxCatPicker(val); }
function onTxItemChanged(){ document.getElementById('tx-ai-note').style.display = 'none'; }

async function suggestTxCategory(){
  const item = document.getElementById('tx-item').value.trim();
  if (!item) return;
  const btn = document.getElementById('tx-suggest-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spin">↻</span> Thinking…';
  try {
    const amount = document.getElementById('tx-amount').value;
    const currency = document.getElementById('tx-currency').value;
    const result = await classifyItem(item, amount, currency);
    txAiMeta = result; txAiSuggested = true;
    renderTxCatPicker(result.category);
    const note = document.getElementById('tx-ai-note');
    note.style.display = 'block';
    note.textContent = `AI suggestion · ${result.confidence}% confident — ${result.reasoning}`;
  } catch(e){
    const note = document.getElementById('tx-ai-note');
    note.style.display = 'block'; note.className = 'ai-note ai-note-error';
    note.textContent = "Couldn't reach the classifier — pick a category manually.";
  } finally {
    btn.disabled = false; btn.innerHTML = '✨ Suggest';
  }
}

function submitTxForm(e){
  e.preventDefault();
  const id = document.getElementById('tx-id').value || uid();
  const tx = {
    id,
    date: document.getElementById('tx-date').value,
    description: document.getElementById('tx-item').value.trim(),
    amount: Number(document.getElementById('tx-amount').value),
    currency: document.getElementById('tx-currency').value,
    category: document.getElementById('tx-category').value || 'Other',
    secondary: document.getElementById('tx-secondary').value.trim(),
    comment: document.getElementById('tx-comment').value.trim(),
    aiSuggested: txAiSuggested,
    aiConfidence: txAiMeta ? txAiMeta.confidence : null,
    aiReasoning: txAiMeta ? txAiMeta.reasoning : null,
    aiOverridden: false,
  };
  const idx = state.transactions.findIndex(t => t.id === id);
  if (idx >= 0) state.transactions[idx] = tx; else state.transactions.unshift(tx);
  closeTxForm(); saveState(); renderTxSummary(); renderTxList();
}
function deleteTx(id){
  if (!confirm('Delete this transaction?')) return;
  state.transactions = state.transactions.filter(t => t.id !== id);
  saveState(); renderTxSummary(); renderTxList();
}
function correctTxCategory(id, newCategory){
  const tx = state.transactions.find(t => t.id === id);
  if (!tx || tx.category === newCategory) return;
  tx.category = newCategory; tx.aiOverridden = !!tx.aiSuggested;
  saveState(); renderTxList();
}
/* ---- Bulk category change ----
   Tick rows (shift-click for a range, or "Select all shown"), pick a category, press Set category. Only rows that are
   currently shown can be selected, so what you see ticked is exactly what changes. Undo restores the previous
   categories (skipping any row you have edited since). */
function syncSelectionUI(){
  document.querySelectorAll('#tx-list .tx-select').forEach(cb => { cb.checked = selectedTxIds.has(cb.dataset.id); });
  renderBulkBar();
}
function resetBulkNotice(){ bulkNotice = ''; bulkUndo = null; }
function toggleTxSelection(id, checked, shift){
  resetBulkNotice();
  const ids = [id];
  if (shift && lastSelectedTxId && visibleTxIds.includes(lastSelectedTxId) && visibleTxIds.includes(id)){
    const a = visibleTxIds.indexOf(lastSelectedTxId), b = visibleTxIds.indexOf(id);
    ids.length = 0; visibleTxIds.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => ids.push(x));
    if (window.getSelection) window.getSelection().removeAllRanges();    // shift-click also highlights text; don't
  }
  ids.forEach(x => { if (checked) selectedTxIds.add(x); else selectedTxIds.delete(x); });
  lastSelectedTxId = id;
  syncSelectionUI();
}
function selectAllShown(on){
  resetBulkNotice();
  selectedTxIds = on ? new Set(visibleTxIds) : new Set();
  syncSelectionUI();
}
const MAX_SECONDARY_LENGTH = 60;
function existingSecondaryTags(){
  return [...new Set(state.transactions.map(t => String(t.secondary || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
function renderBulkBar(){
  const bar = document.getElementById('bulk-bar');
  if (!bar) return;
  const total = visibleTxIds.length, n = selectedTxIds.size;
  if (total === 0){ bar.className = 'bulk-bar'; bar.innerHTML = ''; return; }
  bar.className = 'bulk-bar' + (n ? ' bulk-active' : '');
  bar.innerHTML = `
    <label class="bulk-all"><input type="checkbox" data-change="txSelectAll" ${n === total ? 'checked' : ''}> Select all ${total} shown</label>
    ${n ? `
      <span class="bulk-count">${n} selected</span>
      <span class="bulk-group">
        <select id="bulk-category" data-change="bulkCategoryChanged" title="Category to give the selected transactions">${categoryOptions(bulkCategory)}</select>
        <button type="button" class="btn-primary btn-sm" data-click="bulkApply" ${bulkCategory ? '' : 'disabled'}>Set category</button>
      </span>
      <span class="bulk-group">
        <input type="text" id="bulk-secondary" list="bulk-secondary-list" maxlength="${MAX_SECONDARY_LENGTH}" placeholder="Secondary category…" value="${esc(bulkSecondary)}" data-input="bulkSecondaryInput" data-keydown="bulkSecondaryKey" title="Secondary category to give the selected transactions (e.g. Spain Holiday)">
        <datalist id="bulk-secondary-list">${existingSecondaryTags().map(t => `<option value="${esc(t)}"></option>`).join('')}</datalist>
        <button type="button" class="btn-primary btn-sm" data-click="bulkSetSecondary" ${cleanCategoryName(bulkSecondary) ? '' : 'disabled'}>Set secondary</button>
        <button type="button" class="btn-ghost btn-sm" data-click="bulkClearSecondary" title="Remove the secondary category from the selected transactions">Clear secondary</button>
      </span>
      <button type="button" class="btn-ghost btn-sm" data-click="bulkClear">Clear selection</button>` : ''}
    ${bulkNotice ? `<span class="bulk-msg">${esc(bulkNotice)}${bulkUndo ? ' <button type="button" class="link-btn" data-click="bulkUndo">Undo</button>' : ''}</span>` : ''}`;
  bar.querySelector('.bulk-all input').indeterminate = n > 0 && n < total;
}
// The selection stays ticked after applying, so you can set a category and then a secondary category (or the
// other way round) on the same rows. Undo reverses only the most recent bulk action.
function applyBulkCategory(){
  const category = bulkCategory;
  if (!category || selectedTxIds.size === 0) return;
  const picked = selectedTxIds.size, changes = [];
  state.transactions.forEach(tx => {
    if (!selectedTxIds.has(tx.id) || tx.category === category) return;
    changes.push({ id: tx.id, prevCategory: tx.category, prevOverridden: tx.aiOverridden, newCategory: category });
    tx.category = category; tx.aiOverridden = !!tx.aiSuggested;        // same rule as changing one row by hand
  });
  const same = picked - changes.length;
  bulkNotice = changes.length
    ? `${changes.length} changed to \u201C${category}\u201D` + (same ? `, ${same} already had it.` : '.')
    : `Nothing to change \u2014 all ${picked} already \u201C${category}\u201D.`;
  bulkUndo = changes.length ? { undo: () => {
    let restored = 0;
    changes.forEach(c => {
      const tx = state.transactions.find(t => t.id === c.id);
      if (tx && tx.category === c.newCategory){ tx.category = c.prevCategory; tx.aiOverridden = c.prevOverridden; restored++; }   // skip rows edited since
    });
    return restored;
  } } : null;
  bulkCategory = '';
  if (changes.length) saveState();
  renderTxList();
}
function applyBulkSecondary(clear){
  if (selectedTxIds.size === 0) return;
  let value = '';
  if (!clear){
    value = cleanCategoryName(bulkSecondary);
    if (!value) return;
    if (value.length > MAX_SECONDARY_LENGTH){ alert(`Secondary categories can be at most ${MAX_SECONDARY_LENGTH} characters \u2014 that one is ${value.length}.`); return; }
    value = existingSecondaryTags().find(t => t.toLowerCase() === value.toLowerCase()) || value;   // reuse an existing spelling
  }
  const picked = selectedTxIds.size, changes = [];
  state.transactions.forEach(tx => {
    if (!selectedTxIds.has(tx.id)) return;
    const prev = tx.secondary || '';
    if (prev === value) return;
    changes.push({ id: tx.id, prev, next: value });
    tx.secondary = value;
  });
  const same = picked - changes.length;
  bulkNotice = changes.length
    ? (clear ? `${changes.length} cleared.` : `${changes.length} set to \u201C${value}\u201D` + (same ? `, ${same} already had it.` : '.'))
    : (clear ? `Nothing to clear \u2014 none of the ${picked} had a secondary category.` : `Nothing to change \u2014 all ${picked} already \u201C${value}\u201D.`);
  bulkUndo = changes.length ? { undo: () => {
    let restored = 0;
    changes.forEach(c => {
      const tx = state.transactions.find(t => t.id === c.id);
      if (tx && (tx.secondary || '') === c.next){ tx.secondary = c.prev; restored++; }
    });
    return restored;
  } } : null;
  bulkSecondary = '';
  if (changes.length) saveState();
  renderTxList();
}
function undoBulk(){
  if (!bulkUndo) return;
  const restored = bulkUndo.undo();
  bulkUndo = null; bulkNotice = restored ? `Undone \u2014 ${restored} restored.` : 'Nothing to undo.';
  if (restored) saveState();
  renderTxList();
}
function toggleTxComment(id){
  const row = document.querySelector(`.tx-row[data-id="${CSS.escape(id)}"]`);
  const box = row.querySelector('.tx-comment');
  box.style.display = box.style.display === 'none' ? 'block' : 'none';
}

function renderTxSummary(){
  const totals = {};
  state.transactions.forEach(t => { totals[t.currency] = (totals[t.currency]||0) + Number(t.amount); });
  const el = document.getElementById('tx-summary');
  const entries = Object.entries(totals);
  el.innerHTML = entries.length === 0 ? '<span class="muted">No transactions yet.</span>' :
    entries.map(([cur,val]) => `<div class="summary-pill"><span class="summary-cur">${esc(cur)} NET</span><span class="mono summary-val${val<0?' neg':(val>0?' pos':'')}">${fmtMoney(val)}</span></div>`).join('') +
    '<span class="muted" style="align-self:center;">— expenses in red, income offsets them. See Breakdown for net by category and month.</span>';
}

function clearTxFilters(){
  document.getElementById('tx-filter-cat').value = '';
  document.getElementById('tx-filter-currency').value = '';
  document.getElementById('tx-filter-secondary').value = '';
  document.getElementById('tx-filter-search').value = '';
  document.getElementById('tx-filter-date-from').value = '';
  document.getElementById('tx-filter-date-to').value = '';
  document.getElementById('tx-filter-import').value = '';
  renderTxList();
}
function applyTxFilters(list){
  const cat = document.getElementById('tx-filter-cat').value;
  const cur = document.getElementById('tx-filter-currency').value;
  const sec = document.getElementById('tx-filter-secondary').value.trim().toLowerCase();
  const search = document.getElementById('tx-filter-search').value.trim().toLowerCase();
  const from = document.getElementById('tx-filter-date-from').value;
  const to = document.getElementById('tx-filter-date-to').value;
  const importId = document.getElementById('tx-filter-import').value;
  return list.filter(t => {
    if (cat && t.category !== cat) return false;
    if (cur && t.currency !== cur) return false;
    if (sec && !(t.secondary || '').toLowerCase().includes(sec)) return false;
    if (search && !(t.description || '').toLowerCase().includes(search)) return false;
    if (from && t.date < from) return false;
    if (to && t.date > to) return false;
    if (importId && t.importId !== importId) return false;
    return true;
  });
}
function updateTxFilterSummary(shownCount, totalCount){
  const el = document.getElementById('tx-filter-summary');
  const importId = document.getElementById('tx-filter-import').value;
  if (shownCount === totalCount && !importId){ el.textContent = ''; return; }
  el.innerHTML = `Showing ${shownCount} of ${totalCount}` + (importId ? ` <button type="button" class="link-btn" data-click="clearImportFilter">— clear import filter</button>` : '');
}
function renderTxList(){
  const filtered = applyTxFilters(state.transactions);
  updateTxFilterSummary(filtered.length, state.transactions.length);
  const byDate = {};
  filtered.forEach(t => { (byDate[t.date] ||= []).push(t); });
  const dates = Object.keys(byDate).sort().reverse();
  visibleTxIds = dates.flatMap(d => byDate[d].map(t => t.id));
  const visible = new Set(visibleTxIds);
  selectedTxIds.forEach(id => { if (!visible.has(id)) selectedTxIds.delete(id); });   // never act on rows you can't see
  renderBulkBar();
  const el = document.getElementById('tx-list');
  if (dates.length === 0){
    el.innerHTML = state.transactions.length === 0
      ? `<div class="empty-state">🧾<p>No transactions logged yet. Add one, or import a bank statement — the assistant will suggest categories using your own history.</p></div>`
      : `<div class="empty-state">🔍<p>No transactions match these filters.</p></div>`;
    return;
  }
  el.innerHTML = dates.map(date => `
    <div class="tx-group-date mono">${esc(date)}</div>
    ${byDate[date].map(renderTxRowHtml).join('')}
  `).join('');
}
function renderTxRowHtml(tx){
  const aiOn = tx.aiSuggested && !tx.aiOverridden;
  return `
  <div class="tx-row" data-id="${esc(tx.id)}">
    <input type="checkbox" class="tx-select" data-click="txSelectRow" data-id="${esc(tx.id)}" ${selectedTxIds.has(tx.id) ? 'checked' : ''} aria-label="Select this transaction">
    <div class="tx-date mono">${esc(tx.date)}</div>
    <div class="tx-main">
      <div class="tx-desc">${esc(tx.description)}</div>
      <div class="tx-tags">
        <span class="cat-cell">
          <button class="chip-btn" data-click="startCatEdit" data-id="${esc(tx.id)}"><span class="chip ${aiOn?'chip-ai':''}">${aiOn?'✨ ':''}${esc(tx.category)}</span></button>
        </span>
        ${tx.secondary ? `<span class="chip chip-muted">${esc(tx.secondary)}</span>` : ''}
      </div>
    </div>
    <div class="tx-amount mono${Number(tx.amount) < 0 ? ' neg' : ' pos'}">${esc(tx.currency)} ${fmtMoney(tx.amount)}</div>
    <div class="tx-actions">
      <button class="icon-btn" title="Comment" data-click="toggleTxComment" data-id="${esc(tx.id)}">💬</button>
      <button class="icon-btn" title="Edit" data-click="editTx" data-id="${esc(tx.id)}">✎</button>
      <button class="icon-btn icon-btn-danger" title="Delete" data-click="deleteTx" data-id="${esc(tx.id)}">🗑</button>
    </div>
    <div class="tx-comment" style="display:none">${tx.comment ? esc(tx.comment) : '<em>No comment added.</em>'}</div>
  </div>`;
}
function startCatEdit(id){
  const tx = state.transactions.find(t => t.id === id);
  const cell = document.querySelector(`.tx-row[data-id="${CSS.escape(id)}"] .cat-cell`);
  cell.innerHTML = `<select autofocus data-change="correctTxCategory" data-blur="renderTxList" data-id="${esc(id)}">${categoryOptions(tx.category)}</select>`;
  cell.querySelector('select').focus();
}
function editTx(id){ const tx = state.transactions.find(t => t.id === id); if (tx) openTxForm(tx); }

/* ---- Bank statement import (multi-file, drag & drop, AI-named) ---- */
function openImportPanel(){
  closeTxForm();
  importBatches = [];
  const el = document.getElementById('import-panel');
  el.style.display = 'block';
  renderImportPanel();
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function closeImportPanel(){ document.getElementById('import-panel').style.display = 'none'; importBatches = []; }

const ACCEPTED_STATEMENT_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
function addImportFiles(fileList){
  const files = Array.from(fileList || []);
  const rejected = [];
  files.forEach(f => {
    if (!ACCEPTED_STATEMENT_MIMES.includes(f.type)){ rejected.push(f.name); return; }
    importBatches.push({ batchId: uid(), file: f, originalFilename: f.name, suggestedName: '', status: 'pending', errorMsg: '', rows: [] });
  });
  renderImportPanel();
  if (rejected.length) showImportError(`Skipped unsupported file${rejected.length===1?'':'s'} (need PDF or a photo — jpg/png/webp/heic): ${rejected.join(', ')}`);
}
function removeImportBatch(batchId){
  importBatches = importBatches.filter(b => b.batchId !== batchId);
  renderImportPanel();
}
function onImportFilesChosen(input){ addImportFiles(input.files); }
function onImportDrop(ev, zone){
  ev.preventDefault();
  zone.classList.remove('import-drop-active');
  addImportFiles(ev.dataTransfer.files);
}
function onImportDragOver(ev, zone){ ev.preventDefault(); zone.classList.add('import-drop-active'); }
function onImportDragLeave(ev, zone){ zone.classList.remove('import-drop-active'); }

function showImportError(msg){
  const el = document.getElementById('import-error');
  if (!el) return;
  el.style.display = 'block'; el.textContent = '⚠ ' + msg;
}

function renderImportPanel(){
  const el = document.getElementById('import-panel');
  const anyDone = importBatches.some(b => b.status === 'done' && b.rows.length > 0);
  if (!anyDone){
    const hasFiles = importBatches.length > 0;
    el.innerHTML = `
      <div class="field-label" style="margin-bottom:8px;">Bank statements (PDF or photo — drop one or several at once)</div>
      <div class="import-drop" data-dragover="importDragOver" data-dragleave="importDragLeave" data-drop="importDrop">
        📄
        <label class="btn-ghost btn-sm import-choose">
          Choose file${hasFiles?'s':''}
          <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif" multiple style="position:absolute;inset:0;opacity:0;cursor:pointer;" data-change="importFilesChosen">
        </label>
        <p class="muted" style="margin:6px 0 0;text-align:center;">Drag PDFs or photos of a statement here, or click to choose. The AI reads each one, suggests a name for it, and drafts one transaction per line — using your existing ledger as its guide — and you review before anything is saved.</p>
      </div>
      ${hasFiles ? `
        <div class="import-file-list">
          ${importBatches.map(b => `
            <div class="import-file-row">
              <span class="import-file-status">${b.status==='reading' ? '<span class="spin">↻</span>' : b.status==='error' ? '⚠' : (b.file.type.startsWith('image/') ? '🖼' : '📄')}</span>
              <span class="import-file-name">${esc(b.originalFilename)}</span>
              ${b.status==='error' ? `<span class="ai-note-error" style="font-size:12px;">${esc(b.errorMsg)}</span>` : ''}
              <button type="button" class="icon-btn icon-btn-danger" data-click="removeImportBatch" data-batch="${esc(b.batchId)}">🗑</button>
            </div>`).join('')}
        </div>` : ''}
      <p class="ai-note ai-note-error" id="import-error" style="display:none;"></p>
      <div class="form-actions">
        <button type="button" class="btn-ghost" data-click="closeImportPanel">Cancel</button>
        <button type="button" class="btn-primary" id="import-read-btn" data-click="runImportParse" ${hasFiles?'':'disabled'}>✨ Read statement${importBatches.length===1?'':'s'}</button>
      </div>`;
  } else {
    const totalRows = importBatches.reduce((s,b) => s + b.rows.length, 0);
    el.innerHTML = `
      <div class="import-review-head">📄 <span>${totalRows} transaction${totalRows===1?'':'s'} found across ${importBatches.length} statement${importBatches.length===1?'':'s'} — review before importing</span></div>
      ${importBatches.map(renderImportBatchHtml).join('')}
      <div class="form-actions">
        <button type="button" class="btn-ghost" data-click="closeImportPanel">Cancel</button>
        <button type="button" class="btn-primary" data-click="commitImport">Import <span id="import-count">${countSelectedImportRows()}</span> transactions</button>
      </div>`;
  }
}
function countSelectedImportRows(){
  return importBatches.reduce((s,b) => s + b.rows.filter(r=>r.selected).length, 0);
}
function renderImportBatchHtml(b){
  if (b.status === 'error'){
    return `<div class="panel-card import-batch-error"><strong>${esc(b.originalFilename)}</strong> — ${esc(b.errorMsg)}</div>`;
  }
  if (b.rows.length === 0) return '';
  const redactionNote = b.file.type === 'application/pdf'
    ? (b.redacted
        ? `<span class="chip chip-ok" title="Account number, IBAN, sort code and name/address were stripped in your browser before this was sent">🔒 Redacted before sending</span>`
        : `<span class="chip chip-muted" title="Couldn't extract text from this PDF (likely a scanned document), so the full file was sent">⚠ Sent unredacted (no text layer found)</span>`)
    : '';
  return `
  <div class="import-batch">
    <div class="import-batch-header">
      <input type="text" class="import-batch-name" value="${esc(b.suggestedName || b.originalFilename)}" data-input="batchName" data-batch="${esc(b.batchId)}" title="AI-suggested name — edit if you like">
      <span class="muted">${b.rows.length} transaction${b.rows.length===1?'':'s'} · from ${esc(b.originalFilename)}</span>
      ${redactionNote}
    </div>
    <div class="import-rows">${b.rows.map(r => renderImportRowHtml(r, b.batchId)).join('')}</div>
  </div>`;
}
function updateBatchName(batchId, value){
  const b = importBatches.find(x => x.batchId === batchId);
  if (b) b.suggestedName = value;
}
async function runImportParse(){
  const pending = importBatches.filter(b => b.status === 'pending');
  if (pending.length === 0) return;
  const btn = document.getElementById('import-read-btn');
  btn.disabled = true;
  for (const b of pending){
    b.status = 'reading';
    renderImportPanel();
    const freshBtn = document.getElementById('import-read-btn');
    if (freshBtn){ freshBtn.disabled = true; freshBtn.innerHTML = `<span class="spin">↻</span> Reading ${esc(b.originalFilename)}…`; }
    try {
      let result;
      if (b.file.type === 'application/pdf'){
        const extracted = await extractAndRedactPdf(b.file);
        result = extracted.text
          ? await parseStatementText(extracted.text)
          : await parseStatementPdf(extracted.base64, 'application/pdf');
        b.redacted = !extracted.fallback;
      } else {
        const base64 = await fileToBase64(b.file);
        result = await parseStatementPdf(base64, b.file.type);
        b.redacted = false;
      }
      b.rows = result.rows;
      b.suggestedName = result.suggestedName || b.originalFilename.replace(/\.(pdf|jpe?g|png|webp|heic|heif)$/i, '');
      b.status = result.rows.length === 0 ? 'error' : 'done';
      if (result.rows.length === 0) b.errorMsg = 'No transactions found — the image or PDF may be unclear or an unsupported layout.';
    } catch(e){
      b.status = 'error';
      b.errorMsg = (e && e.message) ? e.message : "Couldn't read this statement — check the file is clear and try again.";
    }
  }
  renderImportPanel();
}
function renderImportRowHtml(r, batchId){
  const isIncome = Number(r.amount) > 0;
  const b = esc(batchId), row = esc(r.rowId);
  const dateOk = isValidISODate(r.date);
  const ref = `data-batch="${b}" data-row="${row}"`;
  return `
  <div class="import-row" data-row-id="${row}">
    <input type="checkbox" ${r.selected?'checked':''} data-change="importRowField" data-field="selected" ${ref}>
    <input type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/yy" class="mono${dateOk?'':' import-date-missing'}" value="${dateOk ? esc(isoToDMY(r.date)) : ''}" title="${dateOk ? 'dd/mm/yy' : 'No valid date was read for this line - type one as dd/mm/yy before importing'}" data-change="importRowField" data-field="date" ${ref}>
    <input type="text" value="${esc(r.description)}" placeholder="Item" data-input="importRowField" data-field="description" ${ref}>
    <div class="amount-row import-amount">
      <span class="dir-badge ${isIncome?'dir-in':'dir-out'}" title="${isIncome?'Money in':'Money out'}">${isIncome?'+':'−'}</span>
      <select data-change="importRowField" data-field="currency" ${ref}>${CURRENCIES.map(c=>`<option value="${esc(c)}" ${c===r.currency?'selected':''}>${esc(c)}</option>`).join('')}</select>
      <input type="number" step="0.01" value="${esc(r.amount)}" data-input="importRowField" data-field="amount" ${ref}>
    </div>
    <select data-change="importRowField" data-field="category" ${ref}>${categoryOptions(r.category)}</select>
    ${r.confidence!=null ? `<span class="chip chip-ai import-conf">${esc(r.confidence)}%</span>` : '<span></span>'}
    <button type="button" class="icon-btn icon-btn-danger" data-click="removeImportRow" ${ref}>🗑</button>
  </div>`;
}
function updateImportRow(batchId, rowId, field, value){
  const b = importBatches.find(x => x.batchId === batchId);
  const row = b && b.rows.find(r => r.rowId === rowId);
  if (!row) return;
  row[field] = (field === 'date') ? (isValidISODate(value) ? value : '') : value;
  if (field === 'selected'){
    const countEl = document.getElementById('import-count');
    if (countEl) countEl.textContent = countSelectedImportRows();
  }
}
function removeImportRow(batchId, rowId){
  const b = importBatches.find(x => x.batchId === batchId);
  if (!b) return;
  b.rows = b.rows.filter(r => r.rowId !== rowId);
  renderImportPanel();
}
function commitImport(){
  const undated = importBatches.reduce((n, b) => n + b.rows.filter(r => r.selected && r.description.trim() && Number(r.amount) && !isValidISODate(r.date)).length, 0);
  if (undated){
    alert(`${undated} selected transaction${undated===1?' has':'s have'} no valid date (highlighted in red). Set ${undated===1?'a date on it':'a date on each'}, or untick ${undated===1?'it':'them'}, then import again.`);
    return;
  }
  const newTxs = [];
  const newImportRecords = [];
  importBatches.forEach(b => {
    const toImport = b.rows.filter(r => r.selected && r.description.trim() && Number(r.amount));
    if (toImport.length === 0) return;
    const importId = uid();
    const txs = toImport.map(r => ({
      id: uid(), date: r.date, description: r.description.trim(), amount: Number(r.amount), currency: r.currency,
      category: r.category, secondary: '', comment: '',
      aiSuggested: true, aiConfidence: r.confidence, aiReasoning: 'Extracted from imported bank statement.', aiOverridden: false,
      importId,
    }));
    newTxs.push(...txs);
    newImportRecords.push({
      id: importId,
      filename: (b.suggestedName || b.originalFilename).trim() || b.originalFilename,
      originalFilename: b.originalFilename,
      importedAt: new Date().toISOString(), count: txs.length, txIds: txs.map(t => t.id),
    });
  });
  if (newTxs.length === 0){ closeImportPanel(); return; }
  state.transactions = newTxs.concat(state.transactions);
  state.imports = newImportRecords.concat(state.imports);
  closeImportPanel(); saveState(); renderTxSummary(); renderTxList();
}

/* ======================================================================
   IMPORTS LOG
   ====================================================================== */
function renderImportsList(){
  const el = document.getElementById('imports-list');
  if (state.imports.length === 0){
    el.innerHTML = `<div class="empty-state">📂<p>No statements imported yet. Each PDF you import will show up here with what it added.</p></div>`;
    return;
  }
  el.innerHTML = state.imports.map(imp => {
    const stillPresent = imp.txIds.filter(id => state.transactions.some(t => t.id === id)).length;
    const when = new Date(imp.importedAt);
    const whenStr = isNaN(when) ? imp.importedAt : when.toLocaleString();
    return `
    <div class="panel-card import-log-row">
      <div class="import-log-main">
        <div class="import-log-name">${esc(imp.filename)}</div>
        <div class="muted">${esc(whenStr)} · ${esc(imp.count)} transaction${imp.count===1?'':'s'} imported${stillPresent!==imp.count ? ` (${stillPresent} still in your ledger)` : ''}</div>
      </div>
      <div class="import-log-actions">
        <button class="btn-ghost btn-sm" data-click="viewImportTransactions" data-id="${esc(imp.id)}">View transactions</button>
        <button class="icon-btn icon-btn-danger" title="Remove this log entry (does not delete transactions)" data-click="deleteImportRecord" data-id="${esc(imp.id)}">🗑</button>
      </div>
    </div>`;
  }).join('');
}
function viewImportTransactions(importId){
  setTab('transactions');
  clearTxFilters();
  document.getElementById('tx-filter-import').value = importId;
  renderTxList();
}
function deleteImportRecord(id){
  if (!confirm('Remove this import log entry? The transactions it added will stay in your ledger.')) return;
  state.imports = state.imports.filter(i => i.id !== id);
  saveState(); renderImportsList();
}

/* ======================================================================
   BREAKDOWN
   ====================================================================== */
/* ---- Breakdown: NET (money in + money out) ----
   Every figure here is the signed sum of amounts: expenses are negative, income and refunds positive, so a
   refund offsets the spend it refunds. Sums are kept in whole cents so floating-point dust can never turn a
   true 0.00 into a tiny red or green number. */
const toCents = v => Math.round((Number(v) || 0) * 100);
const signCls = c => c < 0 ? ' neg' : (c > 0 ? ' pos' : '');
// Bars grow from a zero line. If the values are all one sign, zero sits at the left edge; if they are mixed,
// zero sits in the middle of the track so money out extends left and money in extends right.
function bdAxis(vals){
  const negMax = Math.max(0, ...vals.map(v => -v)), posMax = Math.max(0, ...vals);
  const mixed = negMax > 0 && posMax > 0;
  const span = mixed ? negMax + posMax : (Math.max(negMax, posMax) || 1);
  return { mixed, zero: mixed ? negMax / span * 100 : 0, scale: 100 / span };
}
function bdBar(c, ax){
  if (!c) return '';
  const w = Math.max(Math.abs(c) * ax.scale, 0.8);
  const left = (c < 0 && ax.mixed) ? ax.zero - w : ax.zero;
  return `<div class="breakdown-bar ${c < 0 ? 'bd-out' : 'bd-in'}" style="left:${left.toFixed(2)}%;width:${w.toFixed(2)}%"></div>`;
}
function bdRow(label, c, ax, currency, mono){
  return `
    <div class="breakdown-row">
      <span class="breakdown-label${mono ? ' mono' : ''}">${esc(label)}</span>
      <div class="breakdown-bar-track">${ax.mixed ? `<div class="bd-zero" style="left:${ax.zero.toFixed(2)}%"></div>` : ''}${bdBar(c, ax)}</div>
      <span class="mono breakdown-val${signCls(c)}">${esc(currency)} ${fmtMoney(c / 100)}</span>
    </div>`;
}
function renderBreakdown(){
  const currencySel = document.getElementById('breakdown-currency');
  const currencies = [...new Set(state.transactions.map(t => t.currency))];
  if (!currencies.includes(currencySel.value)) currencySel.value = currencies[0] || CURRENCIES[0];
  const currency = currencySel.value;
  const all = state.transactions.filter(t => t.currency === currency);
  const monthOf = t => String(t.date).slice(0, 7);
  const months = [...new Set(all.map(monthOf))].sort();                       // oldest -> newest
  const monthSel = document.getElementById('breakdown-month');
  const wanted = monthSel.value;
  monthSel.innerHTML = '<option value="">All months</option>' + months.slice().reverse().map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  monthSel.value = months.includes(wanted) ? wanted : '';
  const month = monthSel.value;
  const el = document.getElementById('breakdown-content');
  if (all.length === 0){
    el.innerHTML = `<div class="empty-state">📊<p>No ${esc(currency)} transactions yet to break down.</p></div>`;
    return;
  }

  // Totals + by-category, for the chosen month (or everything)
  const scope = month ? all.filter(t => monthOf(t) === month) : all;
  let inC = 0, outC = 0;
  scope.forEach(t => { const c = toCents(t.amount); if (c > 0) inC += c; else outC += c; });
  const byCat = {};
  scope.forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + toCents(t.amount); });
  const catRows = Object.entries(byCat).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));   // biggest net spend first
  const catAxis = bdAxis(catRows.map(r => r[1]));

  // By month (always all months)
  const monthNet = {};
  all.forEach(t => { const m = monthOf(t); monthNet[m] = (monthNet[m] || 0) + toCents(t.amount); });
  const monthRowsDesc = months.slice().reverse().map(m => [m, monthNet[m]]);
  const monthAxis = bdAxis(monthRowsDesc.map(r => r[1]));

  // Category x month (always all months)
  const cell = {}, catTotal = {};
  all.forEach(t => {
    const c = toCents(t.amount), m = monthOf(t);
    (cell[t.category] ||= {})[m] = (cell[t.category][m] || 0) + c;
    catTotal[t.category] = (catTotal[t.category] || 0) + c;
  });
  const matrixCats = Object.keys(catTotal).sort((a, b) => catTotal[a] - catTotal[b] || a.localeCompare(b));
  const maxCell = Math.max(1, ...matrixCats.flatMap(cat => Object.values(cell[cat]).map(Math.abs)));
  const shade = c => !c ? '' : ` style="background:rgba(${c < 0 ? '181,72,52' : '31,111,92'},${(0.06 + 0.24 * Math.abs(c) / maxCell).toFixed(3)})"`;
  const grand = months.reduce((n, m) => n + monthNet[m], 0);

  el.innerHTML = `
    <div class="summary-strip">
      <div class="summary-pill"><span class="summary-cur">${esc(currency)} IN</span><span class="mono summary-val${inC ? ' pos' : ''}">${fmtMoney(inC / 100)}</span></div>
      <div class="summary-pill"><span class="summary-cur">OUT</span><span class="mono summary-val${outC ? ' neg' : ''}">${fmtMoney(outC / 100)}</span></div>
      <div class="summary-pill"><span class="summary-cur">NET</span><span class="mono summary-val${signCls(inC + outC)}">${fmtMoney((inC + outC) / 100)}</span></div>
      <span class="muted" style="align-self:center;">${month ? esc(month) : 'All months'} · ${scope.length} transaction${scope.length === 1 ? '' : 's'}</span>
    </div>
    <div class="panel-card">
      <div class="field-label" style="margin-bottom:10px;">Net by category — ${month ? esc(month) : 'all months'}</div>
      ${catRows.map(([cat, c]) => bdRow(cat, c, catAxis, currency, false)).join('')}
    </div>
    <div class="panel-card">
      <div class="field-label" style="margin-bottom:10px;">Net by month</div>
      ${monthRowsDesc.map(([m, c]) => bdRow(m, c, monthAxis, currency, true)).join('')}
    </div>
    <div class="panel-card">
      <div class="field-label" style="margin-bottom:10px;">Category by month (${esc(currency)}, net)</div>
      <div class="bd-matrix-wrap"><table class="bd-matrix">
        <thead><tr><th>Category</th>${months.map(m => `<th>${esc(m)}</th>`).join('')}<th class="bd-total">Total</th></tr></thead>
        <tbody>${matrixCats.map(cat => `<tr><td>${esc(cat)}</td>${months.map(m => {
          const c = cell[cat][m];
          return c === undefined ? '<td class="bd-empty">·</td>' : `<td class="mono${signCls(c)}"${shade(c)}>${fmtMoney(c / 100)}</td>`;
        }).join('')}<td class="mono bd-total${signCls(catTotal[cat])}">${fmtMoney(catTotal[cat] / 100)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Net</td>${months.map(m => `<td class="mono${signCls(monthNet[m])}">${fmtMoney(monthNet[m] / 100)}</td>`).join('')}<td class="mono bd-total${signCls(grand)}">${fmtMoney(grand / 100)}</td></tr></tfoot>
      </table></div>
    </div>
  `;
}

/* ======================================================================
   LOANS
   ====================================================================== */
function loanOutstanding(loan){
  const paid = (loan.payments||[]).reduce((s,p) => s + Number(p.amount), 0);
  return Number(loan.principal) - paid;
}
function openLoanForm(){
  const f = document.getElementById('loan-form');
  f.style.display = 'grid';
  document.getElementById('loan-direction').value = 'lent';
  document.getElementById('loan-counterparty').value = '';
  document.getElementById('loan-currency').value = 'SGD';
  document.getElementById('loan-principal').value = '';
  document.getElementById('loan-date').value = todayISO();
  document.getElementById('loan-rate').value = '';
  document.getElementById('loan-duedate').value = '';
  document.getElementById('loan-notes').value = '';
  f.scrollIntoView({ behavior:'smooth', block:'nearest' });
}
function closeLoanForm(){ document.getElementById('loan-form').style.display = 'none'; }
function submitLoanForm(e){
  e.preventDefault();
  const loan = {
    id: uid(), direction: document.getElementById('loan-direction').value,
    counterparty: document.getElementById('loan-counterparty').value.trim(),
    principal: Number(document.getElementById('loan-principal').value),
    currency: document.getElementById('loan-currency').value,
    date: document.getElementById('loan-date').value,
    rate: document.getElementById('loan-rate').value ? Number(document.getElementById('loan-rate').value) : null,
    dueDate: document.getElementById('loan-duedate').value || null,
    notes: document.getElementById('loan-notes').value.trim(),
    payments: [],
  };
  state.loans.unshift(loan);
  closeLoanForm(); saveState(); renderLoanList();
}
function deleteLoan(id){
  if (!confirm('Delete this loan record?')) return;
  state.loans = state.loans.filter(l => l.id !== id);
  saveState(); renderLoanList();
}
function showPaymentForm(id){
  const el = document.querySelector(`.loan-card[data-id="${CSS.escape(id)}"] .payment-slot`);
  el.innerHTML = `
    <div class="payment-form">
      <input type="date" id="pay-date-${esc(id)}" value="${todayISO()}">
      <input type="number" step="0.01" placeholder="Amount" id="pay-amt-${esc(id)}">
      <button class="btn-primary btn-sm" data-click="addPayment" data-id="${esc(id)}">Log</button>
      <button class="btn-ghost btn-sm" data-click="renderLoanList">Cancel</button>
    </div>`;
}
function addPayment(id){
  const amt = Number(document.getElementById(`pay-amt-${id}`).value);
  const date = document.getElementById(`pay-date-${id}`).value;
  if (!amt) return;
  const loan = state.loans.find(l => l.id === id);
  loan.payments.push({ id: uid(), date, amount: amt });
  saveState(); renderLoanList();
}
function renderLoanList(){
  const el = document.getElementById('loan-list');
  if (state.loans.length === 0){
    el.innerHTML = `<div class="empty-state">🏦<p>No loans on record. Loans you give or take are kept apart from your expense totals.</p></div>`;
    return;
  }
  el.innerHTML = state.loans.map(loan => {
    const outstanding = loanOutstanding(loan), settled = outstanding <= 0.005;
    return `
    <div class="panel-card loan-card" data-id="${esc(loan.id)}">
      <div class="loan-head">
        <div><span class="loan-badge ${loan.direction==='lent'?'loan-badge-lent':'loan-badge-borrowed'}">${loan.direction==='lent'?'Lent to':'Borrowed from'}</span>
        <strong style="margin-left:8px;">${esc(loan.counterparty)}</strong></div>
        <button class="icon-btn icon-btn-danger" data-click="deleteLoan" data-id="${esc(loan.id)}">🗑</button>
      </div>
      <div class="loan-body">
        <div><span class="muted">Principal</span><div class="mono">${esc(loan.currency)} ${fmtMoney(loan.principal)}</div></div>
        <div><span class="muted">Outstanding</span><div class="mono ${settled?'ok':''}">${esc(loan.currency)} ${fmtMoney(Math.max(outstanding,0))}</div></div>
        <div><span class="muted">Issued</span><div class="mono">${esc(loan.date)}</div></div>
        ${loan.rate!=null?`<div><span class="muted">Interest</span><div class="mono">${esc(loan.rate)}%</div></div>`:''}
        ${loan.dueDate?`<div><span class="muted">Due</span><div class="mono">${esc(loan.dueDate)}</div></div>`:''}
      </div>
      ${loan.notes?`<p class="loan-notes">${esc(loan.notes)}</p>`:''}
      ${loan.payments.length ? `<div class="payment-list">${loan.payments.map(p=>`<div class="payment-row mono"><span>${esc(p.date)}</span><span>${esc(loan.currency)} ${fmtMoney(p.amount)}</span></div>`).join('')}</div>` : ''}
      <div class="payment-slot">${settled ? '<span class="chip chip-ok">Settled</span>' : `<button class="btn-ghost btn-sm" data-click="showPaymentForm" data-id="${esc(loan.id)}">+ Log repayment</button>`}</div>
    </div>`;
  }).join('');
}

/* ======================================================================
   CURRENCY EXCHANGE
   ====================================================================== */
function openFxForm(){
  const f = document.getElementById('fx-form');
  f.style.display = 'grid';
  document.getElementById('fx-date').value = todayISO();
  document.getElementById('fx-from-cur').value = 'SGD';
  document.getElementById('fx-to-cur').value = CURRENCIES[1] || CURRENCIES[0];
  document.getElementById('fx-from-amt').value = '';
  document.getElementById('fx-to-amt').value = '';
  document.getElementById('fx-comment').value = '';
  updateFxRateDisplay();
  f.scrollIntoView({ behavior:'smooth', block:'nearest' });
}
function closeFxForm(){ document.getElementById('fx-form').style.display = 'none'; }
function updateFxRateDisplay(){
  const from = Number(document.getElementById('fx-from-amt').value);
  const to = Number(document.getElementById('fx-to-amt').value);
  document.getElementById('fx-rate-display').textContent = (from && to) ? (to/from).toFixed(4) : '—';
}
function submitFxForm(e){
  e.preventDefault();
  const fromAmt = Number(document.getElementById('fx-from-amt').value);
  const toAmt = Number(document.getElementById('fx-to-amt').value);
  const rec = {
    id: uid(), date: document.getElementById('fx-date').value,
    fromCur: document.getElementById('fx-from-cur').value, fromAmt,
    toCur: document.getElementById('fx-to-cur').value, toAmt,
    rate: toAmt / fromAmt, comment: document.getElementById('fx-comment').value.trim(),
  };
  state.fx.unshift(rec);
  closeFxForm(); saveState(); renderFxList();
}
function deleteFx(id){
  if (!confirm('Delete this exchange record?')) return;
  state.fx = state.fx.filter(r => r.id !== id);
  saveState(); renderFxList();
}
function renderFxList(){
  const el = document.getElementById('fx-list');
  if (state.fx.length === 0){
    el.innerHTML = `<div class="empty-state">⇄<p>No exchanges logged. Record one whenever you convert cash so you can see the rates you're actually getting.</p></div>`;
    return;
  }
  el.innerHTML = state.fx.slice().sort((a,b)=> a.date < b.date ? 1 : -1).map(rec => `
    <div class="panel-card fx-row">
      <div class="mono">${esc(rec.date)}</div>
      <div class="fx-conv"><span class="mono">${esc(rec.fromCur)} ${fmtMoney(rec.fromAmt)}</span> ⇄ <span class="mono">${esc(rec.toCur)} ${fmtMoney(rec.toAmt)}</span></div>
      <div class="mono fx-rate">1 ${esc(rec.fromCur)} = ${(Number(rec.rate)||0).toFixed(4)} ${esc(rec.toCur)}</div>
      <button class="icon-btn icon-btn-danger" data-click="deleteFx" data-id="${esc(rec.id)}">🗑</button>
      ${rec.comment?`<div class="fx-comment">${esc(rec.comment)}</div>`:''}
    </div>`).join('');
}

/* ======================================================================
   EVENT WIRING  (replaces every inline onclick/onchange/... handler)
   Markup declares what it wants with data-click / data-change / data-input /
   data-blur / data-submit / data-dragover / data-dragleave / data-drop; one
   listener per event type looks the name up in ACTIONS below. Only names listed
   here can ever run, and none of it needs inline JavaScript, which is what lets
   the Content Security Policy forbid inline scripts entirely.
   ====================================================================== */
const ACTIONS = Object.assign(Object.create(null), {
  // auth + navigation
  signIn: () => signIn(),
  signOut: () => signOut(),
  setTab: (el) => setTab(el.dataset.tab),
  // transactions
  openTxForm: () => openTxForm(),
  closeTxForm: () => closeTxForm(),
  submitTxForm: (el, ev) => submitTxForm(ev),
  onTxItemChanged: () => onTxItemChanged(),
  suggestTxCategory: () => suggestTxCategory(),
  editTxCatPicker: () => editTxCatPicker(),
  onTxCatPicked: (el) => {
    if (el.value === NEW_CATEGORY_VALUE) onTxCatPicked(promptForNewCategory() || el.dataset.prev || '');
    else onTxCatPicked(el.value);
  },
  startCatEdit: (el) => startCatEdit(el.dataset.id),
  correctTxCategory: (el) => {
    if (el.value === NEW_CATEGORY_VALUE) {
      const name = promptForNewCategory();
      if (name) correctTxCategory(el.dataset.id, name);
      renderTxList();                                    // closes the dropdown whether or not anything changed
    } else correctTxCategory(el.dataset.id, el.value);
  },
  toggleTxComment: (el) => toggleTxComment(el.dataset.id),
  editTx: (el) => editTx(el.dataset.id),
  txSelectRow: (el, ev) => toggleTxSelection(el.dataset.id, el.checked, ev.shiftKey),
  txSelectAll: (el) => selectAllShown(el.checked),
  bulkCategoryChanged: (el) => {
    bulkCategory = (el.value === NEW_CATEGORY_VALUE) ? (promptForNewCategory() || bulkCategory) : el.value;
    renderBulkBar();
  },
  bulkApply: () => applyBulkCategory(),
  bulkClear: () => selectAllShown(false),
  bulkUndo: () => undoBulk(),
  bulkSecondaryInput: (el) => {                          // no re-render while typing (it would drop focus)
    bulkSecondary = el.value;
    const btn = document.querySelector('[data-click="bulkSetSecondary"]');
    if (btn) btn.disabled = !cleanCategoryName(el.value);
  },
  bulkSecondaryKey: (el, ev) => { if (ev.key === 'Enter'){ ev.preventDefault(); bulkSecondary = el.value; applyBulkSecondary(false); } },
  bulkSetSecondary: () => applyBulkSecondary(false),
  bulkClearSecondary: () => applyBulkSecondary(true),
  deleteTx: (el) => deleteTx(el.dataset.id),
  renderTxList: () => renderTxList(),
  clearTxFilters: () => clearTxFilters(),
  clearImportFilter: () => { document.getElementById('tx-filter-import').value = ''; renderTxList(); },
  // statement import
  openImportPanel: () => openImportPanel(),
  closeImportPanel: () => closeImportPanel(),
  importDragOver: (el, ev) => onImportDragOver(ev, el),
  importDragLeave: (el, ev) => onImportDragLeave(ev, el),
  importDrop: (el, ev) => onImportDrop(ev, el),
  importFilesChosen: (el) => onImportFilesChosen(el),
  removeImportBatch: (el) => removeImportBatch(el.dataset.batch),
  batchName: (el) => updateBatchName(el.dataset.batch, el.value),
  importRowField: (el) => {
    if (el.dataset.field === 'date') {
      const iso = parseDMY(el.value);                     // '' if it isn't a real calendar date
      updateImportRow(el.dataset.batch, el.dataset.row, 'date', iso);
      el.classList.toggle('import-date-missing', !iso);
      if (iso) el.value = isoToDMY(iso);                  // e.g. 5/8/26 -> 05/08/26
      return;
    }
    if (el.dataset.field === 'category' && el.value === NEW_CATEGORY_VALUE) {
      const b = importBatches.find(x => x.batchId === el.dataset.batch);
      const row = b && b.rows.find(r => r.rowId === el.dataset.row);
      const name = promptForNewCategory();
      if (name) {
        addCategoryOptionToReviewSelects(name);
        el.value = name;
        updateImportRow(el.dataset.batch, el.dataset.row, 'category', name);
      } else {
        el.value = row ? (row.category || '') : '';      // cancelled: put back what it was
      }
      return;
    }
    const value = el.type === 'checkbox' ? el.checked : el.value;
    updateImportRow(el.dataset.batch, el.dataset.row, el.dataset.field, value);
  },
  removeImportRow: (el) => removeImportRow(el.dataset.batch, el.dataset.row),
  runImportParse: () => runImportParse(),
  commitImport: () => commitImport(),
  viewImportTransactions: (el) => viewImportTransactions(el.dataset.id),
  deleteImportRecord: (el) => deleteImportRecord(el.dataset.id),
  // loans
  openLoanForm: () => openLoanForm(),
  closeLoanForm: () => closeLoanForm(),
  submitLoanForm: (el, ev) => submitLoanForm(ev),
  deleteLoan: (el) => deleteLoan(el.dataset.id),
  showPaymentForm: (el) => showPaymentForm(el.dataset.id),
  addPayment: (el) => addPayment(el.dataset.id),
  renderLoanList: () => renderLoanList(),
  // currency exchange
  openFxForm: () => openFxForm(),
  closeFxForm: () => closeFxForm(),
  submitFxForm: (el, ev) => submitFxForm(ev),
  updateFxRateDisplay: () => updateFxRateDisplay(),
  deleteFx: (el) => deleteFx(el.dataset.id),
  // breakdown
  renderBreakdown: () => renderBreakdown(),
});
(function wireEvents(){
  // DOM event -> the data-attribute that opts an element in
  const events = { click: 'click', change: 'change', input: 'input', keydown: 'keydown', focusout: 'blur', submit: 'submit',
                   dragover: 'dragover', dragleave: 'dragleave', drop: 'drop' };
  Object.keys(events).forEach(type => {
    const attr = 'data-' + events[type];
    document.addEventListener(type, ev => {
      if (!(ev.target instanceof Element)) return;
      const el = ev.target.closest('[' + attr + ']');
      if (!el) return;
      const action = ACTIONS[el.getAttribute(attr)];
      if (typeof action !== 'function') return;
      // A blur fires while the element is being replaced by the very render its own change event started;
      // acting then re-renders mid-render (an uncaught DOM error). Wait a tick and only act if the element
      // is still on the page, i.e. the user really did click away.
      if (type === 'focusout') setTimeout(() => { if (el.isConnected) action(el, ev); }, 0);
      else action(el, ev);
    });
  });
})();

/* ======================================================================
   BOOT
   ====================================================================== */
waitForGoogleIdentity(initGoogleAuth);

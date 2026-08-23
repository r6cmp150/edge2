'use strict';
// ================================================================
// EDGE Trade Signals — app.js  v2.7.0
// ================================================================

// Pristine index.html body, captured before anything (PIN screen, data
// loading screen) ever overwrites document.body.innerHTML — restored by
// runDataLoadAndInit() once Portfolio/Settings finish loading from Supabase.
const APP_SHELL_HTML = document.body.innerHTML;

// ── 0. PIN GATE ──────────────────────────────────────────────────
// Runs before anything else. Default PIN hash is SHA-256("0684");
// default security-answer hash is SHA-256("Rainbow6") — the plain
// values are never stored, only these hashes. A user-set PIN
// (edge2_pin_hash in localStorage) always takes priority over the
// hardcoded default.

const DEFAULT_PIN_HASH = 'bfdb0f9421ac027731316cf04945379416a33b2180aa6b9bdfef63e967d68d01';
const SECURITY_ANSWER_HASH = 'd7d602a4b095428e7432015e114bb5a3045291484f0f98cd9a6d3395c4f1a202';

async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getPinHash() {
  return localStorage.getItem('edge2_pin_hash') || DEFAULT_PIN_HASH;
}

function isPinVerified() {
  return sessionStorage.getItem('edge2_pin_verified') === 'true';
}

function lockApp() {
  sessionStorage.removeItem('edge2_pin_verified');
  location.reload();
}

let _pinBuf = '';
let _newPin1 = '';
let _newPin2 = '';
let _newPinStage = 1;

function pinDotsHtml(buf) {
  let html = '';
  for (let i = 0; i < 4; i++) {
    html += `<div class="pin-box">${i < buf.length ? '<span class="pin-dot"></span>' : ''}</div>`;
  }
  return html;
}

function pinNumpadHtml(pressFn, backFn) {
  let html = '<div class="pin-numpad">';
  for (let n = 1; n <= 9; n++) {
    html += `<button class="pin-key" onclick="${pressFn}('${n}')">${n}</button>`;
  }
  html += `<button class="pin-key pin-key-ghost" disabled></button>`;
  html += `<button class="pin-key" onclick="${pressFn}('0')">0</button>`;
  html += `<button class="pin-key pin-key-back" onclick="${backFn}()">⌫</button>`;
  html += '</div>';
  return html;
}

function renderPinScreen(opts = {}) {
  document.body.innerHTML = `
    <div class="pin-screen">
      <div class="pin-title">EDGE2</div>
      <div class="pin-subtitle">Enter PIN</div>
      <div class="pin-boxes${opts.shake ? ' shake' : ''}" id="pin-boxes">${pinDotsHtml(_pinBuf)}</div>
      <div class="pin-error">${opts.error || ''}</div>
      ${pinNumpadHtml('pinPress', 'pinBackspace')}
      <button class="pin-submit" onclick="pinSubmit()">Submit</button>
      <a class="pin-forgot" onclick="showForgotPinScreen()">Forgot PIN?</a>
    </div>`;
}

function pinPress(d) {
  if (_pinBuf.length >= 4) return;
  _pinBuf += d;
  if (_pinBuf.length === 4) { pinSubmit(); return; }
  renderPinScreen();
}

function pinBackspace() {
  _pinBuf = _pinBuf.slice(0, -1);
  renderPinScreen();
}

async function pinSubmit() {
  if (_pinBuf.length !== 4) return;
  const entered = _pinBuf;
  const hash = await sha256Hex(entered);
  if (hash === getPinHash()) {
    sessionStorage.setItem('edge2_pin_verified', 'true');
    _pinBuf = '';
    location.reload();
  } else {
    _pinBuf = '';
    renderPinScreen({ error: 'Incorrect PIN', shake: true });
  }
}

function showForgotPinScreen(opts = {}) {
  document.body.innerHTML = `
    <div class="pin-screen">
      <div class="pin-title">EDGE2</div>
      <div class="pin-subtitle">Security Question</div>
      <div class="pin-question">What is your favorite game?</div>
      <input id="security-answer" class="pin-text-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Answer">
      <div class="pin-error">${opts.error || ''}</div>
      <button class="pin-submit" onclick="checkSecurityAnswer()">Submit</button>
      <a class="pin-forgot" onclick="_pinBuf='';renderPinScreen()">‹ Back to PIN</a>
    </div>`;
  document.getElementById('security-answer')?.focus();
}

async function checkSecurityAnswer() {
  const val = document.getElementById('security-answer')?.value || '';
  const hash = await sha256Hex(val.trim());
  if (hash === SECURITY_ANSWER_HASH) {
    _newPin1 = ''; _newPin2 = ''; _newPinStage = 1;
    showSetNewPinScreen();
  } else {
    showForgotPinScreen({ error: 'Incorrect answer' });
  }
}

function showSetNewPinScreen(opts = {}) {
  const stage = _newPinStage;
  const buf = stage === 1 ? _newPin1 : _newPin2;
  document.body.innerHTML = `
    <div class="pin-screen">
      <div class="pin-title">EDGE2</div>
      <div class="pin-subtitle">${stage === 1 ? 'Set New PIN' : 'Confirm New PIN'}</div>
      <div class="pin-boxes${opts.shake ? ' shake' : ''}" id="pin-boxes">${pinDotsHtml(buf)}</div>
      <div class="pin-error">${opts.error || ''}</div>
      ${pinNumpadHtml('newPinPress', 'newPinBackspace')}
      <button class="pin-submit" onclick="newPinSubmit()">${stage === 1 ? 'Next' : 'Save'}</button>
    </div>`;
}

function newPinPress(d) {
  if (_newPinStage === 1) {
    if (_newPin1.length >= 4) return;
    _newPin1 += d;
  } else {
    if (_newPin2.length >= 4) return;
    _newPin2 += d;
  }
  showSetNewPinScreen();
}

function newPinBackspace() {
  if (_newPinStage === 1) _newPin1 = _newPin1.slice(0, -1);
  else _newPin2 = _newPin2.slice(0, -1);
  showSetNewPinScreen();
}

async function newPinSubmit() {
  if (_newPinStage === 1) {
    if (_newPin1.length !== 4) return;
    _newPinStage = 2;
    showSetNewPinScreen();
    return;
  }
  if (_newPin2.length !== 4) return;
  if (_newPin2 !== _newPin1) {
    _newPin2 = '';
    showSetNewPinScreen({ error: 'PINs do not match', shake: true });
    return;
  }
  const hash = await sha256Hex(_newPin1);
  localStorage.setItem('edge2_pin_hash', hash);
  sessionStorage.setItem('edge2_pin_verified', 'true');
  _newPin1 = ''; _newPin2 = ''; _newPinStage = 1;
  location.reload();
}

// ── 1. CONSTANTS ────────────────────────────────────────────────

const VERSION = 'v2.9.1';
const ALPACA_BASE = 'https://data.alpaca.markets/v2';
const GROQ_MODEL = 'openai/gpt-oss-20b';

// ── Supabase ─────────────────────────────────────────────────────
// Client is named supabaseClient (not `supabase`) — the CDN bundle's UMD
// wrapper puts the library itself on window.supabase, and declaring a
// top-level `const supabase` in a classic (non-module) script collides
// with that global and throws "Identifier 'supabase' has already been
// declared" in some load orders.
const SUPABASE_URL = 'https://kbjqxaukyawcmcyjoiey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JXOwCMF_a5ylZL8V5mwfzw_MRivRMpl';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
// Sum of every signal's max POSITIVE points in scoreStock() — Scoring Formula v2
// (Change 8/9): Volume spike 20 (was 30) + Price momentum 20 + RSI position 20 +
// Above 20-day MA 10 + Volume build 15 + Mean reversion 20 + Consecutive up days 15 +
// Relative strength 15 + Catalyst setup 10 (Change D) = 145. Deliberately excludes
// the new negative signals (RSI 75+ = -10, Volume 3x+ = -10) — the denominator uses
// max positive points only, per spec, so a score can never exceed 100 regardless of
// which penalties fire. Also excludes the Sub-$10 entry timing adjustment (Change C),
// which is a tier-specific overlay applied on top of this max, not pooled into it.
// Used to normalize the raw signal score to a true 0-100 scale. Re-verify
// this sum against scoreStock() if any signal's point value ever changes.
// Does NOT include the Macro Market Overlay adjustment — that's applied
// after normalization, on the already-0-100 score, not pooled into this max.
const RAW_SCORE_MAX = 145;
// VIX excluded — it's a CBOE index, not an equity, and is not obtainable through
// Alpaca's /stocks endpoints on any tier. See Macro Market Overlay addendum.
const MACRO_ETFS = ['SPY', 'XLE', 'XLK', 'XBI', 'XLF', 'XLI', 'XLRE', 'XLY'];
// Confirmed in production: Alpaca rejects a batch /stocks/snapshots request
// with a 400 ("invalid symbol") the moment it contains one malformed ticker
// (AAC-U did this) — it does NOT silently omit just that symbol as originally
// assumed below. AAC-U has since been removed from FINANCIAL entirely; these
// remaining 6 are unverified hyphen/share-class tickers (SPAC units, one
// dual-class stock) still in FINANCIAL, now caught unconditionally by
// sanitizeTickerBatch() before any request goes out — this list only drives
// checkUnresolvedSymbols()'s console warning so an exclusion is visible
// rather than silent, it doesn't gate what gets sent anymore.
const UNVERIFIED_HYPHEN_SYMBOLS = ['CRD-A', 'DGAC-U', 'FTRA-U', 'MTNE-U', 'OCAC-U', 'SAMO-U', 'VII-U'];
const MACRO_CONDITIONS = [
  'RISK_OFF', 'GEOPOLITICAL', 'TECH_ROTATION_OUT', 'BROAD_RALLY', 'MOMENTUM_DAY',
  'SECTOR_WEAKNESS_BIOTECH', 'SECTOR_WEAKNESS_ENERGY', 'SECTOR_WEAKNESS_TECH', 'CHOPPY'
];

// ── STOCK UNIVERSES ──────────────────────────────────────────────
const STOCK_UNIVERSES = {
  HEALTHCARE: [...new Set([
  'AARD','ABEO','ABOS','ABSI','ABUS','ABVC','ACH','ACHV','ACRS','ACRV',
  'ACTU','ACXP','ADGM','ADIL','ADMA','AEMD','AEON','AGEN','AHCO','AIDX',
  'AIM','AIRS','AKBA','AKTX','ALDX','ALEC','ALGS','ALLO','ALLR','ALT',
  'ALXO','ALZN','AMLX','AMRX','AMS','ANGO','ANIX','ANNX','ANTX','ANVS',
  'APRE','APUS','APYX','AQST','ARAY','ARCT','ARDT','ARDX','ARMP','ARTL',
  'ARTV','ARVN','ASBP','ATAI','ATEC','ATNM','ATOS','ATRA','ATYR','AURA',
  'AVAH','AVIR','AVR','AVTR','AVTX','AVXL','AZTR','BBNX','BBOT','BCDA',
  'BCRX','BDTX','BEAT','BFLY','BFRG','BFRI','BHVN','BIAF','BIVI','BJDX',
  'BKD','BMEA','BNGO','BNTC','BOLD','BRTX','BTAI','BTMD','BVS','CABA',
  'CADL','CAI','CALC','CAMP','CAPR','CARL','CATX','CBIO','CBLL','CBUS',
  'CCCC','CCLD','CCRN','CDT','CDXS','CELU','CELZ','CERS','CERT','CGEM',
  'CGTX','CHRS','CING','CLDI','CLNN','CLOV','CLPT','CLRB','CLYM','CMPX',
  'CNSP','CNTB','CNTN','CNTX','CNXU','COCH','COCP','CODX','COYA','CPIX',
  'CRBP','CRBU','CRDF','CRIS','CRMD','CRVO','CRVS','CTKB','CTMX','CTNM',
  'CTSO','CTXR','CV','CVM','CVRX','CYH','CYPH','DARE','DCGO','DCOY',
  'DCTH','DERM','DH','DMAC','DNA','DSGN','DTIL','DYAI','EBS','ECOR',
  'EDIT','EIKN','ELAB','ELDN','ELTX','ELUT','EMBC','ENSC','ENTA','ENVB',
  'EOLS','EQ','ERAS','ERNA','ESPR','EVH','EVMN','EYPT','FATE','FBIO',
  'FBLG','FDMT','FEED','FENC','FHTX','FLNA','FTRE','FULC','GALT','GANX',
  'GCTK','GDRX','GENB','GERN','GLAS','GLSI','GMRS','GNLX','GOSS','GOVX',
  'GRCE','GRDX','GTBP','GUTS','HCAT','HCTI','HCWB','HKPD','HOWL','HRTX',
  'HSCS','HUMA','HURA','HYFT','HYPD','HYPR','IART','IBIO','IBRX','IGC',
  'IKT','IMDX','IMMX','IMRX','IMUX','INBS','INDP','INFU','INGN','INMB',
  'INNV','INO','IOVA','IPSC','IRD','IRWD','ISPC','IVF','IVVD','JANX',
  'JSPR','JUNS','JYNT','KALA','KAPA','KLRA','KPTI','KRMD','KROS','KRRO',
  'KTTA','KURA','KYTX','LAB','LABT','LCTX','LENZ','LFCR','LFMD','LFST',
  'LGVN','LIMN','LITS','LMRI','LNAI','LPCN','LRMR','LSTA','LTRN','LUCD',
  'LUCY','LUNG','LXEO','LXRX','LYEL','MAIA','MASS','MBIO','MBOT','MBRX',
  'MDAI','MDXG','MGNX','MGRX','MGTX','MGX','MIRA','MLSS','MMED','MNKD',
  'MOBI','MRVI','MTNB','MTVA','MXCT','MYGN','MYO','NAGE','NAUT','NBP',
  'NEO','NEOG','NERV','NKTX','NMRA','NNVC','NPCE','NRXP','NRXS','NSPR',
  'NTLA','NUVB','NUWE','NVAX','NVCT','NXGL','NXL','NXTC','OABI','OBIO',
  'OCGN','OCUL','ODTX','OFIX','OGN','OKUR','OLMA','OM','OMER','ONCO',
  'ONCY','ONMD','OPK','OPRX','ORGO','ORIC','ORMP','OSRH','OSTX','OSUR',
  'OTLK','OVID','OWLT','PACB','PALI','PASG','PBYI','PDSB','PEPG','PETS',
  'PFSA','PGEN','PHAT','PHIO','PHR','PIII','PLRX','PLX','PLYX','PMCB',
  'PMI','PMVP','PRCT','PRLD','PRME','PROK','PSNL','PSTV','PYXS','QDEL',
  'QNRX','QSI','QTRX','QTTB','QUCY','RANI','RCEL','RCKT','REPL','RGNX',
  'RLAY','RLMD','RLYB','RNA','RNAC','RNTX','RNXT','RPID','RXRX','RXST',
  'RZLT','SABS','SANA','SBFM','SCLX','SCNX','SDGR','SEER','SENS','SGHT',
  'SGMT','SGRY','SHC','SHPH','SIBN','SIGA','SILO','SKYE','SLDB','SLP',
  'SLS','SMMT','SNGX','SNOA','SNTI','SNWV','SNYR','SPOK','SPRO','SPRY',
  'SPTX','SRPT','SRTA','STIM','STTK','STXS','SVRA','TALK','TARA','TBPH',
  'TCRX','TDOC','TELA','TELO','TENX','TKNO','TLPH','TLSI','TMCI','TNDM',
  'TNON','TNXP','TNYA','TOI','TOVX','TPST','TRAW','TRDA','TRLV','TRVI',
  'TSHA','TVRD','UNCY','UPB','VANI','VBIO','VERU','VIR','VIVS','VMD',
  'VNDA','VNRX','VOR','VRDN','VREX','VSEE','VSTM','VTAK','VTGN','VTRS',
  'VVOS','VYGR','VYNE','WEAV','WGRX','WHWK','WW','XCUR','XERS','XFOR',
  'XGN','XNCR','XRAY','XTNT','XWEL','YCBD','ZNTL','ZURA','ZVRA',
  ])],
  ENERGY: [...new Set([
  'ACDC','AESI','AMPY','ANNA','BATL','BRN','BSIN','BSM','CLB','CLNE',
  'CRGY','CRK','DEC','DTI','DWSN','EGY','EONR','EP','EPM','EPSN',
  'EU','FTW','GEL','GEOS','GLND','GRNT','HLX','HMH','HPK','IEP',
  'INR','KGEI','KLXE','KOS','KRP','MNR','MVO','NEXT','NFE','NGL',
  'NINE','NOV','NRT','NUCL','OIS','PR','PROP','PRT','PTEN','PUMP',
  'PVL','REI','RES','RNGR','SD','SJT','SKYQ','SND','SOC','TALO',
  'TPET','TXO','UEC','URG','UUUU','VG','VIVK','VOC','VTS','WTI',
  'WTTR','XPRO',
  ])],
  // LIST 4a: TECH — Technology sector (semis, software, AI, cybersecurity,
  //   hardware). Finviz-verified, $1-$20, Technology sector classification.
  TECH: [...new Set([
  'ADTN','AEVA','AEYE','AGPU','AI','AIB','AIFA','AIFC','AIFF','AIMD',
  'AIOT','AIRG','AISP','AIXC','ALKT','ALMU','AMCI','AMPG','AMPL','AMST',
  'AMZE','APPS','ARAI','ARRY','ASAN','ASTC','ASTI','ASUR','ASYS','ATOM',
  'AUID','AUUD','AVPT','AWRE','AXIL','AZIO','BBAI','BEEM','BKKT','BLIN',
  'BLND','BLZE','BNAI','BNZI','BOXL','BULL','BZAI','CCC','CETX','CIFR',
  'CISO','CLRO','CMRC','CMTL','CNDT','CPSH','CRCT','CRNC','CRSR','CSAI',
  'CTM','CXAI','CXM','CYCU','CYN','DAIC','DAIO','DAKT','DDD','DHX',
  'DMRC','DOMO','DSP','DUOT','DVLT','DXC','EFOR','EGAN','EGHT','EVCM',
  'EXFY','EXOD','EXYN','FATN','FCUV','FLYW','FOXX','FRGT','FRMM','FRSH',
  'FSLY','FTCI','FTFT','FUSE','GCTS','GDYN','GGRP','GLOO','GNSS','GOAI',
  'GPRO','GRND','GSIT','GTM','HCKT','HIT','HLIT','IDAI','IDN','III',
  'ILLR','IMMR','IMXI','INDI','INFQ','INSG','INTT','INTZ','INUV','IPWR',
  'IQMX','JTAI','KD','KDK','KEEL','KLTR','KNRX','KOPN','KULR','KVYO',
  'LAW','LIDR','LINK','LPSN','LPTH','LTRX','LYFT','MEI','MIND','MITK',
  'MITQ','MNTN','MOBX','MOVE','MQ','MRAM','MSAI','MSN','MVIS','MYSE',
  'NABL','NCNO','NIQ','NN','NRDY','NTSK','NUAI','NVTS','OBAI','OCC',
  'OCTV','OLB','ONDS','OPTX','OSPN','OSS','PAR','PATH','PAYO','PAYS',
  'PD','PDYN','PGY','PHUN','PRSO','PRTH','PUBM','PXLW','QBTS','QCLS',
  'QMCO','QUBT','QUIK','RBBN','RDZN','REKR','RELL','RGTI','RIME','RKTO',
  'RMNI','RMSG','ROC','RPAY','RPD','RSSS','RTB','RUN','RXT','S',
  'SABR','SAIL','SCKT','SECZ','SHLS','SKYA','SMRT','SMSI','SMXT','SOBR',
  'SONO','SOUN','SPT','SPWR','SSTI','SSYS','SUNE','SVCO','TACT','TAOX',
  'TASK','TBCH','TGL','THRY','TLS','TONX','TRAK','TRT','TSSI','TTEC',
  'TTGT','TYGO','UAVS','UIS','UMAC','USBC','USIO','VEEA','VELO','VERI',
  'VERX','VIA','VIDA','VISN','VRRM','VS','VTIX','VTSI','VUZI','VYX',
  'WATT','WLTH','WRAP','WYY','XPER','YEXT','ZEO','ZSQR',
  ])],
  // LIST 4b: RETAIL — INTERIM/UNVERIFIED. This is everything from the old
  //   combined TECH universe that is NOT in the new TECH list above, carried
  //   over as-is so nothing silently disappeared during the TECH/RETAIL split.
  //   It has NOT been screened against a Retail-sector source and mixes in
  //   unrelated categories (banks, biotech, industrials, etc.) inherited from
  //   the old combined list. Replace with a verified Retail-sector ticker list.
  //   45 tickers correctly identified as Financial-sector (SOFI, RKT, MARA,
  //   crypto miners, etc.) were pruned from here when FINANCIAL was added,
  //   since they now live in that verified list instead. 35 more tickers
  //   correctly identified as Industrials-sector (BLNK, PLUG, FCEL, HYLN,
  //   etc.) were pruned when INDUSTRIAL was added, same reason. 12 more
  //   tickers correctly identified as Real Estate-sector (REITs, plus ALBT —
  //   see ALBT note below) were pruned when REAL_ESTATE was added.
  RETAIL: [...new Set([
  'AAON','ABST','ACCD','ACEL','ACHC','ACLS','ACMR','ACNB','ACNI','ACOR',
  'ACPW','ACRS','ACRX','ACST','ACTU','ACUN','ACUP','ACUQ','ACVA','ADAP',
  'ADAT','ADAW','ADAX','ADBE','ADBI','ADBN','ADBP','ADCX','ADCY','ADCZ',
  'ADDA','ADDE','ADDF','ADDG','ADDH','ADDI','ADDK','ADDL','ADDM','ADDN',
  'ADDO','ADDP','ADDQ','ADDR','ADDS','ADDT','ADDU','ADDV','ADDW','ADDX',
  'ADDY','ADDZ','ADEN','ADEP','ADER','ADES','ADET','ADEX','ADEY','ADEZ',
  'ADFG','ADFH','ADFI','ADFJ','ADFK','ADFL','ADFM','ADFN','ADFO','ADFP',
  'ADFQ','ADFR','ADFS','ADFT','ADFU','ADFV','ADFW','ADFX','ADFY','ADFZ',
  'ADGA','ADGB','ADGC','ADGD','ADGE','ADGF','ADGG','ADGH','ADGI','ADGJ',
  'ADGK','ADGL','ADGM','ADGN','ADGO','ADGP','ADGQ','ADGR','ADGS','ADGT',
  'ADGU','ADGV','ADGW','ADGX','ADGY','ADGZ','ADHA','ADHB','ADHC','ADHD',
  'ADHE','ADHF','ADHG','ADHH','ADHI','ADHJ','ADHK','ADHL','ADHM','ADHN',
  'ADHO','ADHP','ADHQ','ADHR','ADHS','ADHT','ADHU','ADHV','ADHW','ADHX',
  'ADHY','ADHZ','ADMA','ADNA','ADNT','ADUS','AEHR','AEIS','AFRM','AGAE',
  'AGCO','AGFS','AGIO','AGRO','AGTI','AGYS','AHCO','AHPI','AIMC','AINV',
  'AIRC','AIRI','AIWS','AIXI','AJRD','AKAM','AKBA','AKLI','AKRO','AKTS',
  'AKYA','ALCO','ALCX','ALEC','ALGM','ALGT','ALHC','ALIM','ALIT','ALLK',
  'ALLO','ALLT','ALNY','ALOT','ALPP','ALRM','ALRN','ALSK','ALTO','AMBA',
  'AMBC','AMBO','AMC','AMCB','AMCR','AMCX','AMEH','AMER','AMKR','AMLX',
  'AMMO','AMNB','AMOB','AMOT','AMPE','AMPH','AMPS','AMRN','AMRS','AMRX',
  'AMSC','AMSWA','AMTB','AMTD','AMTX','AMWL','ANF','ANGI','AOSL','APEI',
  'APLD','APOG','APPF','APPN','ARAY','ARCO','ARGO','ARHS','ARKO','ARKR',
  'AROW','ARQQ','ARQT','ARTW','ARUN','ARVL','ARWR','ASAI','ASGN','ASPI',
  'ASPS','ASRT','ASTE','ASTL','ASXC','ATAI','ATCO','ATEC','ATEN','ATER',
  'ATEX','ATHM','ATIP','ATLC','ATMU','ATNI','ATRC','ATSG','ATUS','AUDC',
  'AVAH','AVAV','AVDX','AVEO','AVNS','AVNT','AVNW','AVST','AVXL','AXDX',
  'AXGT','AXLA','AXNX','AXON','AXSM','AXTA','AXTI','AYRO','AZEK','AZUL',
  'AZYO','BAND','BANF','BANR','BARK','BASE','BBSI','BBWI','BCOV','BCPC',
  'BCRX','BEAM','BECN','BEDU','BEKE','BELFA','BELFB','BFAM','BFH','BFIN',
  'BFLY','BFST','BGCP','BGFV','BHLB','BIGC','BILI','BILL','BIRD','BITF',
  'BJDX','BJRI','BKEN','BKFS','BKSY','BKTI','BKYI','BLBD','BLDE','BLDP',
  'BLKB','BLMN','BMBL','BMEA','BMI','BMRA','BMRC','BMRN','BNED','BNFT',
  'BNGO','BOKF','BOOT','BORR','BOX','BPFH','BPMC','BPOP','BPRN','BPTH',
  'BRBR','BRCC','BRDG','BRDS','BRFS','BRID','BRMK','BROS','BRPM','BRZE',
  'BSAC','BSET','BSIG','BSQR','BSRR','BSTC','BSVN','BTAI','BTDR','BTMD',
  'BTRS','BURL','BUSE','BWFG','BWMX','BWXT','BYFC','BYND','BYON','BYSI',
  'BZFD','BZUN','CAAS','CADE','CAKE','CALX','CAMP','CAMT','CANG','CANO',
  'CARA','CARG','CARS','CASH','CASS','CATO','CATY','CAVA','CBAN','CBAY',
  'CBFV','CBIO','CBMG','CBNK','CBRL','CBSH','CBTX','CCCS','CCNE','CCOI',
  'CCRN','CCRT','CCSI','CCUR','CDEV','CDLX','CDNA','CEI','CELC','CELH',
  'CELU','CENN','CERC','CERT','CEVA','CFFI','CFLT','CFNB','CFRA','CFSB',
  'CGEM','CGNT','CGNX','CHCO','CHDN','CHEF','CHEK','CHFS','CHGG','CHKP',
  'CHPT','CHUY','CHWY','CIEN','CIFS','CLAR','CLBT','CLFD','CLNE','CLNV',
  'CLOV','CLPS','CMBM','CMC','CMLS','CMPO','CNF','CNSL','CNXN','COHU',
  'CONN','COOK','CORZ','COTY','COUR','COVA','CPAI','CPAX','CPRI','CPRX',
  'CPSI','CPSS','CRAI','CRDF','CRDO','CRESY','CRMT','CRNT','CROX','CRTO',
  'CRUS','CRVO','CRVS','CRWD','CSGS','CSII','CSKI','CSPI','CSTE','CSTR',
  'CSV','CSWI','CTBI','CTHR','CTIC','CTLP','CTMX','CTRN','CTSO','CULP',
  'CURO','CUTR','CVBF','CVCO','CVCY','CVGI','CVGW','CVLG','CVNA','CWCO',
  'CYBR','CZWI','DADA','DAVA','DAVE','DCBO','DCGO','DCOM','DCRB','DCTH',
  'DENN','DERM','DFFN','DFIN','DGII','DINE','DIOD','DISCO','DISH','DJT',
  'DKNG','DLPN','DLTH','DM','DMAC','DMDV','DMTK','DNAI','DNMR','DNTX',
  'DNUT','DOCN','DOCS','DOCU','DOGZ','DOMA','DOMK','DOYU','DPRO','DPSI',
  'DPTX','DQ','DRRX','DRS','DRVN','DRWN','DRXL','DSSI','DTC','DTEA',
  'DTIL','DTRM','DTSS','DTST','DUOL','DUOS','DV','DVAX','DWAC','DWSN',
  'DXPE','DXYN','DYAI','DYNS','DYNT','DZSI','EAGL','EARS','EASY','EAT',
  'EBAY','EBON','ECIA','ECOR','ECPG','ECVT','EDAP','EDBL','EDCO','EDFU',
  'EDGR','EDTK','EDUC','EEFT','EGIO','EGLX','EGOV','EGRX','EH','EKSO',
  'ELEV','ELF','ELFD','ELLO','ELMD','ELMO','ELON','ELOX','ELST','ELTK',
  'ELVA','ELVN','ELVS','ELVT','ELYS','EMCF','EMED','EMER','EMKR','EMMS',
  'EMNT','EMOW','EMPL','EMPS','ENAB','ENBP','ENCO','ENDO','ENER','ENFN',
  'ENIB','ENOB','ENPH','ENRT','ENTG','ENTV','ENVA','ENVB','ENVE','ENVI',
  'ENVT','ENVY','ENZN','EOLS','EPAZ','EPIC','EPIQ','EPIX','EPOW','EPRT',
  'EPSN','EPWK','EPWT','EQBK','EQFN','EQOS','EQRR','EQST','ERAS','ERIC',
  'ERIN','ERLY','ESAB','ESCA','ESGR','ESLA','ESNA','ESNT','ESOC','ESPR',
  'ESSA','ESSC','ESTA','ESTC','ESTE','ESTR','ESXB','ETSY','ETTX','ETWO',
  'EVBG','EVER','EVERI','EVFM','EVGO','EVIO','EVLO','EVMT','EVNN','EVOP',
  'EVRI','EVRL','EVRO','EVRS','EVSB','EVSI','EVTC','EWCZ','EXAS','EXEL',
  'EXLS','EXNT','EXPC','EXPI','EXPR','EXPS','EXQR','EXRX','EXTC','EXTD',
  'EXTN','EXTR','EYEG','EYEN','EYES','EYPT','EZGO','FARO','FAT','FATH',
  'FBIZ','FBMS','FCFS','FCNCA','FCPT','FCRD','FDBC','FDMT','FDUS','FEAT',
  'FEIM','FELE','FENV','FEYE','FFAI','FFBC','FFBH','FFBW','FFIC','FFIN',
  'FFIV','FFLC','FFMR','FFNM','FFOR','FFRM','FFWM','FGBI','FGCO','FGEN',
  'FGNA','FGPR','FHBI','FHCO','FHLT','FIGS','FIHL','FINB','FINV','FINW',
  'FISI','FISR','FISS','FIVE','FIVN','FIXX','FKWL','FLIC','FLMN','FLNC',
  'FLNT','FLNX','FLWS','FLXS','FMAO','FMBH','FMBK','FMCB','FMFG','FMNC',
  'FMST','FMTX','FND','FNKO','FNLC','FOCS','FOLD','FONR','FONV','FORC',
  'FORM','FOSL','FOUR','FOXF','FPAY','FPBI','FRAF','FRBK','FREQ','FREY',
  'FREYR','FRGE','FRHC','FRLA','FRMO','FROG','FRPH','FRPT','FRSB','FRSG',
  'FRTX','FRVA','FRXB','FSBC','FSBW','FSFG','FSR','FSRX','FSSI','FSTR',
  'FTDR','FTNT','FTRE','FTSP','FUBO','FULL','FULT','FUMB','FUNC','FUNO',
  'FUSB','FUTU','FVAM','FWAA','FWBI','FWRG','FXCO','FXLV','FXNC','GABC',
  'GALT','GAMB','GANO','GASS','GATC','GATE','GATS','GCAM','GCBC','GCEH',
  'GCI','GCPT','GCST','GDCL','GDRX','GDS','GEEX','GELS','GEMS','GENC',
  'GENI','GENK','GENM','GENN','GENO','GENQ','GENS','GENU','GENZ','GES',
  'GFAI','GFIH','GGAL','GGES','GH','GHIX','GHLD','GHSI','GIAN','GIGA',
  'GIII','GILT','GISH','GKOS','GLAD','GLBE','GLBS','GLDD','GLEN','GLEO',
  'GLES','GLMD','GLNG','GLNV','GLOB','GLOP','GLPG','GLPI','GLRE','GLSI',
  'GLTR','GLUE','GLUX','GMBL','GNOG','GOEV','GOGL','GOOS','GOTU','GPAC',
  'GPS','GRAB','GRIN','GRPN','GRVY','GSAT','GSM','GTES','GTLB','GTLS',
  'GTN','HAFC','HASI','HBI','HCAT','HEAR','HELE','HGV','HIBB','HIIQ',
  'HIMS','HIMX','HIPO','HLLY','HLTH','HMHC','HMST','HNNA','HNRG','HNST',
  'HOFT','HOLI','HOLX','HOMB','HONE','HOOD','HOOK','HOPU','HOTT','HOUS',
  'HPCO','HPKK','HPNN','HPVR','HRGE','HRMY','HROW','HRPK','HRTG','HRTH',
  'HRTS','HSAI','HSCS','HSEN','HSIC','HSKI','HSON','HSTM','HTBI','HTBK',
  'HUT','HUYA','HVT','HYFM','HYZN','IART','IBCP','IBER','IBEX','IBIO',
  'IBOC','ICAD','ICCC','ICCM','ICCT','ICDI','ICFI','ICHR','ICLK','ICNB',
  'ICPT','ICUI','IDCC','IDCX','IDDI','IDEA','IDEV','IDEX','IDHC','IDLE',
  'IDLV','IDMA','IDME','IDMG','IDMI','IDMK','IDML','IDMM','IDMN','IDMO',
  'IDMP','IDMQ','IDMR','IDMS','IDMT','IDMU','IDMV','IDMW','IDMX','IDMY',
  'IDMZ','IDNA','IDNB','IDNC','IDND','IDNE','IDNF','IDNG','IDNH','IDNI',
  'IDNJ','IDNK','IDNL','IDNM','IDNN','IDNO','IDNP','IDNQ','IDNR','IDNS',
  'IDNT','IDNU','IDNV','IDNW','IDNX','IDNY','IDNZ','IDT','IFLG','IGMS',
  'IH','IHRT','IIIN','IIPR','ILAG','IMAB','IMAC','IMAG','IMAN','IMAX',
  'IMBI','IMCC','IMCR','IMDX','IMGN','IMGO','IMGP','IMKTA','IMMP','IMNN',
  'IMOM','IMOS','IMPM','IMRN','IMSN','IMTX','IMUX','IMVT','INBK','INBX',
  'INCA','INCO','INCR','INCU','INEI','INET','INFA','INFN','INFU','INMD',
  'INNE','INOD','INPX','INSE','INSI','INSP','INSS','INST','INSW','INSY',
  'INTF','INTG','INVA','INVI','INVV','INVX','INVZ','INXN','INZY','IOAC',
  'IOCS','IOFX','IONQ','IOT','IOVA','IPAR','IPAX','IPGP','IPIX','IPKW',
  'IPRX','IPSC','IPSN','IPVF','IPXX','IQ','IQBT','IQMD','IQMK','IQNX',
  'IQRM','IQST','IQVI','IRBT','IRCP','IRDM','IRDN','IREN','IRGT','IRGX',
  'IRIX','IRMD','IRNT','IROQ','IRTC','ITRI','ITRN','JACK','JAKK','JAMF',
  'JBDI','JJSF','JKHY','JMIA','JMU','JNPR','JOAN','JOUT','JSMD','JUSH',
  'JUVA','JYNT','KALA','KALI','KALU','KC','KCSR','KFRC','KGEI','KGRN',
  'KHOLY','KINZ','KIRK','KISN','KIWA','KLIC','KLNT','KLVT','KMDA','KMPR',
  'KNBE','KNDI','KNOP','KNSA','KNSL','KOSS','KPLT','KPRX','KPTI','KRBP',
  'KRMD','KRON','KROS','KRTX','KRUS','KSPI','KSPN','KSTR','KTOS','KVHI',
  'KVSA','KXIN','LAAC','LAC','LACQ','LAKE','LALT','LASR','LAUR','LAWS',
  'LAZR','LBAI','LBAY','LBIX','LBPH','LBPS','LBRD','LBRDA','LBRDK','LBSR',
  'LBTYA','LBTYK','LC','LCID','LCII','LCNB','LCNW','LCUT','LDOS','LEGH',
  'LENZ','LESL','LFAP','LFEN','LFGR','LFMD','LFST','LFUS','LGF','LGIH',
  'LGND','LGST','LGVN','LHDX','LI','LICY','LIFT','LIFX','LILI','LILM',
  'LIMAF','LINC','LINM','LION','LIQT','LITB','LIVN','LIVO','LIVX','LIZI',
  'LKFN','LLAP','LLIT','LLNW','LMND','LMNR','LMPX','LNDC','LNKB','LNN',
  'LNSR','LNTH','LOAN','LOCO','LOGI','LOMA','LOPE','LORX','LOTZ','LOUP',
  'LOVE','LPLA','LQDA','LQDT','LRCX','LRMR','LSAQ','LSCC','LSEA','LSEQ',
  'LSPD','LSXMA','LTHM','LTRN','LTRY','LULU','LUMN','LUNA','LURI','LVEX',
  'LVLU','LVNS','LVOX','LVPB','LVVV','LVWR','LWAY','LWLG','LXFN','LXNX',
  'LXRX','LYRA','MAIA','MAKO','MAMS','MANU','MAQC','MARK','MATW','MAXN',
  'MAYS','MBCN','MBII','MBIO','MBLY','MBRX','MBSC','MBVX','MCAA','MCAC',
  'MCAF','MCBC','MCCF','MCRI','MDB','MDJM','MDVX','MDXG','MED','MFGP',
  'MFLR','MFMS','MFNA','MFNC','MFNX','MGNI','MGRC','MGRM','MGRX','MGTA',
  'MGTI','MGTX','MIGI','MKFG','MKSI','MLCO','MLKN','MMSI','MMYT','MNDO',
  'MNDT','MNDY','MNKD','MNMD','MNOV','MNPR','MNRD','MNRK','MNRO','MNSI',
  'MNSN','MNTK','MNTV','MNVT','MNWN','MODG','MODN','MODV','MOGO','MOMO',
  'MOV','MPLN','MPWR','MRIN','MRVL','MSGE','MSRT','MTAL','MTCH','MTLS',
  'MTSI','MTTR','MX','MYSZ','NARI','NATH','NBIX','NCMI','NCTY','NDLS',
  'NEGG','NEOG','NERD','NERV','NESR','NETD','NETE','NEVI','NEVS','NEVT',
  'NEWG','NEWM','NEWP','NFLX','NGVC','NKLA','NKTR','NLOK','NMIH','NNDM',
  'NOMD','NOVA','NOVT','NRDS','NRXP','NSTG','NTAP','NTCT','NTES','NTGR',
  'NTST','NTWK','NVCR','NVEC','NVEE','NVEI','NVST','NWSA','NXPI','NXPL',
  'NXST','OLED','OLPX','OMCL','OMER','OMEX','OMGA','OMHL','OMIC','ONAM',
  'ONCE','ONCT','ONCX','ONEM','ONEW','ONFO','ONIT','ONMD','ONNT','ONOA',
  'ONON','ONOV','ONTO','OOMA','OPBK','OPCH','OPCO','OPRA','OPRX','OSIS',
  'OTRK','OUST','OWLET','PAGS','PANW','PARA','PARR','PATI','PAYA','PAYX',
  'PBPB','PCOR','PCTI','PDCE','PDD','PDFS','PEGA','PEGY','PEMB','PENB',
  'PENG','PENM','PENN','PENR','PENS','PENX','PEPH','PERC','PERI','PERW',
  'PETN','PETS','PETZ','PFBC','PFBI','PFBQ','PFBS','PFBT','PFBV','PFBW',
  'PFCB','PFCC','PFCD','PFCE','PFCF','PFCG','PFCH','PFCI','PFCJ','PFCK',
  'PFCL','PFCM','PFCN','PFCO','PFCP','PFIS','PFIX','PFNX','PHVS','PLAB',
  'PLAY','PLBY','PLCE','PLMR','PLNA','PLNF','PLNG','PLNH','PLNI','PLNJ',
  'PLNK','PLNL','PLNM','PLNN','PLNO','PLNP','PLNQ','PLNR','PLNS','PLNT',
  'PLNU','PLNV','PLNW','PLNX','PLNY','PLNZ','PLTK','PLTR','PLXS','PNTG',
  'PNTM','POWI','PRCT','PRFT','PRGS','PRGX','PROG','PRPL','PRTS','PRVA',
  'PSFE','PTEN','PTLO','PTON','PTRA','PZZA','QCRH','QFIN','QLYS','QNST',
  'QRVO','RAMP','RCBI','RCBK','RCII','RCM','RCMT','RCON','RDFN','RDWR',
  'REAL','REED','REGI','RELY','RENT','RERE','REVG','RIDE','RIVN','RLAY',
  'RMBL','RMBS','RMCF','ROKU','ROOT','RRGB','RSKD','RUTH','RVLV','RXRX',
  'SBGI','SBLK','SCSC','SCVL','SCWX','SDIG','SEAC','SEAT','SEER','SELB',
  'SFNC','SFT','SFUN','SGHC','SHAK','SHEN','SIFY','SILC','SILK','SILV',
  'SIMO','SIRI','SITM','SKIN','SKLZ','SKX','SLAB','SLB','SLCA','SLI',
  'SMAR','SMCI','SMIT','SMPL','SMTC','SNAX','SNBR','SNCE','SNCR','SNDA',
  'SNEX','SNOA','SNOW','SNPS','SNRH','SNSE','SOLO','SPGI','SPLK','SPOK',
  'SPPI','SPRB','SPRC','SPRO','SPRT','SPRU','SQSP','SRCE','SSP','STAA',
  'STAG','STBA','STCN','STEM','STFS','STGW','STIM','STIX','STJM','STKS',
  'STLD','STNE','STNG','STRM','STRS','STRT','STRW','STWO','STXB','STXS',
  'STYD','STZA','SUNW','SVMK','SWKS','SWVL','SYBT','SYNA','SYNH','SYRS',
  'TALK','TANH','TBLA','TCBI','TCJH','TDOC','TDUP','TELA','TENB','TGTX',
  'THWX','TIGR','TILE','TISI','TKLF','TKNO','TLIS','TLND','TLYS','TMCI',
  'TMDI','TME','TNDM','TPIC','TPR','TREX','TRIP','TRIT','TRMR','TRNC',
  'TRNS','TROO','TRVG','TSEM','TTCF','TTMI','TTWO','TUEM','TUFN','TUYA',
  'TWLO','TWST','TXMD','TXRH','TZOO','UA','UAMY','UBER','UCTT','UDMY',
  'UEIC','UEPS','UFCS','UFPI','UGRO','ULTA','UMBF','UMC','UMRX','UNFI',
  'UNTY','UPLD','UPST','UPTS','UPWK','URBN','UROS','URRN','VCYT','VEEV',
  'VERA','VERB','VERL','VERS','VERT','VERV','VERY','VEST','VETX','VFC',
  'VFFB','VGFC','VIAC','VIAO','VIAP','VIAR','VIAV','VICR','VIPS','VIST',
  'VITL','VJET','VLDR','VNDA','VNET','VOXX','VRM','VRNS','VRNT','VSCO',
  'VSLR','VSTO','VTEX','VVPR','W','WAL','WB','WEAV','WEN','WGMI',
  'WINA','WING','WINT','WIRE','WKHS','WOLF','WOOF','WPRT','WRLD','WTTR',
  'XCUR','XELB','XFOR','XIN','XMTR','XNCR','XOMA','XPEL','XPLR','XPOF',
  'XTNT','XXII','YJ','YMAB','YTRA','YUMM','ZAGG','ZETA','ZEUS','ZEV',
  'ZFOX','ZI','ZIXI','ZLAB','ZNGA','ZNTL','ZS','ZUMZ','ZYME','ZYXI',
  ])],
  // LIST 4c: FINANCIAL — Financial sector per Finviz classification. Broader
  //   than typical "financial stocks": includes operating companies (banks,
  //   insurers, asset managers, broker-dealers) plus a large number of ETFs
  //   (many leveraged/inverse single-stock and crypto ETFs), SPAC shells, and
  //   closed-end funds — all included since they're tradeable as regular
  //   equities. Scoring logic should not assume operating-company behavior:
  //   leveraged ETFs amplify/decay off an underlying rather than having their
  //   own catalysts, SPAC shells sit flat near $10 pre-deal, and closed-end
  //   funds trade more on NAV/dividend yield than momentum.
  FINANCIAL: [...new Set([
  'AACP','AAOG','AAOX','AAPD','ABTC','ABX','ACGC','ACIC','ACP','ADBG',
  'AEF','AEHG','AEMS','AESP','AESR','AEXA','AFB','AFCG','AFIF','AFRU',
  'AGD','AII','AIYY','ALF','ALPX','ALTI','ALUB','AMAN','AMAX','AMKL',
  'AMPU','AMZD','AMZY','ANSC','ANY','AOD','APLX','APLY','APMC','APUR',
  'APXT','ARCC','ARCL','ARCX','ARDC','ARMG','ARMH','ARTC','ASG','ASST',
  'ASTN','ASTX','ASTY','ATCH','ATII','AVAT','AVK','AVS','AVXX','AWF',
  'AWP','AXTL','AXTU','AXTX','BABU','BACC','BAIG','BATT','BBCQ','BBDC',
  'BBHM','BBLU','BBN','BCAR','BCAT','BCBP','BCCQU','BCG','BCIC','BCSF',
  'BCSS','BCX','BDCI','BDJ','BDRY','BEAG','BGB','BGC','BGDE','BGH',
  'BGR','BGT','BGX','BGY','BHAV','BHK','BIDWU','BIT','BITO','BITU',
  'BITX','BIZD','BKT','BLNE','BLOX','BLSG','BLW','BMEZ','BMNG','BMNR',
  'BMNU','BNBX','BNKK','BOE','BPRE','BRBS','BREZ','BRKHU','BRR','BRRR',
  'BRW','BSCQ','BSCR','BSCT','BSCU','BSCV','BSOL','BTAL','BTBT','BTCL',
  'BTCS','BTCZ','BTGO','BTX','BTZ','BUYW','BWG','CAES','CAII','CANE',
  'CBRG','CBRX','CCAP','CCAQ','CCCTU','CCIF','CCII','CCIX','CCRP','CCUP',
  'CCXI','CD','CEGX','CEPF','CEPO','CEPT','CEPV','CFFN','CGBD','CGCFU',
  'CHI','CHW','CHY','CIA','CIEG','CIFG','CIFU','CIK','CION','CLM',
  'CLSK','CLSX','CMII','COHH','COIG','COIW','CONL','CONX','CONY','COPY',
  'CORD','CORN','COTG','COZX','CPZ','CRAN','CRCA','CRCD','CRCG','CRCO',
  'CRD-A','CRF','CRMG','CRMU','CRMX','CRPT','CRWG','CRWU','CSEX','CTAA',
  'CUB','CWD','CWVX','CXII','DAAQ','DAMD','DAPP','DBCA','DBL','DBO',
  'DBRG','DDFZ','DDTZ','DFDV','DGAC-U','DGICA','DHF','DHY','DIAL','DIV',
  'DJTU','DLY','DMAA','DMII','DNP','DOMH','DPG','DRAL','DRDB','DRN',
  'DRV','DSL','DSM','DSU','DTCX','DUG','DWSH','DXD','DYNC','EAD',
  'EARN','ECAT','ECC','ECHX','EDD','EDF','EDZ','EEV','EFR','EFT',
  'EHI','EHTH','EIC','EIDO','EIM','EMD','EOD','EOSU','ERC','ERY',
  'ESN','ETH','ETHA','ETHE','ETHT','ETHU','ETHW','ETJ','ETU','ETV',
  'ETW','ETY','EUM','EVAC','EVF','EVN','EVV','EWZS','EXG','EZET',
  'EZRA','FACT','FAX','FBLA','FBY','FCBM','FCRS','FCT','FDD','FDMMU',
  'FETH','FFC','FGMC','FGNX','FGRU','FIGX','FLD','FLG','FLYT','FMAC',
  'FMNB','FNB','FNRN','FOF','FOTO','FPE','FPEI','FPF','FRA','FRBA',
  'FRBT','FRST','FSCO','FSIG','FSK','FSMB','FSOL','FSSL','FTCA','FTF',
  'FTHY','FTMA','FTMH','FTMN','FTMS','FTMU','FTNJ','FTNY','FTPA','FTRA-U',
  'FUTG','FVCB','FWACU','FXAC','GAB','GAIN','GBAB','GBDC','GCGR','GCMG',
  'GCV','GDOT','GDXY','GECC','GEMI','GGN','GGT','GHI','GHXIU','GHY',
  'GIAX','GLED','GLGG','GLNK','GLO','GLQ','GLWG','GLXU','GMEU','GNT',
  'GNW','GOF','GOOY','GPAT','GRAF','GREE','GSBD','GSOL','GSRF','GSRV',
  'GSUI','GUG','GUT','HAPN','HBAN','HBR','HDGE','HFRO','HGBL','HGLB',
  'HGTY','HIO','HIPS','HIVE','HIX','HIYY','HODL','HODU','HOOZ','HOPE',
  'HPI','HPS','HQL','HRZN','HSDT','HTAB','HTGC','HUTG','HYI','HYSA',
  'HYT','IACO','IACQ','IAE','IBTK','IBX','ICLN','ICMB','ICOI','IDX',
  'IEAG','IFLN','IFN','IGD','IGR','IHD','IIM','INFH','INV','IONL',
  'IONZ','IPCX','IPFX','IPST','IPVVU','IQI','IRE','IREG','IREX','IREZ',
  'ISD','ISNRU','ISUL','IVOL','IWMY','JABRU','JACS','JCAP','JETD','JFR',
  'JGH','JOBX','JOF','JONEU','JPC','JQC','JRI','JRS','JRVR','KBDC',
  'KBON','KBWD','KBWY','KEYY','KINS','KIO','KMEM','KMLI','KORU','KPDD',
  'KRAQ','KRNY','KTEC','KTF','KTUP','KWY','KYN','LABD','LCCC','LCDL',
  'LDI','LEO','LEUX','LFGY','LIEN','LIFE','LITP','LITU','LMFA','LOFF',
  'LPAA','LPBB','LPRO','LQTI','LTGRU','LULG','LUNL','MARA','MARO','MBAV',
  'MBI','MBS','MCAH','MCHB','MCN','MDIV','MEGI','MEME','METD','METV',
  'MFIC','MFIN','MFM','MGF','MHD','MHF','MIACU','MIN','MIY','MLAA',
  'MLN','MMD','MMT','MMU','MORT','MPG','MQY','MRCOU','MRNY','MSBT',
  'MSD','MSDL','MSFD','MSFL','MSFO','MSFX','MSIF','MSOS','MSOX','MST',
  'MSTP','MSTU','MSTW','MSTX','MSTY','MSTZ','MTNE-U','MUA','MUC','MUD',
  'MUJ','MULL','MUZ','MYI','MYN','MYX','MZYX','NAC','NAD','NAKA',
  'NAN','NAVI','NBB','NBH','NBIG','NBIZ','NBXG','NCA','NCDL','NCIQ',
  'NCPL','NCV','NCZ','NDMO','NEA','NETG','NEWT','NFBK','NFJ','NFLU',
  'NFLY','NFXL','NHIC','NHIV','NHS','NIKL','NKX','NMAI','NMCO','NMFC',
  'NML','NMZ','NOWL','NPAC','NPB','NPCT','NPFD','NRK','NRO','NSLR',
  'NUV','NVD','NVDG','NVDQ','NVDX','NVDY','NVG','NVOX','NVTX','NVYY',
  'NWBI','NXP','NZF','OBDC','OCAC-U','OCCI','OCSL','OFS','OHAC','OIA',
  'OKLL','OMAH','ONDG','ONDL','ONDU','ONG','ONX','OPEG','OPEX','OPFI',
  'OPP','OPRT','ORCU','ORCX','OSG','OSPRU','OTAI','OTF','OTGA','OWL',
  'OXLC','OXSQ','PATX','PAXS','PBD','PCAP','PCF','PCN','PCQ','PCSC',
  'PDBC','PDDL','PDI','PDO','PDT','PECE','PFFD','PFL','PFLD','PFLT',
  'PFN','PFXF','PGF','PGX','PHK','PILL','PIM','PLMK','PLTA','PLTD',
  'PLTG','PLTM','PLTW','PLU','PLUL','PLUN','PML','PMM','PMO','PNBK',
  'PNI','PNNT','POEL','PONX','PPLT','PPT','PRAA','PRCH','PREF','PSBD',
  'PSEC','PTA','PTIR','PTY','PURR','PWP','PWRL','PYPG','QADR','QAT',
  'QBTX','QBTZ','QCMD','QCML','QID','QLEP','QPUX','QQQD','QRED','QSEA',
  'QSU','QUBX','QYLD','RA','RAAQ','RAC','RACD','RAM','RBLU','RCAX',
  'RCS','RDAG','RDWU','RETL','REXC','RFI','RFMZ','RGTU','RGTX','RGTZ',
  'RIET','RILY','RIOT','RIV','RKLX','RKLZ','RKT','RLTY','RMBI','RMT',
  'RPC','RPHS','RQI','RTAC','RVSB','RVT','RWAY','RWM','RYLD','SABA',
  'SAC','SAGU','SAMO-U','SAR','SBET','SBND','SBTU','SBXE','SCD','SCM',
  'SCOP','SDEV','SDHI','SDHY','SEMY','SHFS','SHNY','SHOTU','SHPU','SIEB',
  'SJB','SKDD','SKHL','SKHU','SKHX','SKHZ','SLNH','SLON','SLQT','SLRC',
  'SMB','SMCL','SMCX','SMCY','SMCZ','SMU','SMUP','SNAG','SNDC','SNDG',
  'SNDQ','SNOY','SNXX','SOFA','SOFI','SOFX','SOLZ','SOUX','SPAL','SPAX',
  'SPCF','SPCH','SPCM','SPCU','SPDN','SPFF','SPKL','SPOG','SPSK','SPXX',
  'SPYT','SSAC','SSG','SSK','SSPC','STEW','STEX','STXU','SUIG','SVAQ',
  'SVIV','SVOL','SWZ','SZZL','TACH','TACO','TAIL','TAVI','TCPC','TDAC',
  'TDF','TDWD','TEI','TETH','TEUP','TFSL','THQ','THW','TILL','TIPT',
  'TIPX','TMS','TNGY','TPVG','TRAD','TRIN','TSDD','TSEG','TSI','TSII',
  'TSL','TSLG','TSLL','TSLQ','TSLT','TSLX','TSLZ','TSMY','TSMZ','TTDU',
  'TVIV','TVIVU','TWAV','TXXD','TYA','UAE','UBRL','UBT','UDN','UECG',
  'UGE','ULTI','UMAL','UNG','UNL','UPSX','USA','USAX','USDE','USGG',
  'USLV','USOY','UUUG','UWMC','UXRP','VACI','VBF','VCV','VEL','VELL',
  'VGM','VGSR','VII-U','VIXM','VKI','VKQ','VLY','VMO','VNM','VVR',
  'WAGN','WARP','WCMI','WDI','WEBS','WENN','WHF','WIW','WSBF','WTID',
  'WTIU','WU','WULF','WYFL','XCBE','XFLT','XNDX','XOMO','XOVR','XRP',
  'XRPC','XRPI','XRPN','XRPZ','XSLL','XXI','XZO','YBTC','YETH','YICCU',
  'YLD','YMAG','YMAX','YQQQ','YYY','ZKP','ZTR',
  ])],
  // LIST 4d: INDUSTRIAL — Industrials sector per Finviz classification.
  //   Real operating companies (aerospace & defense, airlines, electrical
  //   equipment, building products, engineering & construction, trucking/
  //   logistics, staffing, industrial machinery). No ETFs/SPACs/CEFs mixed
  //   in, unlike FINANCIAL.
  INDUSTRIAL: [...new Set([
  'AADX','AAL','ABAT','ACCO','ACHR','ACTG','ADT','AIAI','AIRJ','AIRO',
  'ALTG','AMPX','AP','AQMS','ARLO','ARQ','ASLE','ASPN','AVEX','BAER',
  'BBCP','BCHT','BEEP','BETA','BLNK','BNC','BOC','BOOM','BTOC','BURU',
  'BV','BW','BWEN','BYRN','CEPL','CETY','CIRC','CJMB','CMCO','CODA',
  'CODI','CTNT','CTOS','CVU','CVV','CYRX','DETX','DFLI','DFNS','DLHC',
  'DNOW','EAF','ELMT','ENVX','EOSE','EQPT','ERII','EROC','ESOA','ETS',
  'EVEX','EVI','EVLV','FAC','FBGL','FBYD','FCEL','FIP','FISN','FJET',
  'FLUX','FLY','FLYX','FORR','FTEK','FWRD','GCDT','GPGI','GPUS','GWH',
  'HAWK','HAYW','HDRN','HLMN','HTLD','HTZ','HYLN','ICON','INVE','IPDN',
  'ISSC','ITG','IVDA','JBI','JBLU','JELD','JOB','JOBY','KELYA','KITT',
  'KODK','KSCP','LASE','LNZA','LSH','LTBR','LUNR','LXFR','LZ','MG',
  'MIR','MNTS','MRLN','MRTN','MTRX','MTW','NEOV','NIXX','NL','NMAD',
  'NNBR','NNE','NPKI','NPWR','NTIP','NX','OESX','OFAL','OLOX','OPTT',
  'ORN','PAL','PANL','PBI','PCT','PESI','PEW','PHGE','PLAG','PLUG',
  'POLA','POWW','PPHC','PPSI','QUAD','QXO','RAIL','RCAT','RDW','RFIL',
  'RGP','RJET','RLGT','RR','RUBI','SATL','SBC','SCWO','SDST','SERV',
  'SGLY','SGRP','SHIM','SIDU','SKYX','SLND','SMHI','SMR','SOAR','SPAI',
  'SPCE','SPIR','SRFM','SST','STI','SWBI','SWIM','TBI','TE','TG',
  'TGEN','TH','TIC','TITN','TOMZ','TOPP','TRC','TTI','TUSK','TWI',
  'ULCC','ULH','UP','VATE','VRME','VSTS','VWAV','WNC','XE','XOS',
  'XPON','XRX','XTIA','YSS','ZONE','ZTG',
  ])],
  // LIST 4e: REAL_ESTATE — Real Estate sector per Finviz classification.
  //   Mostly REITs (mortgage, residential, office, hotel, healthcare
  //   facilities, retail, industrial, diversified) plus a handful of real
  //   estate services/brokerage companies. No ETFs/SPACs/CEFs mixed in.
  //   ALBT (Avalon GloboCare) was historically thought of as biotech, but
  //   it isn't in HEALTHCARE's verified list and current filings show it's
  //   diversified into commercial real estate (incl. rental income), AI,
  //   and consumer health tech — Real Estate Services is the best current
  //   single-sector fit per Finviz and independent trackers, so it lives
  //   here rather than in HEALTHCARE.
  REAL_ESTATE: [...new Set([
  'ABR','ACRE','ADAM','AGNC','AGNT','AHRT','AIRE','AIV','ALBT','AOMR',
  'APLE','ARI','ARR','BDN','BHR','BRSP','BXMT','CHCT','CHMI','CIM',
  'CLDT','CLPR','CMTG','COLD','COMP','DEI','DHC','DOUG','DRH','DX',
  'EFC','ELME','ESRT','FBRT','FPH','FPI','FRMI','FSP','FTHM','GBR',
  'GIPR','GNL','GOOD','GPMT','HPP','IHT','ILPT','INN','IRT','IVR',
  'JBGS','JFB','KREF','LADR','LAND','LFT','LHAI','LPA','LRHC','MDV',
  'MFA','MITT','MPT','NHP','NLOP','NMRK','NREF','NXDT','ONL','OPAD',
  'OPEN','OPI','ORC','PDM','PEB','PK','PMT','RC','REAX','REFI',
  'RENX','RFL','RITM','RLJ','RMAX','RWT','SACH','SAFE','SBRA','SDHC',
  'SEVN','SHO','SITC','SKYH','SRG','STWD','SUNS','SVC','TRTX','TWO',
  'UMH','UNIT','WHLR','WSR',
  ])],
  // LIST 4f: CONSUMER — Consumer Cyclical sector per Finviz classification.
  //   Broader than pure retail: specialty/apparel/internet retail and
  //   department stores, plus autos & auto parts, restaurants, leisure/
  //   gambling/casinos, travel services, and packaging. Overlaps heavily
  //   with the still-unverified interim RETAIL list (61 shared tickers as
  //   of this addition) — RETAIL is due its own Finviz-verified cleanup
  //   pass, at which point this overlap should be resolved there.
  CONSUMER: [...new Set([
  'ACEL','ACVA','AEO','AOUT','ARHS','ARKO','ATER','AUR','BALY','BARK',
  'BBBY','BIRD','BLMN','BNED','BOBS','BRCB','BRLT','BTBD','CAL','CALY',
  'CATO','CHPT','CLAR','CNNE','CNTY','CPNG','CRMT','CURV','CVGI','CWH',
  'DBGI','DBI','DCH','DFH','DLTH','DRVN','DSS','DXLG','EFOI','EMPD',
  'EVGO','F','FABC','FFAI','FGI','FIGS','FLL','FLWS','FLYE','FMFC',
  'FNKO','FOSL','FOXF','FRTT','FUN','FWDI','FWRG','GBTG','GPK','GRWG',
  'GT','GTEC','HLLY','HOFT','HOUR','HWH','INSE','IPW','JACK','JBDI',
  'JEM','JILL','JRSH','KSS','LAKE','LCID','LCUT','LE','LEG','LESL',
  'LOCO','LOVE','LUCK','LVWR','MAMO','MAT','MBC','MED','MNRO','MPAA',
  'MRDN','MVST','MWYN','NCLH','NEGG','NTRP','NVVE','NWTG','OI','OLPX',
  'ONEW','ORBS','PACK','PASW','PLBY','PLCE','PRPL','PTLO','PTON','PUSA',
  'QS','RAVE','RDNW','REAL','REE','RENT','RIVN','ROLR','RRGB','SBH',
  'SEGG','SES','SEV','SFIX','SG','SHOE','SLDP','SPWH','SRI','SVV',
  'SYPR','TDUP','TLYS','TRIP','TRNR','TRON','TRUG','UA','UAA','UFI',
  'VENU','VFC','VIRC','VNCE','VRA','VSTD','WEN','WKHS','WKSP','WOOF',
  'WWW','XELB','XMAX','XPOF','ZUMZ',
  ])],
  // OTHER — combined catch-all for sectors too small/niche to warrant
  //   their own filter button: Basic Materials (mining, chemicals,
  //   agricultural inputs, building materials, steel/aluminum),
  //   Communication Services (broadcasting, publishing, telecom,
  //   internet content/social, entertainment), Utilities (electric, gas,
  //   water, renewable/independent power), and Consumer Defensive
  //   (groceries, packaged foods, household/personal products, tobacco,
  //   beverages) — all Finviz-verified, merged into one list per user
  //   request rather than 4 separate buttons. Still doubles as
  //   MASTER_TICKERS, the fallback list used whenever
  //   state.selectedUniverse doesn't resolve to a valid universe (first
  //   load, or a stale localStorage value). No single relevant sector ETF
  //   (see getSectorETFForCategory), so intentionally absent from that
  //   mapping — same as the original BROAD catch-all it replaced.
  OTHER: [...new Set([
  'ACI','ACNT','AES','AGIG','ALM','ALOY','ALTO','AMBO','AMC','AMCX',
  'AMSS','AMTX','ANGI','ANGX','AREC','AREN','ASPI','AVD','AVO','BESS',
  'BGS','BMBL','BODI','BOF','BRBR','BRCC','BYND','BZFD','CAG','CAPS',
  'CARS','CAST','CC','CCO','CCOI','CDE','CDLX','CDZI','CHGG','CLF',
  'CLW','CNL','CNVS','COTY','COUR','CTGO','CURI','CXDO','DC','DDC',
  'DGXX','DIBS','DJT','DNUT','DRCT','DV','ECVT','EDBL','EDHL','EDUC',
  'EEIQ','EEX','ELE','EMAT','ENHA','EVC','FEAM','FF','FIRY','FLNC',
  'FLNT','FLO','FLZH','FMC','FUBO','GAIA','GAME','GDC','GETY','GEVO',
  'GIFT','GNE','GNLN','GO','GOGO','GORO','GPRE','GRML','GROV','GTN',
  'GWRS','GXAI','HAIN','HCWC','HDSN','HE','HFFG','HL','HLF','HNRG',
  'HNST','HODO','HUN','HYMC','IAUX','IE','IHRT','IMSR','IQST','ISPR',
  'IZEA','JVA','KIDZ','KLC','KORE','KRO','KUST','KVHI','KVUE','LEE',
  'LFVN','LGCY','LILA','LILAK','LMNR','LOCL','LODE','LSF','LUMN','LVO',
  'LWLG','LXU','MAGN','MAMA','MATV','MAX','MDIA','METC','MGPI','MH',
  'MNTK','MSGM','MSS','MTUS','MYND','MYPS','NB','NCMI','NG','NMAX',
  'NRDS','NRGV','NUS','NVA','NWL','NXDR','NXXT','OFRM','OMEX','ONFO',
  'OPAL','OPTU','ORGN','PAVS','PCG','PCYO','PLAY','PODC','PPTA','PSKY',
  'PZG','QNST','REA','RKDA','RMCF','RSVR','RUM','RYAM','SAFX','SBEV',
  'SBGI','SBMT','SDOT','SEAT','SHEN','SKIL','SKIN','SLE','SLSN','SMPL',
  'SNAL','SNAP','SNES','SOWG','SPH','SRXH','SSMR','SSP','SSTK','STEM',
  'STGW','STUB','SUJA','SURG','SWAG','SXC','TBLA','TDAY','TEAD','TOON',
  'TROX','TSQ','TTD','TZOO','UAMY','UONE','UPWK','UPXI','USAR','USAU',
  'UTZ','VFF','VGZ','VHUB','VITL','VOXR','WALD','WBTN','WEST','WWR',
  'XHLD','XIFR','XPL','XXII','YHC','ZDGE','ZIP','ZNB','ZVIA',
  ])]
};
const MASTER_TICKERS = STOCK_UNIVERSES.OTHER;
let TICKERS = MASTER_TICKERS;

// Reverse lookup: which STOCK_UNIVERSES category a ticker belongs to,
// regardless of the currently selected universe. Used when scoring an owned
// position outside the active scan's ticker list, so its macro adjustment
// isn't computed against the wrong sector.
function findTickerCategory(ticker) {
  for (const [cat, list] of Object.entries(STOCK_UNIVERSES)) {
    if (list.includes(ticker)) return cat;
  }
  return null;
}

const COMPANY_NAMES = {
  'SNDL':'SNDL Inc.','CLOV':'Clover Health','MVIS':'MicroVision','WKHS':'Workhorse Group',
  'GOEV':'Canoo Inc.','SPWR':'SunPower','PLUG':'Plug Power','FCEL':'FuelCell Energy',
  'BLNK':'Blink Charging','IDEX':'Ideanomics','ZOM':'Zomedica','CPRX':'Catalyst Pharma',
  'CRON':'Cronos Group','ACB':'Aurora Cannabis','TLRY':'Tilray Brands','COTY':'Coty Inc.',
  'F':'Ford Motor','SNAP':'Snap Inc.','SOFI':'SoFi Technologies','HOOD':'Robinhood Markets',
  'LCID':'Lucid Group','XPEV':'XPeng Inc.','NIO':'NIO Inc.','MARA':'Marathon Digital',
  'RIOT':'Riot Platforms','HUT':'Hut 8 Mining','BITF':'Bitfarms','CLSK':'CleanSpark',
  'CIFR':'Cipher Mining','KOSS':'Koss Corp','EXPR':'Express Inc.','AMC':'AMC Entertainment',
  'FFIE':'Faraday Future','MULN':'Mullen Automotive','XELA':'Exela Technologies',
  'KPLT':'Katapult Holdings','GFAI':'Guardforce AI','OCGN':'Ocugen Inc.',
  'INO':'Inovio Pharma','NVAX':'Novavax','SRNE':'Sorrento Therapeutics',
  'ATOS':'Atossa Therapeutics','CTIC':'CTI BioPharma','JAGX':'Jaguar Health',
  'LXRX':'Lexicon Pharma','OCUL':'Ocular Therapeutix','RILY':'B. Riley Financial',
  'SAVA':'Cassava Sciences','UAVS':'AgEagle Aerial','VNRX':'VolitionRx',
  'WTER':'Alkaline Water','YCBD':'cbdMD','NKLA':'Nikola Corp','RIDE':'Lordstown Motors',
  'HYLN':'Hyliion Holdings','ARBK':'Argo Blockchain','HIVE':'Hive Blockchain',
  'VERB':'Verb Technology','PHUN':'Phunware','CSSE':'Chicken Soup for the Soul',
  'PAYA':'Paya Holdings','PDSB':'PDS Biotech','ALBT':'Avalon GloboCare',
  'AEYE':'AudioEye','SEEL':'Seelos Biosciences','CPIX':'Cumberland Pharma',
  'NCPL':'Netcapital','HCWB':'HCW Biologics','CHRS':'Coherus BioSciences',
  'MTSL':'MiMedia Inc.','MVST':'Microvast','WATT':'Energous Corp','VVPR':'VivoPower',
  'SIGA':'SIGA Technologies','BLPH':'Bellerophon Therapeutics','OBSV':'ObsEva SA',
  'VBIV':'VBI Vaccines','CIDM':'Cinedigm','CYTH':'Cyclerion Therapeutics',
  'DFFN':'Diffusion Pharma','GNPX':'Genprobe','INFI':'Infinity Pharma',
  'KMPH':'KemPharm','MYOV':'Myovant Sciences','NBSE':'NeuBase Therapeutics',
  'PRPO':'Precipio Diagnostics','QLGN':'Qualigen Therapeutics','TPVG':'TriplePoint Venture',
  'XBIO':'Xenon Pharma','ZSAN':'Zosano Pharma','OGEN':'Oragenics',
  'APHA':'Aphria Inc.','SFIX':'Stitch Fix','WISH':'ContextLogic','RIVN':'Rivian Automotive',
  'BBBY':'Bed Bath & Beyond','GME':'GameStop','NEXT':'NextDecade','AULT':'Ault Global Holdings',
  'MDJM':'Mdjm Ltd','LIZI':'Lizhan Environmental'
};

const NEG_KEYWORDS = ['recall','lawsuit','fraud','investigation','bankruptcy','downgrade','loss report','criminal'];

const HOLIDAYS = new Set([
  '2024-01-01','2024-01-15','2024-02-19','2024-03-29','2024-05-27',
  '2024-06-19','2024-07-04','2024-09-02','2024-11-28','2024-12-25',
  '2025-01-01','2025-01-20','2025-02-17','2025-04-18','2025-05-26',
  '2025-06-19','2025-07-04','2025-09-01','2025-11-27','2025-12-25',
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25',
  '2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25'
]);

// ── 2. STATE ─────────────────────────────────────────────────────

let state = {
  settings: {},
  portfolio: [],
  sold: [],
  signals: [],
  news: [],
  lastScanTime: null,
  activeTab: 'signals',
  filters: { priceRange: 'all', duration: 'all', catalystOnly: false },
  signalToggles: { strongBuy: true, softBuy: true, watch: true },
  aiCache: {},         // ticker → {bullets, tip} — session only
  portfolioPrices: {}, // ticker → live price — session only
  ahSnapshots: {},     // ticker → SIP snapshot — session only, AH mode
  spyChange: 0,        // SPY today % change — updated each screener run
  macroContext: null,  // { changes, condition, ambiguous, source, explanation, fetchedAt } — session only, fetched once
  soldCurrentPrices: {}, // ticker → current price
  loading: false,
  _confirmCb: null,
  lastPassedCount: 0,
  selectedUniverse: 'OTHER',
  notifications: {},     // push notification state — persisted
  ownedScores: {},        // ticker → {score, label} snapshotted at each screener run, for owned positions that no longer clear the display threshold — persisted
  ownedPrevRSI: {},       // ticker → RSI from the previous portfolio render, for detecting "declining from peak" in calcPeakRiskScore — persisted
  ownedPeakRSI: {},       // ticker → highest RSI seen across the current hold, for peakRsiDuringHold on the sold record — persisted
  preMarketGroqCache: {}, // ticker → {pairs}|{raw} Groq pre-market read — session only, tap-triggered
  deletedPositionIds: new Set(), // position IDs deleted this session — guards renderPortfolioTab()'s fire-and-forget saves from resurrecting a just-sold row; session only, not persisted
};

function loadState() {
  // portfolio and settings are Supabase-backed now (Data Migration project,
  // Step 4) — no longer read from localStorage here at all. See
  // runDataLoadAndInit(), which fetches both right after this runs.
  ['sold','signals','lastScanTime','news','signalToggles','lastPassedCount','selectedUniverse','notifications','ownedScores','ownedPrevRSI','ownedPeakRSI'].forEach(k => {
    const raw = localStorage.getItem('edge_' + k);
    if (raw) { try { state[k] = JSON.parse(raw); } catch(e) {} }
  });
  state.settings = Object.assign({
    alpacaKey: '', alpacaSecret: '', groqKey: '',
    budget: 500, includeUnder2: false, showWatch: true, minVolume: 100000,
    forcePreMarketMode: false, disableMacroOverlay: false
  }, state.settings);
  // API keys live in their own localStorage key, edge_apiKeys — authoritative
  // once present. If it doesn't exist yet but the legacy edge_settings blob
  // does (a user who saved keys before this update and hasn't resaved them
  // since), self-heal once: pull the key fields out of the old blob, apply
  // them, and persist them into edge_apiKeys immediately so this fallback
  // never has to run again. Needed because edge_settings is no longer read
  // into state.settings by the loop above at all (Step 4) — without this,
  // those users would silently lose access to already-saved keys.
  try {
    const rawKeys = localStorage.getItem('edge_apiKeys');
    if (rawKeys) {
      Object.assign(state.settings, JSON.parse(rawKeys));
    } else {
      const legacyRaw = localStorage.getItem('edge_settings');
      if (legacyRaw) {
        const legacy = JSON.parse(legacyRaw);
        if (legacy.alpacaKey || legacy.alpacaSecret || legacy.groqKey) {
          state.settings.alpacaKey = legacy.alpacaKey || '';
          state.settings.alpacaSecret = legacy.alpacaSecret || '';
          state.settings.groqKey = legacy.groqKey || '';
          persistApiKeys();
        }
      }
    }
  } catch(e) {}
  state.notifications = Object.assign({
    enabled: true, permission: 'default',
    lastPriceCheck: null, lastDailyCheck: null, alertHistory: {}
  }, state.notifications);
  state.signalToggles = Object.assign(
    { strongBuy: true, softBuy: true, watch: true },
    state.signalToggles
  );
  if (!state.selectedUniverse) state.selectedUniverse = 'OTHER';
  const baseList = STOCK_UNIVERSES[state.selectedUniverse] || MASTER_TICKERS;
  TICKERS = baseList.length ? baseList : MASTER_TICKERS;
}

function persistApiKeys() {
  try {
    localStorage.setItem('edge_apiKeys', JSON.stringify({
      alpacaKey: state.settings.alpacaKey,
      alpacaSecret: state.settings.alpacaSecret,
      groqKey: state.settings.groqKey,
    }));
  } catch(e) {}
}

function persist(key) {
  try { localStorage.setItem('edge_' + key, JSON.stringify(state[key])); } catch(e) {}
}

// Single source of truth for "is this ticker in Portfolio". Portfolio is
// Supabase-backed (Data Migration project) — state.portfolio is populated
// from Supabase at app init and kept current by every write in Step 5, so
// it's now the reliable source itself rather than a copy that could drift
// from localStorage. Normalizes both sides so casing/whitespace can't cause
// a false negative.
function getOwnedPosition(ticker) {
  const needle = String(ticker || '').trim().toUpperCase();
  if (!needle) return null;

  return state.portfolio.find(p => String(p.ticker || '').trim().toUpperCase() === needle) || null;
}

// ── 3. PACIFIC TIME / MARKET STATUS ─────────────────────────────

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function getPT(date = new Date()) {
  return new Date(date.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

function ptDateStr(pt) {
  return pt.toLocaleDateString('en-CA'); // YYYY-MM-DD
}

function isTradingDay(pt) {
  const dow = pt.getDay();
  if (dow === 0 || dow === 6) return false;
  return !HOLIDAYS.has(ptDateStr(pt));
}

// TESTING ONLY — Settings > Testing > "Force pre-market mode (testing)".
// Lets the pre-market movers section (and its tap/expand/Groq flow) be
// exercised outside real pre-market hours. Remove once no longer needed.
function getMarketStatus() {
  if (state.settings.forcePreMarketMode) {
    return { status:'PRE', label:'PRE-MARKET (TEST MODE)', color:'#ffd166',
             countdown:'Forced via Settings testing toggle', isOpen:false };
  }
  const pt = getPT();
  const h = pt.getHours(), m = pt.getMinutes();
  const tMin = h * 60 + m;
  const trading = isTradingDay(pt);

  if (trading && tMin >= 390 && tMin < 780) {   // 6:30am–1:00pm
    const left = 780 - tMin;
    return { status:'OPEN', label:'MARKET OPEN', color:'#00ff88',
             countdown:`Closes in ${Math.floor(left/60)}h ${left%60}m`, isOpen:true };
  }
  if (trading && tMin >= 60 && tMin < 390) {     // 1:00am–6:30am
    const left = 390 - tMin;
    return { status:'PRE', label:'PRE-MARKET', color:'#ffd166',
             countdown:`Opens in ${Math.floor(left/60)}h ${left%60}m`, isOpen:false };
  }
  if (trading && tMin >= 780 && tMin < 1020) {   // 1:00pm–5:00pm
    const left = 1020 - tMin;
    return { status:'AH', label:'AFTER HOURS', color:'#ffd166',
             countdown:`Extended hours end in ${Math.floor(left/60)}h ${left%60}m`, isOpen:false };
  }

  // Closed — find next open
  const cd = getCountdownToOpen();
  return { status:'CLOSED', label:'MARKET CLOSED', color:'#4a6070',
           countdown:`Opens in ${cd}`, isOpen:false };
}

function getCountdownToOpen() {
  const now = new Date();
  for (let d = 0; d <= 10; d++) {
    const check = new Date(now);
    check.setDate(now.getDate() + d);
    const ptCheck = getPT(check);
    if (!isTradingDay(ptCheck)) continue;

    const ptOpen = new Date(check);
    const ptNow = getPT(now);
    const ptOpenForToday = new Date(ptNow);
    ptOpenForToday.setHours(6, 30, 0, 0);

    const dayPT = new Date(ptNow);
    dayPT.setDate(ptNow.getDate() + d);
    dayPT.setHours(6, 30, 0, 0);

    const diffMs = dayPT - ptNow;
    if (diffMs > 0) {
      const mins = Math.floor(diffMs / 60000);
      return `${Math.floor(mins/60)}h ${mins%60}m`;
    }
  }
  return '—';
}

function isAfternoonMode() {
  const pt = getPT();
  const tMin = pt.getHours() * 60 + pt.getMinutes();
  return tMin >= 720; // 12:00pm Pacific
}

// Change 11 (Scoring Formula v2 addendum): DAY trade signals go stale fast —
// after 10am Pacific there's too little of the trading day left for an
// intraday target to be realistic. Window is 10am-5pm PT (covers OPEN+AH);
// once the market is fully CLOSED the existing marketClosed overlay already
// communicates that, and this window can never overlap CLOSED by construction
// (600-1020 min falls entirely inside OPEN[390,780) + AH[780,1020)).
function isDayTradeSuppressed(duration) {
  if (duration !== 'DAY') return false;
  const pt = getPT();
  if (!isTradingDay(pt)) return false;
  const tMin = pt.getHours() * 60 + pt.getMinutes();
  return tMin >= 600 && tMin < 1020; // 10:00am-5:00pm Pacific
}

// TESTING ONLY — see getMarketStatus() override above; both must agree so
// the section renders (getMarketStatus) and its data actually gets computed
// (isPreMarketHours, gating the computePreMarketMovers() call in runScreener).
function isPreMarketHours() {
  if (state.settings.forcePreMarketMode) return true;
  const pt = getPT();
  const tMin = pt.getHours() * 60 + pt.getMinutes();
  return isTradingDay(pt) && tMin >= 60 && tMin < 390;
}

function isAfterHoursMode() {
  return getMarketStatus().status === 'AH';
}

// HOTFIX: latestQuote bid/ask midpoint branch removed — it produced wildly
// wrong after-hours prices (e.g. GTM showing $1.81 vs an actual $4.12),
// likely a bad/zero bp or ap on the free IEX feed for thinly-quoted
// tickers after hours. Reverted to the single dailyBar/latestTrade read
// that was correct before this helper existed, for ALL market conditions,
// pending investigation into the actual latestQuote field shape.
function getLivePrice(snap) {
  if (!snap) return 0;
  return snap.dailyBar?.c || snap.latestTrade?.p || 0;
}

function getAHData(ticker) {
  const snap = state.ahSnapshots[ticker];
  if (!snap) return null;
  const ahPrice = snap.latestTrade?.p;
  const regClose = snap.dailyBar?.c;
  if (!ahPrice || !regClose || ahPrice === regClose) return null;
  const ahChangePct = ((ahPrice - regClose) / regClose) * 100;
  return { ahPrice, regClose, ahChangePct };
}

function updateMarketBanner() {
  const ms = getMarketStatus();
  const el = document.getElementById('market-banner');
  if (!el) return;
  el.style.color = ms.color;
  el.innerHTML = `
    <div>
      <span class="market-status-dot" style="background:${ms.color}"></span>
      <strong>${ms.label}</strong>
    </div>
    <span class="market-countdown">${ms.countdown}</span>
  `;
}


// ── 4. BUDGET BAR ────────────────────────────────────────────────

function updateBudgetBar() {
  const el = document.getElementById('budget-bar');
  const tab = state.activeTab;
  if (!el) return;

  if (!['signals','portfolio'].includes(tab)) {
    el.classList.add('hidden');
    return;
  }

  const budget = parseFloat(state.settings.budget) || 0;
  const deployed = state.portfolio.reduce((sum, p) => sum + (p.shares * p.buyPrice), 0);
  const avail = budget - deployed;
  const availClass = avail >= 0 ? 'pos' : 'neg';

  el.classList.remove('hidden');
  el.innerHTML = `
    <span>Budget: <strong class="mono">$${budget.toFixed(2)}</strong></span>
    <span>Deployed: <strong class="mono">$${deployed.toFixed(2)}</strong></span>
    <span>Available: <strong class="mono ${availClass}">$${avail.toFixed(2)}</strong></span>
  `;
}

// ── 5. FRESHNESS ──────────────────────────────────────────────────

function getFreshnessHtml(triggerId) {
  if (!state.lastScanTime) return '';
  const age = Math.floor((Date.now() - state.lastScanTime) / 60000);
  if (age < 30) return `<div class="freshness-warn ok">Data from ${age} min ago</div>`;
  if (age < 60)
    return `<div class="freshness-warn stale" onclick="handleRefresh()">⚠ Data is ${age} min old — tap to refresh</div>`;
  return `<div class="freshness-warn old" onclick="handleRefresh()">🔴 Stale data — refresh now</div>`;
}

// ── 6. ALPACA API ─────────────────────────────────────────────────

function alpacaHeaders() {
  return {
    'APCA-API-KEY-ID': state.settings.alpacaKey,
    'APCA-API-SECRET-KEY': state.settings.alpacaSecret,
  };
}

async function alpacaGet(path, params = {}) {
  const url = new URL(ALPACA_BASE + path);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), { headers: alpacaHeaders() });
  if (!r.ok) throw new Error(`Alpaca ${r.status}: ${await r.text()}`);
  return r.json();
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Alpaca rejects an entire batch request with a 400 if ANY symbol in it is
// malformed (confirmed in production via AAC-U) — a hyphen, space, or other
// non-alphanumeric character kills the whole batch, not just that ticker.
// Applied at every batch-request entry point below so a single bad ticker
// in any universe can't take down an entire scan.
function sanitizeTickerBatch(tickers) {
  return tickers.filter(t => /^[A-Z0-9]+$/.test(t));
}

async function fetchSnapshots(tickers, onProgress) {
  const clean = sanitizeTickerBatch(tickers);
  const results = {};
  let done = 0;
  for (const batch of chunk(clean, 100)) {
    const data = await alpacaGet('/stocks/snapshots', { symbols: batch.join(','), feed:'iex' });
    Object.assign(results, data);
    done += batch.length;
    if (onProgress) onProgress(done, clean.length);
  }
  return results;
}

// Malformed tickers (anything sanitizeTickerBatch() strips, e.g. the
// UNVERIFIED_HYPHEN_SYMBOLS) never reach Alpaca at all now, so they can never
// appear in `snapshots` — this flags that exclusion loudly (once per scan)
// instead of the ticker just silently vanishing with no signal and no trace.
function checkUnresolvedSymbols(requestedTickers, snapshots) {
  const requested = new Set(requestedTickers);
  const missing = UNVERIFIED_HYPHEN_SYMBOLS.filter(sym => requested.has(sym) && !snapshots[sym]);
  if (missing.length) {
    console.warn(`Unresolved symbol(s) — no Alpaca snapshot returned, likely a format/listing mismatch: ${missing.join(', ')}`);
  }
}

async function fetchAHSnapshots(tickers) {
  const clean = sanitizeTickerBatch(tickers);
  const results = {};
  for (const batch of chunk(clean, 100)) {
    try {
      const data = await alpacaGet('/stocks/snapshots', { symbols: batch.join(','), feed:'iex' });
      Object.assign(results, data);
    } catch(e) { console.warn('AH snapshot error', e.message); }
  }
  return results;
}

async function fetchMultiBars(tickers, limit = 100) {
  const clean = sanitizeTickerBatch(tickers);
  if (!clean.length) return {};
  const results = {};
  const start = (() => {
    const d = new Date(); d.setDate(d.getDate() - 180); return d.toISOString().split('T')[0];
  })();
  for (const batch of chunk(clean, 30)) {
    try {
      const data = await alpacaGet('/stocks/bars', {
        symbols: batch.join(','), timeframe:'1Day', start, limit, sort:'asc', feed:'iex'
      });
      if (data.bars) Object.assign(results, data.bars);
    } catch(e) { console.warn('bars batch error', e.message); }
  }
  return results;
}

async function fetchSingleBars(ticker, limit = 300) {
  const start = (() => {
    const d = new Date(); d.setDate(d.getDate() - 450); return d.toISOString().split('T')[0];
  })();
  try {
    const data = await alpacaGet(`/stocks/${ticker}/bars`, {
      timeframe:'1Day', start, limit, sort:'asc', feed:'iex'
    });
    return data.bars || [];
  } catch(e) { return []; }
}

// Next trading day's close after a given sell date — feeds the "what-if held
// 1 more day" metric in the Winner Exit Timing Analysis report section
// (URE v2, Change 5). limit:3 gives slack for the day after a Friday/holiday
// sale to land on the next actual trading session.
async function fetchNextDayClose(ticker, sellDateStr) {
  try {
    const d = new Date(sellDateStr);
    d.setDate(d.getDate() + 1);
    const start = d.toISOString().split('T')[0];
    const data = await alpacaGet(`/stocks/${ticker}/bars`, {
      timeframe: '1Day', start, limit: 3, sort: 'asc', feed: 'iex'
    });
    const bars = data.bars || [];
    return bars.length ? bars[0].c : null;
  } catch(e) { return null; }
}

// Adds n TRADING days (skips Sat/Sun, no holiday calendar — consistent with
// the rest of the app's date math) to a yyyy-mm-dd string. UTC throughout so
// this can't drift a day depending on the browser's local timezone, since
// dateStr carries no time/zone info of its own. Sell Timing Analysis
// (Lazy Resolution project) — used both as the elapsed-time gate (has
// today reached sellDate+5 trading days yet?) and as fetchSellTimingBars'
// window boundary.
function addTradingDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d.toISOString().split('T')[0];
}

// Daily bars spanning the full Sell Timing Analysis window: [buyDate,
// sellDate + 5 trading days]. Follows the same start+limit convention as
// every other fetch* helper here (no `end` param is used anywhere in this
// codebase) — limit is sized to the actual span so unusually long holds
// (past their intended duration) still get bars covering the whole window
// rather than being silently truncated by a fixed guess.
async function fetchSellTimingBars(ticker, buyDate, sellDate) {
  const windowEnd = addTradingDays(sellDate, 5);
  const spanDays = Math.ceil((new Date(windowEnd + 'T00:00:00Z') - new Date(buyDate + 'T00:00:00Z')) / 86400000);
  const limit = Math.max(spanDays + 5, 15);
  try {
    const data = await alpacaGet(`/stocks/${ticker}/bars`, {
      timeframe: '1Day', start: buyDate, limit, sort: 'asc', feed: 'iex'
    });
    return data.bars || [];
  } catch(e) { return []; }
}

// Counts trading (weekday) days strictly after `fromDateStr` up to and
// including `toDateStr`. Used only for the State A "tradingDaysRemaining"
// display — 0 (or the loop never running, if `from` is already >= `to`)
// means the window has closed, which lines up with computeSellTimingAnalysis'
// own resolution check.
function countTradingDaysBetween(fromDateStr, toDateStr) {
  let count = 0;
  const d = new Date(fromDateStr + 'T00:00:00Z');
  const to = new Date(toDateStr + 'T00:00:00Z');
  while (d < to) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

// Sell Timing Analysis (Lazy Resolution project) — pure function, takes
// already-fetched bars (fetchSellTimingBars), no network of its own.
// bestSoFar/bestSoFarDate use daily HIGHS (bar.h), not closes — the high is
// the best price actually achievable that day. priceAt5Days is the CLOSE on
// that specific day (a fixed, single-point comparison, distinct from
// "best price anywhere in the window").
//
// State A (window still open — fewer than 5 trading days have passed since
// sellDate): { resolved: false, bestSoFar, bestSoFarDate, tradingDaysRemaining }
// — bestSoFar is a running best over whatever bars are available so far, for
// the card to show progress while waiting.
//
// State B (resolved — 5+ trading days have passed): { resolved: true,
// bestExitPrice, bestExitDate, bestExitTiming, priceAt5Days } — bestExitTiming
// is BEFORE/ON/AFTER, comparing bestExitDate to trade.sellDate. If the bar for
// the exact +5-trading-day date is missing (a market holiday landed there —
// no holiday calendar anywhere in this app, same as elsewhere), priceAt5Days
// comes back null rather than guessing a nearby day.
function computeSellTimingAnalysis(trade, bars) {
  const resolveDate = addTradingDays(trade.sellDate, 5);
  const today = new Date().toISOString().split('T')[0];

  let bestSoFar = null, bestSoFarDate = null;
  (bars || []).forEach(b => {
    if (b.h == null) return;
    const barDate = (b.t || '').split('T')[0];
    if (bestSoFar == null || b.h > bestSoFar) {
      bestSoFar = b.h;
      bestSoFarDate = barDate;
    }
  });

  if (today < resolveDate) {
    return {
      resolved: false,
      bestSoFar,
      bestSoFarDate,
      tradingDaysRemaining: countTradingDaysBetween(today, resolveDate),
    };
  }

  const priceAt5DaysBar = (bars || []).find(b => (b.t || '').split('T')[0] === resolveDate);
  const priceAt5Days = priceAt5DaysBar ? priceAt5DaysBar.c : null;

  const bestExitTiming = bestSoFarDate == null ? null
    : bestSoFarDate < trade.sellDate ? 'BEFORE'
    : bestSoFarDate === trade.sellDate ? 'ON'
    : 'AFTER';

  return {
    resolved: true,
    bestExitPrice: bestSoFar,
    bestExitDate: bestSoFarDate,
    bestExitTiming,
    priceAt5Days,
  };
}

function needsSellTimingResolution(trade) {
  if (trade.sellTimingResolved || !trade.sellDate) return false;
  const today = new Date().toISOString().split('T')[0];
  return today >= addTradingDays(trade.sellDate, 5);
}

// Mutates `trade` in place — it's the same object reference living in
// state.sold, matching the mutate-then-persist pattern already used
// throughout this file (e.g. renderPortfolioTab's peak-price tracking).
// Returns false (leaves the trade untouched) if computeSellTimingAnalysis
// still comes back State A despite the elapsed-time gate above having
// passed — shouldn't happen in practice, but defensive rather than writing
// half-resolved data.
async function resolveOneSellTiming(trade) {
  const bars = await fetchSellTimingBars(trade.ticker, trade.buyDate, trade.sellDate);
  const analysis = computeSellTimingAnalysis(trade, bars);
  if (!analysis.resolved) return false;
  trade.sellTimingResolved = true;
  trade.bestExitPrice = analysis.bestExitPrice;
  trade.bestExitDate = analysis.bestExitDate;
  trade.bestExitTiming = analysis.bestExitTiming;
  trade.priceAt5Days = analysis.priceAt5Days;
  return true;
}

// Fire-and-forget like every other background Supabase write in this file
// (writeTradeToSupabase, the renderPortfolioTab peak-price updates) — this
// runs lazily on Sold tab open, not from a direct user action, so a failure
// here shouldn't surface as an alert; it just retries next time the tab
// opens since trade.sellTimingResolved was already set locally regardless
// (state.sold is the source of truth for the Sold tab display either way).
// Matches by trade.supabaseId when available (set by writeTradeToSupabase
// for any trade sold after that capture was added); falls back to
// ticker+buy_date+sell_date for trades sold before then.
async function writeSellTimingToSupabase(trade) {
  const row = {
    sell_timing_resolved: true,
    best_exit_price: trade.bestExitPrice,
    best_exit_date: trade.bestExitDate,
    best_exit_timing: trade.bestExitTiming,
    price_at_plus5_days: trade.priceAt5Days,
  };
  try {
    let query = supabaseClient.from('trades').update(row);
    query = trade.supabaseId != null
      ? query.eq('id', trade.supabaseId)
      : query.eq('ticker', trade.ticker).eq('buy_date', trade.buyDate).eq('sell_date', trade.sellDate);
    const { error } = await query;
    if (error) console.error('Supabase sell-timing update failed:', error.message);
  } catch(e) {
    console.error('Supabase sell-timing update failed:', e.message);
  }
}

// Lazy Resolution orchestrator — called (not awaited) when the Sold tab
// opens. Only fetches for trades that actually need it (needsSellTiming
// Resolution), batches every trade's fetch+compute+write together via
// Promise.all rather than resolving one at a time, and persists state.sold
// once after the whole batch settles rather than once per trade. Returns
// whether anything was actually resolved, so the caller knows whether the
// card display needs to be refreshed.
async function resolveSellTimingForSoldTrades() {
  const pending = state.sold.filter(needsSellTimingResolution);
  if (!pending.length) return false;

  const results = await Promise.all(pending.map(async (trade) => {
    const resolved = await resolveOneSellTiming(trade);
    if (resolved) writeSellTimingToSupabase(trade); // fire-and-forget, see above
    return resolved;
  }));

  if (results.some(Boolean)) {
    persist('sold');
    return true;
  }
  return false;
}

// 1-minute bars for the "1 Day" chart range — closer in resolution to
// Robinhood's intraday chart than the old hourly bars (still IEX-only, so
// absolute price levels can still differ; see feed note on fetchSnapshots).
// 4-day lookback window (same as before) so the pre-market/holiday fallback
// in renderChartRange still has a prior session to fall back to.
async function fetchMinuteBars(ticker) {
  const d = new Date(); d.setDate(d.getDate() - 4);
  const start = d.toISOString().split('T')[0];
  try {
    const data = await alpacaGet(`/stocks/${ticker}/bars`, {
      timeframe: '1Min', start, limit: 2000, sort: 'asc', feed: 'iex'
    });
    return data.bars || [];
  } catch(e) { return []; }
}

// 1-hour bars for the "1 Week"/"1 Month" chart ranges — same idea as
// fetchMinuteBars, one level coarser. 45-day lookback comfortably covers a
// 30-day range plus weekend/holiday slack; renderChartRange filters this
// single fetch down to the 7-day or 30-day window as needed.
async function fetchHourlyBars(ticker) {
  const d = new Date(); d.setDate(d.getDate() - 45);
  const start = d.toISOString().split('T')[0];
  try {
    const data = await alpacaGet(`/stocks/${ticker}/bars`, {
      timeframe: '1Hour', start, limit: 500, sort: 'asc', feed: 'iex'
    });
    return data.bars || [];
  } catch(e) { return []; }
}

async function fetchNewsForTickers(tickers) {
  const clean = sanitizeTickerBatch(tickers);
  if (!clean.length) return [];
  try {
    const syms = clean.slice(0, 50).join(',');
    const data = await alpacaGet('/news', { symbols: syms, limit: 50, sort:'desc' });
    return data.news || [];
  } catch(e) { return []; }
}

async function testAlpacaConnection() {
  try {
    await alpacaGet('/stocks/snapshots', { symbols: 'AAPL', feed:'iex' });
    return true;
  } catch(e) { return false; }
}

// ── 6b. MACRO MARKET OVERLAY ─────────────────────────────────────

// Step 1: pattern-match today's ETF moves into a market condition.
// Evaluated in spec order — `matched` preserves that order so matched[0] is the
// first-match winner; matched.length > 1 signals an ambiguous day for Step 2 (Groq).
function classifyMacroCondition(changes) {
  const spy = changes.SPY || 0;
  const xle = changes.XLE || 0;
  const xlk = changes.XLK || 0;
  const xbi = changes.XBI || 0;
  const xlf = changes.XLF || 0;
  const sectors = [xle, xlk, xbi, xlf];

  const matched = [];

  // RISK_OFF — VIX removed (unavailable via Alpaca /stocks); substituted with
  // a breadth check (3+ of 4 sector ETFs also negative) to keep the "broad
  // panic, everything dropping" intent. Confirmed with Roman before implementing.
  if (spy <= -2 && sectors.filter(v => v < 0).length >= 3) matched.push('RISK_OFF');

  if (spy <= -1 && xle >= 1) matched.push('GEOPOLITICAL');

  if (xlk <= -1.5 && (xle >= 0.5 || xlf >= 0.5)) matched.push('TECH_ROTATION_OUT');

  if (spy >= 1 && sectors.filter(v => v > 0).length >= 3) matched.push('BROAD_RALLY');

  if (spy >= 1.5 && xlk >= 1.5) matched.push('MOMENTUM_DAY');

  // Sector weakness — SPY flat or only mildly down (<1%)
  if (spy > -1) {
    if (xbi <= -1.5) matched.push('SECTOR_WEAKNESS_BIOTECH');
    if (xle <= -1.5) matched.push('SECTOR_WEAKNESS_ENERGY');
    if (xlk <= -1.5) matched.push('SECTOR_WEAKNESS_TECH');
  }

  const condition = matched.length ? matched[0] : 'CHOPPY';
  return { condition, matched };
}

// Fetches today's % change for the macro ETF basket and pattern-matches a
// market condition. Called once per session (see runScreener) — result is
// cached on state.macroContext, not re-fetched per scan or per card.
async function fetchMacroContext() {
  let changes;
  try {
    const snaps = await fetchSnapshots(MACRO_ETFS);
    changes = {};
    MACRO_ETFS.forEach(t => {
      const snap = snaps[t];
      const price = getLivePrice(snap);
      const prevClose = snap?.prevDailyBar?.c || price;
      changes[t] = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
    });
  } catch(e) {
    console.warn('Macro context fetch error', e.message);
    return null;
  }

  const { condition, matched } = classifyMacroCondition(changes);

  const context = {
    changes,             // { SPY, XLE, XLK, XBI, XLF } — % change today
    condition,            // pattern-match result (Step 1); may be revised by Groq in Step 2
    matchedConditions: matched,
    ambiguous: matched.length > 1,
    source: 'pattern',    // becomes 'groq' if Step 2 resolves it
    explanation: null,    // populated by Groq in Step 2
    fetchedAt: Date.now(),
  };

  // Step 2: only call Groq when the pattern match is ambiguous or CHOPPY.
  // fetchMacroContext() itself only runs once per session (see runScreener),
  // so this single call is the session-level cache — no separate cache needed.
  if (condition === 'CHOPPY' || context.ambiguous) {
    const resolved = await resolveMacroConditionWithGroq(changes);
    if (resolved) {
      context.condition = resolved.condition;
      context.explanation = resolved.explanation;
      context.source = 'groq';
    }
    // else: Groq unavailable/failed — context.condition stays the Step 1
    // pattern-match result (CHOPPY, or the first ambiguous match), per spec.
  }

  return context;
}

// Step 2: fetch the last 5 SPY/QQQ headlines from the last 6 hours, for the
// Groq clarification prompt.
async function fetchMacroHeadlines() {
  const news = await fetchNewsForTickers(['SPY', 'QQQ']);
  const cutoff = Date.now() - 6 * 3600000;
  return news
    .filter(n => new Date(n.created_at).getTime() >= cutoff)
    .slice(0, 5);
}

function buildMacroGroqPrompt(changes, headlines) {
  const headlineLines = headlines.length
    ? headlines.map(h => h.headline).join('\n')
    : '(no recent headlines available)';
  return `You are a macro market analyst. Based on these ETF movements and headlines,
classify today's market condition as exactly one of:
RISK_OFF, GEOPOLITICAL, TECH_ROTATION_OUT, BROAD_RALLY, MOMENTUM_DAY,
SECTOR_WEAKNESS_BIOTECH, SECTOR_WEAKNESS_ENERGY, SECTOR_WEAKNESS_TECH, CHOPPY

ETF movements today:
SPY: ${changes.SPY.toFixed(2)}%
XLE: ${changes.XLE.toFixed(2)}%
XLK: ${changes.XLK.toFixed(2)}%
XBI: ${changes.XBI.toFixed(2)}%
XLF: ${changes.XLF.toFixed(2)}%

Recent market headlines:
${headlineLines}

Respond with ONLY the condition label and a single sentence explanation.
Example: "GEOPOLITICAL — Oil prices spiking on Middle East tensions driving
energy up while broad market sells off."`;
}

// Step 2: single Groq call to resolve an ambiguous/CHOPPY pattern match.
// Returns { condition, explanation } on success, or null on any failure
// (missing key, network error, unparseable response) so the caller falls
// back to the Step 1 pattern-match result.
async function resolveMacroConditionWithGroq(changes) {
  const key = state.settings.groqKey;
  if (!key) return null;

  try {
    const headlines = await fetchMacroHeadlines();
    const prompt = buildMacroGroqPrompt(changes, headlines);

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 2000
      })
    });
    if (!r.ok) throw new Error(`Groq ${r.status}`);
    const data = await r.json();
    const text = (data.choices?.[0]?.message?.content || '').trim().replace(/^["']|["']$/g, '');

    const re = new RegExp(`^\\**\\s*(${MACRO_CONDITIONS.join('|')})\\**\\s*[—-]+\\s*(.*)$`, 's');
    const match = text.match(re);
    if (!match) return null;

    return { condition: match[1], explanation: match[2].trim() };
  } catch(e) {
    console.warn('Macro Groq resolution error', e.message);
    return null;
  }
}

// Step 3: category-specific score adjustments. Keys match state.selectedUniverse
// (HEALTHCARE/ENERGY/TECH/RETAIL/FINANCIAL/INDUSTRIAL/REAL_ESTATE/CONSUMER/
// OTHER), which is also how category is threaded into scoreStock() — see
// "How category is stored" note at the Macro Overlay call site. RETAIL
// currently mirrors TECH's values as a placeholder until its universe is
// verified and its own macro
// sensitivity is characterized. FINANCIAL, INDUSTRIAL, REAL_ESTATE, and
// CONSUMER all start at 0 for every condition (no adjustment) since they're
// mixed/uncharacterized buckets with no dedicated SECTOR_WEAKNESS_* condition
// of their own yet. OTHER (formerly BROAD) keeps its original real values —
// it's the catch-all fallback, not a placeholder-zeroed new addition.
const MACRO_ADJUSTMENTS = {
  RISK_OFF:                { HEALTHCARE: -20, ENERGY: -15, TECH: -20, RETAIL: -20, FINANCIAL: 0, INDUSTRIAL: 0, REAL_ESTATE: 0, CONSUMER: 0, OTHER: -20 },
  GEOPOLITICAL:            { HEALTHCARE: -10, ENERGY:  10, TECH: -15, RETAIL: -15, FINANCIAL: 0, INDUSTRIAL: 0, REAL_ESTATE: 0, CONSUMER: 0, OTHER: -10 },
  TECH_ROTATION_OUT:       { HEALTHCARE:  -5, ENERGY:  10, TECH: -20, RETAIL: -20, FINANCIAL: 0, INDUSTRIAL: 0, REAL_ESTATE: 0, CONSUMER: 0, OTHER:  -5 },
  BROAD_RALLY:             { HEALTHCARE:  10, ENERGY:   5, TECH:  10, RETAIL:  10, FINANCIAL: 0, INDUSTRIAL: 0, REAL_ESTATE: 0, CONSUMER: 0, OTHER:  10 },
  MOMENTUM_DAY:            { HEALTHCARE:   5, ENERGY:   0, TECH:  15, RETAIL:  15, FINANCIAL: 0, INDUSTRIAL: 0, REAL_ESTATE: 0, CONSUMER: 0, OTHER:   5 },
  SECTOR_WEAKNESS_BIOTECH: { HEALTHCARE: -15, ENERGY:   0, TECH:   0, RETAIL:   0, FINANCIAL: 0, INDUSTRIAL: 0, REAL_ESTATE: 0, CONSUMER: 0, OTHER:  -5 },
  SECTOR_WEAKNESS_ENERGY:  { HEALTHCARE:   0, ENERGY: -15, TECH:   0, RETAIL:   0, FINANCIAL: 0, INDUSTRIAL: 0, REAL_ESTATE: 0, CONSUMER: 0, OTHER:  -5 },
  SECTOR_WEAKNESS_TECH:    { HEALTHCARE:   0, ENERGY:   0, TECH: -15, RETAIL: -15, FINANCIAL: 0, INDUSTRIAL: 0, REAL_ESTATE: 0, CONSUMER: 0, OTHER:  -5 },
  CHOPPY:                  { HEALTHCARE:   0, ENERGY:   0, TECH:   0, RETAIL:   0, FINANCIAL: 0, INDUSTRIAL: 0, REAL_ESTATE: 0, CONSUMER: 0, OTHER:   0 },
};

function getMacroAdjustment(condition, category) {
  if (!condition || !category) return 0;
  return MACRO_ADJUSTMENTS[condition]?.[category] ?? 0;
}

// Dynamic signal threshold:
// Rule 1 — sector-specific: on a SECTOR_WEAKNESS_* day, raise the display
// threshold to 50 for the category(ies) that condition targets; every other
// category stays at the base 20. RETAIL is grouped with TECH under
// SECTOR_WEAKNESS_TECH per spec ("Tech/Retail category stocks only").
// HEALTHCARE is the existing Biotech proxy (see MACRO_ADJUSTMENTS above).
// Rule 2 — broad: on RISK_OFF or GEOPOLITICAL, raise the threshold to 50 for
// every category, no exceptions.
// Rule 3 — every other condition (BROAD_RALLY, MOMENTUM_DAY, TECH_ROTATION_OUT,
// CHOPPY, null) is a no-op and falls through to the base 20.
// Evaluated once per scan against the single scan-wide category, not per
// stock — see call site in runScreener().
const BASE_SCORE_THRESHOLD = 29;
const ELEVATED_SCORE_THRESHOLD = 73;
const SECTOR_WEAKNESS_THRESHOLD_CATEGORIES = {
  SECTOR_WEAKNESS_TECH: ['TECH', 'RETAIL'],
  SECTOR_WEAKNESS_BIOTECH: ['HEALTHCARE'],
  SECTOR_WEAKNESS_ENERGY: ['ENERGY'],
};
const BROAD_ELEVATED_CONDITIONS = ['RISK_OFF', 'GEOPOLITICAL'];

function getDisplayThreshold(condition, category) {
  if (BROAD_ELEVATED_CONDITIONS.includes(condition)) return ELEVATED_SCORE_THRESHOLD;
  const affected = SECTOR_WEAKNESS_THRESHOLD_CATEGORIES[condition];
  if (affected && affected.includes(category)) return ELEVATED_SCORE_THRESHOLD;
  return BASE_SCORE_THRESHOLD;
}

// Step 4: display helpers. Which ETF(s) to quote in the Score Breakdown row,
// per condition — mirrors the spec's own examples (GEOPOLITICAL: "SPY -1.8%,
// XLE +2.1%"; BROAD_RALLY: "SPY +1.4%").
const MACRO_DISPLAY_ETFS = {
  RISK_OFF: ['SPY'],
  GEOPOLITICAL: ['SPY', 'XLE'],
  TECH_ROTATION_OUT: ['XLK', 'XLE', 'XLF'],
  BROAD_RALLY: ['SPY'],
  MOMENTUM_DAY: ['SPY', 'XLK'],
  SECTOR_WEAKNESS_BIOTECH: ['XBI'],
  SECTOR_WEAKNESS_ENERGY: ['XLE'],
  SECTOR_WEAKNESS_TECH: ['XLK'],
};

function formatMacroConditionDetail(condition, changes) {
  if (!condition || condition === 'CHOPPY' || !changes) return 'mixed signals';
  const etfs = MACRO_DISPLAY_ETFS[condition] || ['SPY'];
  return etfs
    .filter(t => changes[t] != null)
    .map(t => `${t} ${changes[t] >= 0 ? '+' : ''}${changes[t].toFixed(1)}%`)
    .join(', ');
}

// Fallback banner copy when Groq wasn't invoked (clear, unambiguous pattern
// match) — lifted directly from each condition's "Interpretation" line in the
// spec's Step 1 table, so the banner always has something meaningful to show.
const MACRO_INTERPRETATIONS = {
  RISK_OFF: 'Broad panic selling, everything dropping.',
  GEOPOLITICAL: 'Geopolitical event driving oil up while broad market sells.',
  TECH_ROTATION_OUT: 'Money rotating out of tech into value/energy.',
  BROAD_RALLY: 'Genuine broad market strength.',
  MOMENTUM_DAY: 'Risk-on momentum day, growth stocks outperforming.',
  SECTOR_WEAKNESS_BIOTECH: 'Sector-specific selling in biotech, not a broad market event.',
  SECTOR_WEAKNESS_ENERGY: 'Sector-specific selling in energy, not a broad market event.',
  SECTOR_WEAKNESS_TECH: 'Sector-specific selling in tech, not a broad market event.',
};

// Sector display name for the elevated-threshold banner text (Rule 4) —
// condition mapped to the plain-English sector it targets. Deliberately
// independent of state.selectedUniverse: the banner describes what's
// elevated system-wide, not whether the currently viewed universe happens
// to be affected (matches the spec text verbatim, incl. "Other sectors
// unaffected").
const SECTOR_WEAKNESS_DISPLAY_NAME = {
  SECTOR_WEAKNESS_TECH: 'Tech',
  SECTOR_WEAKNESS_BIOTECH: 'Biotech',
  SECTOR_WEAKNESS_ENERGY: 'Energy',
};

// Signals tab banner — omitted entirely on CHOPPY days per spec ("no clutter
// on normal days"). Rule 4: mentions the elevated threshold on days it's
// active (RISK_OFF/GEOPOLITICAL broad, or SECTOR_WEAKNESS_* sector-specific);
// falls back to the original copy unchanged for conditions with no threshold
// change (BROAD_RALLY, MOMENTUM_DAY, TECH_ROTATION_OUT).
function buildMacroBanner() {
  if (state.settings.disableMacroOverlay) return '';
  const ctx = state.macroContext;
  if (!ctx || !ctx.condition || ctx.condition === 'CHOPPY') return '';

  if (BROAD_ELEVATED_CONDITIONS.includes(ctx.condition)) {
    return `<div class="macro-banner">⚠ <strong>${ctx.condition}</strong> — Only showing high-confidence signals across all sectors (score 50+) due to broad market conditions.</div>`;
  }

  const sector = SECTOR_WEAKNESS_DISPLAY_NAME[ctx.condition];
  if (sector) {
    return `<div class="macro-banner">⚠ <strong>${ctx.condition}</strong> — ${sector} sector weak today. Only showing high-confidence ${sector} signals (score 50+). Other sectors unaffected.</div>`;
  }

  const text = ctx.explanation || MACRO_INTERPRETATIONS[ctx.condition] || '';
  return `<div class="macro-banner">📊 <strong>${ctx.condition}</strong> — ${text}</div>`;
}

// ── 7. GROQ API ───────────────────────────────────────────────────

async function groqAnalyze(ticker, prompt) {
  const key = state.settings.groqKey;
  if (!key) throw new Error('No Groq key');

  if (state.aiCache[ticker]) return state.aiCache[ticker];

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 2000
    })
  });
  if (!r.ok) throw new Error(`Groq ${r.status}`);
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content || '';

  const result = parseAIAnswers(text);
  state.aiCache[ticker] = result;
  return result;
}

// Category -> most relevant single sector ETF for the "Relevant sector ETF
// today" line in buildAIPrompt(). OTHER has no single relevant sector (SPY
// already covers it), so it's intentionally absent — callers must handle null.
function getSectorETFForCategory(category) {
  // RETAIL: XLY is a placeholder pending a verified Retail-sector ETF choice —
  // it happens to now be fetched anyway since CONSUMER added XLY to MACRO_ETFS
  // for real, but RETAIL's mapping itself is still unconfirmed.
  // FINANCIAL: XLF is already one of the macro overlay ETFs (MACRO_ETFS), so
  // this mapping is consistent with the rest of the macro system by construction.
  // INDUSTRIAL: XLI was added to MACRO_ETFS specifically to back this mapping.
  // REAL_ESTATE: XLRE was added to MACRO_ETFS specifically to back this mapping.
  // CONSUMER: XLY was added to MACRO_ETFS specifically to back this mapping —
  // this is the genuine, correct classification (Consumer Discretionary SPDR).
  return { HEALTHCARE: 'XBI', ENERGY: 'XLE', TECH: 'XLK', RETAIL: 'XLY', FINANCIAL: 'XLF', INDUSTRIAL: 'XLI', REAL_ESTATE: 'XLRE', CONSUMER: 'XLY' }[category] || null;
}

// Derives a coarse rising/falling/flat volume trend from the last 3 daily
// bars — used by buildAIPrompt's "Volume trend" line. stock.bars is always
// present (both the real scoreStock() result and openStockModal's fallback
// object populate it), so this doesn't need its own guard beyond length.
function deriveVolumeTrend(bars) {
  if (!bars || bars.length < 3) return 'flat';
  const vols = bars.slice(-3).map(b => b.v);
  if (vols[2] > vols[1] && vols[1] > vols[0]) return 'rising';
  if (vols[2] < vols[1] && vols[1] < vols[0]) return 'falling';
  return 'flat';
}

// Unified probability-based Groq prompt for both owned and unowned stocks
// (Change A — replaces the old HOLD/SELL question-and-answer format).
// `pos` is the result of getOwnedPosition(ticker), or null/undefined for an
// unowned candidate. Three response shapes depending on ownership/P&L —
// see the three branches below; parseAIAnswers must stay in sync with
// whichever label pair each branch instructs Groq to respond with.
function buildAIPrompt(stock, pos) {
  const livePrice = stock.livePrice ?? stock.price;
  const liveRsi = stock.liveRsi ?? stock.rsi;
  const todayChange = stock.todayChange ?? 0;
  const duration = pos ? pos.duration : stock.duration;
  const entry = pos ? pos.buyPrice : stock.entry;
  const stop = pos ? pos.stop : stock.stop;
  const target = stock.target;
  const aboveBelow = livePrice > stock.ma20 ? 'ABOVE' : 'BELOW';
  const maPct = stock.ma20 > 0 ? Math.abs(((livePrice - stock.ma20) / stock.ma20) * 100) : 0;
  const distToTargetPct = ((target - livePrice) / livePrice) * 100;
  const distToStopPct = ((livePrice - stop) / livePrice) * 100;
  const volumeTrend = deriveVolumeTrend(stock.bars);

  // Same duration->max-hold-days mapping used for the Portfolio card's
  // urgency sort/progress bar. Unowned candidates have 0 days held (no
  // position exists yet) but still get a duration classification, so the
  // "intended window" framing stays meaningful either way.
  const durationMaxDays = { DAY: 1, '3-DAY': 4, WEEK: 7 };
  const maxDays = durationMaxDays[duration] || 1;
  const daysHeld = pos ? Math.floor((Date.now() - new Date(pos.buyDate).getTime()) / 86400000) : 0;
  // Change: time window as a first-class factor in the Groq prompt, not just
  // a data line — remaining runway matters more the closer a position is to
  // its intended exit. Floored at 1 so an at/past-window position still gets
  // a (tight) window rather than a zero/negative one.
  const daysRemaining = Math.max(1, maxDays - daysHeld);

  const ctx = state.macroContext;
  const conditionLabel = ctx?.condition || 'N/A';
  const marketContext = ctx ? (ctx.explanation || MACRO_INTERPRETATIONS[ctx.condition] || 'N/A') : 'N/A';
  const spyPct = ctx?.changes?.SPY;
  const spyStr = spyPct != null ? `${spyPct>=0?'+':''}${spyPct.toFixed(2)}` : 'N/A';
  const category = stock.category || state.selectedUniverse || 'OTHER';
  const sectorETF = getSectorETFForCategory(category);
  const sectorPct = sectorETF ? ctx?.changes?.[sectorETF] : null;
  const sectorStr = sectorETF && sectorPct != null ? `${sectorPct>=0?'+':''}${sectorPct.toFixed(2)}` : 'N/A';

  let prompt = `You are a short-term trading analyst giving a probability-based
assessment. Be direct and specific. Express probabilities as whole
number percentages. For each probability name exactly one key factor
— the single most important reason driving that estimate.

Stock: ${stock.ticker} (${stock.company || stock.ticker})
Current price: $${livePrice.toFixed(2)}
Today's change: ${todayChange.toFixed(2)}%
RSI (14-day): ${liveRsi.toFixed(1)}
Volume ratio vs 10-day average: ${stock.volRatio.toFixed(2)}x
Volume trend: ${volumeTrend}
Signal score: ${stock.score}/100
Risk score: ${stock.risk}/10
Trade duration classification: ${duration}
Entry: $${entry.toFixed(2)} | Target: $${target.toFixed(2)} | Stop-loss: $${stop.toFixed(2)}
Distance to target: ${distToTargetPct.toFixed(1)}% away
Distance to stop-loss: ${distToStopPct.toFixed(1)}% away
Price vs 20-day MA: ${aboveBelow} by ${maPct.toFixed(1)}%
Days held: ${daysHeld} of intended ${maxDays} day window
Current macro condition: ${conditionLabel}
Market context: ${marketContext}
SPY today: ${spyStr}%
Relevant sector ETF today: ${sectorStr}%
`;

  if (!pos) {
    prompt += `
You are evaluating whether to buy this stock now given the
app's estimated ${maxDays}-day hold window for this trade.
Base your probabilities on what is realistic within that
exact timeframe — not whether the stock might eventually
recover over months, but whether it will move in your
direction within ${maxDays} days.

Respond in exactly this format with no extra text:

REACH TARGET: {X}% likely
Key factor: {one sentence — what would need to happen within
${maxDays} days for this to succeed}

DROP FROM HERE: {X}% likely
Key factor: {one sentence — the single most important risk
within the ${maxDays}-day window}`;
  } else {
    const pnlDollar = (livePrice - pos.buyPrice) * pos.shares;
    const pnlPct = ((livePrice - pos.buyPrice) / pos.buyPrice) * 100;
    const peakPrice = pos.peakPrice ?? livePrice;
    const momentumActive = !!pos.momentumProtectionActivated;
    const trailingStop = momentumActive ? peakPrice * 0.85 : null;

    // Unified recommendation — gives Groq the app's own holistic judgment as
    // context rather than requiring it to re-derive the same conclusion from
    // the raw signals above. `stock` doubles as the currentSignal argument
    // here — it's the same live state.signals entry (or fallback) already
    // used for every other live field in this prompt.
    let unifiedPromptBlock;
    const ur = calcUnifiedRecommendation({ ...pos, currentPrice: livePrice, rsi: liveRsi }, stock, state.macroContext);
    if (ur.hardFloor) {
      unifiedPromptBlock = `\nUnified recommendation: ${ur.label}\n`;
    } else if (ur.label === 'LOCK IN PROFITS') {
      const topPeakRisk = ur.peakRisk.topFactors;
      const topHold = ur.factors.filter(f => f.points > 0).sort((a, b) => b.points - a.points).slice(0, 2);
      unifiedPromptBlock = `
Unified recommendation: LOCK IN PROFITS (composite +${ur.composite})
Peak risk score: ${ur.peakRisk.score} (threshold: −40)
Top peak risk factors: ${topPeakRisk.length ? topPeakRisk.map(f => f.name).join('; ') : 'none'}
Main composite factors for holding: ${topHold.length ? topHold.map(f => f.name).join('; ') : 'none'}

Note: The position is strongly positive on the main composite
but peak risk indicators suggest the upward momentum is
exhausting. Groq should weight the exit timing heavily.
`;
    } else {
      const topExit = ur.factors.filter(f => f.points < 0).sort((a, b) => a.points - b.points).slice(0, 2);
      const topHold = ur.factors.filter(f => f.points > 0).sort((a, b) => b.points - a.points).slice(0, 2);
      unifiedPromptBlock = `
Unified recommendation: ${ur.label} (composite score: ${ur.composite})
Top exit factors: ${topExit.length ? topExit.map(f => f.name).join('; ') : 'none'}
Top hold factors: ${topHold.length ? topHold.map(f => f.name).join('; ') : 'none'}
`;
    }

    if (pnlDollar >= 0) {
      prompt += `
Purchase price: $${pos.buyPrice.toFixed(2)}
Unrealized P&L: +$${pnlDollar.toFixed(2)} (+${pnlPct.toFixed(1)}%)
Peak price since purchase: $${peakPrice.toFixed(2)}
Momentum protection active: ${momentumActive ? 'YES' : 'NO'}
Trailing stop if active: ${trailingStop != null ? `$${trailingStop.toFixed(2)}` : 'N/A'}
${unifiedPromptBlock}
You are evaluating this position specifically within its
remaining time window of ${daysRemaining} trading days.
Base your probabilities on what is realistic within that
exact timeframe given the current momentum, RSI, and volume.
A target that requires significant movement in 1 day should
have a lower probability than the same target with 5 days
remaining.

Respond in exactly this format with no extra text:

CONTINUE HIGHER: {X}% likely
Key factor: {one sentence — the single most important reason
within the ${daysRemaining}-day remaining window}

REACH TARGET ($${target.toFixed(2)}): {X}% likely
Key factor: {one sentence — what would need to happen within
${daysRemaining} days for this to succeed}`;
    } else {
      prompt += `
Purchase price: $${pos.buyPrice.toFixed(2)}
Unrealized P&L: -$${Math.abs(pnlDollar).toFixed(2)} (-${Math.abs(pnlPct).toFixed(1)}%)
Peak price since purchase: $${peakPrice.toFixed(2)}
Days held: ${daysHeld} of intended ${maxDays} window
Stop-loss: $${stop.toFixed(2)} (${distToStopPct.toFixed(1)}% away)
${unifiedPromptBlock}
You are evaluating this position specifically within its
remaining time window of ${daysRemaining} trading days.
A stock that is losing with only 1 day remaining has much
less recovery potential than the same stock with 5 days left.
Factor the remaining time window heavily into your probability.

Respond in exactly this format with no extra text:

FURTHER DROP: {X}% likely
Key factor: {one sentence — the single most important reason
within the ${daysRemaining}-day remaining window}

REBOUND: {X}% likely
Key factor: {one sentence — what would need to happen within
${daysRemaining} days for a recovery}`;
    }
  }

  prompt += `

Keep every response to exactly 4 lines total — 2 probability lines
and 2 key factor lines. No preamble, no disclaimers, no extra text.`;

  return prompt;
}

// Parses the probability-based response format from buildAIPrompt (Change A).
// Expects exactly two "{LABEL}: {X}% likely" lines, each immediately followed
// by a "Key factor: ..." line. The label set differs by scenario (REACH
// TARGET/DROP FROM HERE for unowned, CONTINUE HIGHER/REACH TARGET ($X) for
// owned-winning, FURTHER DROP/REBOUND for owned-losing) but the shape — two
// probability+factor pairs — is the same, so one regex set covers all three.
// Falls back to { raw: text } if fewer than 2 pairs are found, so a
// malformed response still displays instead of silently vanishing.
function parseAIAnswers(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const labelRe = /^\**\s*(REACH TARGET(?:\s*\([^)]*\))?|DROP FROM HERE|CONTINUE HIGHER|FURTHER DROP|REBOUND)\s*:\s*(\d+)\s*%\s*likely\s*\**$/i;
  const factorRe = /^\**\s*Key factor\s*:\s*(.*)$/i;

  const pairs = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(labelRe);
    if (!m) continue;
    const factorMatch = lines[i + 1] ? lines[i + 1].match(factorRe) : null;
    pairs.push({
      label: m[1].replace(/\s+/g, ' ').trim(),
      pct: parseInt(m[2], 10),
      factor: factorMatch ? factorMatch[1].trim() : '',
    });
  }

  if (pairs.length >= 2) return { pairs: pairs.slice(0, 2) };
  return { raw: text.trim() };
}

async function testGroqConnection() {
  const key = state.settings.groqKey;
  if (!key) return false;
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: 'Say OK.' }],
        max_tokens: 5
      })
    });
    return r.ok;
  } catch(e) { return false; }
}

async function testSupabaseConnection() {
  try {
    const { error } = await supabaseClient.from('db_meta').select('key').limit(1);
    return !error;
  } catch(e) { return false; }
}

// ── 8. TECHNICAL INDICATORS ───────────────────────────────────────
// calcRSI/calcATR/calcTrimmedATR/calcMA/calcAvgVolume moved to
// core/indicators.js (Phase 0 extraction). Loaded as a classic <script>
// before this file — see index.html.

// ── Duration label helpers ─────────────────────────────────────────
function durBadgeClass(duration) {
  return duration === 'DAY' ? 'badge-day' : duration === '3-DAY' ? 'badge-swing' : 'badge-week';
}
function durBadgeText(duration) {
  return duration === 'DAY' ? 'EXIT TODAY' : duration === '3-DAY' ? '2-4 DAYS' : '5-7 DAYS';
}
function durHoldLabel(duration) {
  return duration === 'DAY' ? 'exit today' : duration === '3-DAY' ? 'est. 2-4 day' : 'est. 5-7 day';
}

// ── 9. SCORING ENGINE ─────────────────────────────────────────────

function classifyDuration(rsi, volRatio, closes) {
  const rsi3ago = closes.length >= 17 ? calcRSI(closes.slice(0, -3)) : rsi;
  const rsiTrending = rsi > rsi3ago;

  if (rsi > 68 || volRatio > 3) return 'DAY';

  if (rsi >= 48 && rsi <= 60 && rsiTrending && volRatio >= 1.2 && volRatio <= 1.8)
    return 'WEEK';

  if (rsi >= 52 && rsi <= 68 && volRatio >= 1.5 && volRatio <= 3)
    return '3-DAY';

  if (rsi > 65) return 'DAY';
  if (rsi < 50) return 'WEEK';
  return '3-DAY';
}

function calcEntryTargetStop(price, atr, duration, resistance = {}) {
  const entry = price;
  const atrFloor = Math.max(atr, price * 0.02); // minimum 2% of price
  let tMult, sMult;
  switch (duration) {
    case 'DAY':   tMult = 1.0; sMult = 0.75; break;
    case '3-DAY': tMult = 2.0; sMult = 1.0;  break;
    case 'WEEK':  tMult = 3.5; sMult = 1.5;  break;
    default:      tMult = 1.5; sMult = 1.0;
  }
  const rawTarget = entry + atrFloor * tMult;

  // Cap raw target at nearest resistance ceiling above entry (52wk high, swing high, or 20-day MA)
  const { high52, swingHigh10, ma20 } = resistance;
  const levels = [];
  if (high52 != null)      levels.push({ price: high52 * 0.98,      label: '52-week high' });
  if (swingHigh10 != null) levels.push({ price: swingHigh10 * 0.99, label: 'recent swing high' });
  if (ma20 != null && price < ma20) levels.push({ price: ma20 * 0.99, label: '20-day MA' });

  const applicable = levels.filter(l => l.price > entry);
  let target = rawTarget, cappedBy = null;
  if (applicable.length) {
    const nearest = applicable.reduce((a, b) => (b.price < a.price ? b : a));
    if (rawTarget > nearest.price) { target = nearest.price; cappedBy = nearest.label; }
  }
  target = Math.max(target, entry * 1.02);

  return {
    entry,
    target,
    stop: Math.min(entry - atrFloor * sMult, entry * 0.95),
    cappedBy
  };
}

function calcRiskScore(price, atr, rsi, volRatio, hasNegNews) {
  let r = price < 4 ? 6 : price < 10 ? 4 : 3;
  const atrPct = price > 0 ? (atr / price) * 100 : 0;
  if (atrPct > 10) r += 2; else if (atrPct > 6) r += 1;
  if (rsi > 75 || rsi < 30) r += 2;
  if (hasNegNews) r += 2;
  return Math.min(10, Math.max(1, r));
}

function scoreStock(ticker, snap, bars, newsItem, spyChangePct = 0, category = null) {
  const price = getLivePrice(snap);
  const prevClose = snap.prevDailyBar?.c || price;
  const volume = snap.dailyBar?.v || 0;

  if (bars.length < 15) return null;

  const sorted = [...bars].sort((a,b) => new Date(a.t) - new Date(b.t));
  const closes = sorted.map(b => b.c);
  const vols   = sorted.map(b => b.v);

  const rsi = calcRSI(closes);
  const atr = calcATR(sorted); // simple/untrimmed — feeds Risk Score only
  const trimmedAtr = calcTrimmedATR(sorted); // feeds target/stop only
  const ma20 = calcMA(closes, 20);
  const avgVol10 = calcAvgVolume(vols, 10);
  const volRatio = avgVol10 > 0 ? volume / avgVol10 : 1;
  const todayChange = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

  const duration = classifyDuration(rsi, volRatio, closes);
  // Resistance levels for target capping (Change 6). Window is whatever bars are
  // available (~100-125 trading days from the screener fetch), not a true 252-day
  // 52-week window — treated as an approximation per product decision.
  const high52 = Math.max(...sorted.map(b => b.h));
  const low52 = Math.min(...sorted.map(b => b.l));
  const last10ExclToday = sorted.slice(-11, -1);
  const swingHigh10 = last10ExclToday.length ? Math.max(...last10ExclToday.map(b => b.h)) : null;
  const { entry, target, stop, cappedBy } = calcEntryTargetStop(price, trimmedAtr, duration, { high52, swingHigh10, ma20 });

  let score = 0;
  // Volume spike (−10 to +20) — Change 9 (Scoring Formula v2): flipped so 1-2x
  // (75% win rate, best zone) scores highest; 3x+ (50% win rate, -4.7% avg,
  // worst performer — late retail pile-in) is now penalized instead of rewarded.
  if (volRatio >= 3) score -= 10;
  else if (volRatio >= 2) score += 10;
  else if (volRatio >= 1) score += 20;
  else if (volRatio >= 0.5) score += 15;
  // else (<0.5x): 0 pts — too quiet for a reliable liquidity signal
  // Price momentum (0–20)
  if (todayChange >= 4) score += 20;
  else if (todayChange >= 2) score += 10;
  // RSI (−10 to +20) — Change 8 (Scoring Formula v2): buckets re-derived from
  // 28-trade analysis. RSI 65-75 no longer rewarded (0% win rate in data);
  // RSI 75+ now penalized. Does not affect the separate Mean Reversion signal below.
  if (rsi >= 55 && rsi <= 65) score += 20;
  else if (rsi >= 35 && rsi < 55) score += 15;
  else if (rsi < 35) score += 10;
  else if (rsi > 65 && rsi <= 75) score += 0;
  else if (rsi > 75) score -= 10;
  // Above 20-day MA
  if (price > ma20) score += 10;

  // News: compute hasNegNews for risk/display — no longer affects score
  let hasNegNews = false;
  if (newsItem) {
    const hl = (newsItem.headline || '').toLowerCase();
    hasNegNews = NEG_KEYWORDS.some(kw => hl.includes(kw));
  }

  // Volume Build: 2 consecutive days of rising volume + today >= 1.3x avg (0–15)
  // Change 10 (Scoring Formula v2): loosened from 3 to 2 consecutive days —
  // near-miss data showed 2-day setups had a 100% win rate vs 67% for actual
  // 3-day fires, suggesting the old threshold caught the setup one day late.
  let consRisingVolDays = 0;
  for (let i = vols.length - 1; i > 0; i--) {
    if (vols[i] > vols[i-1]) consRisingVolDays++;
    else break;
  }
  let volBuild = false;
  if (vols.length >= 2 && volRatio >= 1.3) {
    const n = vols.length;
    if (vols[n-1] > vols[n-2]) {
      volBuild = true;
      score += 15;
    }
  }
  const volBuildNearMiss = !volBuild ? { consecutiveDays: consRisingVolDays, volRatio } : null;

  // CATALYST_SETUP detection (Change D: now scored +10, was Phase 1
  // informational-only at 0 pts; still does not affect signal beyond its
  // contribution to score, or target/stop/risk directly). All three must
  // hold: price near its 52-week low (same-window approximation as high52
  // above, per product decision — no extra fetch), RSI rising off oversold
  // but still <55, and volume building for 2+ consecutive days (reuses
  // consRisingVolDays from VOL_BUILD above, not rebuilt).
  const near52wLow = low52 > 0 && price <= low52 * 1.20;
  const rsi3ago = closes.length >= 18 ? calcRSI(closes.slice(0, -3)) : rsi;
  const risingFromOversold = rsi > rsi3ago && rsi < 55;
  const volBuilding2Days = consRisingVolDays >= 2;
  const catalystSetup = near52wLow && risingFromOversold && volBuilding2Days;
  if (catalystSetup) score += 10;

  // Mean Reversion: price 8–15% below 20MA, RSI < 45 and turning up (0–20)
  let meanReversion = false;
  const maPct = ma20 > 0 ? ((price - ma20) / ma20) * 100 : 0;
  if (maPct <= -8 && maPct >= -15 && rsi < 45 && closes.length >= 17) {
    const rsi2ago = calcRSI(closes.slice(0, -2));
    if (rsi > rsi2ago) {
      meanReversion = true;
      score += 20;
    }
  }
  const meanReversionNearMiss = !meanReversion ? { pctBelowMA: maPct, rsi } : null;

  // Consecutive up days (0–15 pts)
  let consUpDays = 0;
  for (let i = sorted.length - 1; i > 0; i--) {
    if (sorted[i].c > sorted[i-1].c) consUpDays++;
    else break;
  }
  let consUpPts = 0;
  if (consUpDays >= 4) consUpPts = 15;
  else if (consUpDays === 3) consUpPts = 10;
  else if (consUpDays === 2) consUpPts = 5;
  score += consUpPts;

  // Relative strength vs SPY (0–15 pts)
  const rsVsSPY = todayChange - spyChangePct;
  let relStrengthPts = 0;
  if (rsVsSPY >= 2) relStrengthPts = 15;
  else if (rsVsSPY >= 1) relStrengthPts = 10;
  else if (rsVsSPY > 0) relStrengthPts = 5;
  score += relStrengthPts;

  const signalsFired = [];
  if (volBuild) signalsFired.push('VOL_BUILD');
  if (meanReversion) signalsFired.push('MEAN_REVERSION');
  if (consUpDays >= 3) signalsFired.push('CONS_UP');

  const volTrend = volBuild ? 'building' : volRatio >= 1.5 ? 'spike' : 'normal';

  // Sub-$10 early entry timing (Change C) — RSI/volume-based adjustment layered
  // on top of the existing formula, tier-specific to sub-$10 stocks only (both
  // $1-$3 and $4-$9 ranges). Does not affect RAW_SCORE_MAX — see the comment
  // on that constant's definition for why these stack on top of it instead.
  let sub10Pts = 0;
  if (price < 10) {
    if (rsi < 45) sub10Pts += 10;
    else if (rsi >= 45 && rsi <= 55) sub10Pts += 5;
    else if (rsi > 60) sub10Pts -= 10;

    if (volRatio < 1.5) sub10Pts += 5;
    else if (volRatio > 2.5) sub10Pts -= 10;

    score += sub10Pts;
  }

  // Macro Market Overlay (Step 3): category-specific adjustment applied on top
  // of the raw accumulated score above, which is otherwise untouched. Floored
  // at 0 per spec (no upper cap — raw score can run up to RAW_SCORE_MAX plus
  // whatever macroAdjustment adds). macroCondition is null (adjustment 0) if macroContext hasn't
  // loaded yet or the fetch failed — never blocks scoring.
  // "Disable macro overlay" (state.settings.disableMacroOverlay) forces the
  // adjustment itself to 0 rather than skipping detection — macroCondition/
  // macroChanges below stay populated as normal (fetchMacroContext still runs
  // and the condition is still classified every session), only its effect on
  // score is suppressed. Forcing macroAdjustment to 0 here (not just skipping
  // the += below) also keeps it accurate for anything downstream that reads
  // s.macroAdjustment for display (e.g. the score breakdown row) — it
  // correctly shows no macro effect rather than a would-be value that was
  // never actually applied.
  const macroCondition = state.macroContext?.condition || null;
  const macroAdjustment = state.settings.disableMacroOverlay ? 0 : getMacroAdjustment(macroCondition, category);
  const macroChanges = state.macroContext?.changes || null;
  score = Math.max(0, score + macroAdjustment);

  const risk = calcRiskScore(price, atr, rsi, volRatio, hasNegNews);
  const priceRange = price <= 3 ? '$1–$3' : price <= 9 ? '$4–$9' : '$10–$20';
  const signal = score >= 116 ? 'STRONG BUY' : score >= 73 ? 'SOFT BUY' : 'WATCH';

  return {
    ticker, company: COMPANY_NAMES[ticker] || ticker,
    price, prevClose, todayChange, volume, volRatio,
    rsi, atr, trimmedAtr, ma20, duration, entry, target, stop, cappedBy,
    score, risk, signal, priceRange, news: newsItem, hasNegNews,
    volBuild, meanReversion, maPct, volTrend, signalsFired,
    volBuildNearMiss, meanReversionNearMiss,
    consUpDays, consUpPts, spyChange: spyChangePct, rsVsSPY, relStrengthPts,
    macroCondition, macroAdjustment, macroChanges, category,
    catalystSetup, sub10Pts,
    bars: sorted
  };
}

// ── 10. SCREENER ──────────────────────────────────────────────────

async function runScreener() {
  if (!state.settings.alpacaKey || !state.settings.alpacaSecret) {
    renderNoKeys(); return;
  }
  if (state.loading) return;
  state.loading = true;
  setRefreshSpinning(true);
  renderSkeletons();

  try {
    // 0. Macro context — fetched once per session, cached on state.macroContext.
    // Failure is non-fatal: scoring/UI just treat a null macroContext as no adjustment.
    if (!state.macroContext) {
      try {
        state.macroContext = await fetchMacroContext();
      } catch(e) { console.warn('Macro context error', e.message); }
    }

    // 1. Batch snapshots
    const snapshots = await fetchSnapshots(TICKERS, updateScanProgress);
    checkUnresolvedSymbols(TICKERS, snapshots);

    // 2. Filter price + volume
    const minVol = state.settings.minVolume || 100000;
    const minPrice = state.settings.includeUnder2 ? 1 : 1;
    const candidates = Object.entries(snapshots).filter(([, snap]) => {
      const p = getLivePrice(snap);
      const v = snap.dailyBar?.v || 0;
      return p >= minPrice && p <= 20 && v >= minVol;
    });

    state.lastPassedCount = candidates.length;
    persist('lastPassedCount');

    if (!candidates.length) {
      state.signals = []; state.lastScanTime = Date.now();
      persist('signals'); persist('lastScanTime');
      state.loading = false; setRefreshSpinning(false);
      renderSignalsTab(); return;
    }

    const ctickers = candidates.map(([t]) => t);

    // 3. Historical bars
    const allBars = await fetchMultiBars(ctickers, 100);

    // 4. News
    const newsItems = await fetchNewsForTickers(ctickers);
    const newsMap = {};
    newsItems.forEach(n => {
      (n.symbols || []).forEach(sym => {
        if (!newsMap[sym]) newsMap[sym] = n;
      });
    });

    // 5. SPY change for relative strength scoring
    let spyChangePct = 0;
    try {
      const spySnap = await fetchSnapshots(['SPY']);
      const spy = spySnap['SPY'];
      if (spy) {
        const spyP = getLivePrice(spy);
        const spyPrev = spy.prevDailyBar?.c || spyP;
        spyChangePct = spyPrev > 0 ? ((spyP - spyPrev) / spyPrev) * 100 : 0;
      }
    } catch(e) {}
    state.spyChange = spyChangePct;

    // 6. Pre-market movers (if applicable)
    if (isPreMarketHours()) {
      await computePreMarketMovers(snapshots, candidates.slice(0, 20), allBars, newsMap);
    }

    // 7. Score
    const category = state.selectedUniverse || 'OTHER';
    const macroCondition = state.macroContext?.condition || null;
    const displayThreshold = getDisplayThreshold(macroCondition, category);
    const updatedOwnedTickers = new Set();
    const scored = candidates.map(([ticker, snap]) => {
      const bars = allBars[ticker] || [];
      const s = scoreStock(ticker, snap, bars, newsMap[ticker] || null, spyChangePct, category);
      if (s) s.thresholdAtBuy = displayThreshold;
      // Owned positions often drift below the display threshold over time and
      // would otherwise never make it into state.signals — snapshot their score
      // here, before the threshold/price filters below can drop them, so the
      // Portfolio tab's Score Now always reflects the most recent scan.
      if (s && getOwnedPosition(ticker)) {
        state.ownedScores[ticker] = { score: s.score, label: s.signal };
        updatedOwnedTickers.add(ticker);
      }
      return s;
    }).filter(s => s && s.score >= displayThreshold);

    // 7. Apply under-$2 filter
    const minP2 = state.settings.includeUnder2 ? 0 : 2;
    const final = scored.filter(s => s.price >= minP2);

    state.signals = final;

    state.signals.sort((a,b) => b.score - a.score);
    state.lastScanTime = Date.now();

    // 7b. Owned tickers the main scan never reached at all — failed the
    // Stage 1 price/volume filter, or aren't in the currently selected
    // universe (TICKERS) in the first place — still need a fresh score, or
    // state.ownedScores silently keeps whatever it last held for them.
    // scoreStock() has no side effects (pure/sync), so it's safe to call
    // here; this is a small supplementary fetch since neither their
    // snapshot nor bars are guaranteed to already exist above.
    const ownedTickers = [...new Set(state.portfolio.map(p => p.ticker))];
    const missingOwnedTickers = ownedTickers.filter(t => !updatedOwnedTickers.has(t));
    if (missingOwnedTickers.length) {
      try {
        const [extraSnaps, extraBars] = await Promise.all([
          fetchSnapshots(missingOwnedTickers),
          fetchMultiBars(missingOwnedTickers, 100),
        ]);
        missingOwnedTickers.forEach(ticker => {
          const snap = extraSnaps[ticker];
          if (!snap) return;
          const bars = extraBars[ticker] || [];
          const tickerCategory = findTickerCategory(ticker) || category;
          const s = scoreStock(ticker, snap, bars, newsMap[ticker] || null, spyChangePct, tickerCategory);
          if (s) state.ownedScores[ticker] = { score: s.score, label: s.signal };
        });
      } catch(e) {
        console.warn('Owned-ticker score refresh failed:', e.message);
      }
    }

    persist('signals'); persist('lastScanTime'); persist('ownedScores');
    state.news = newsItems;
    persist('news');

    // Fetch SIP snapshots for after-hours price data when market is in AH window
    if (isAfterHoursMode() && state.signals.length) {
      try {
        state.ahSnapshots = await fetchAHSnapshots(state.signals.map(s => s.ticker));
      } catch(e) {}
    }

  } catch(err) {
    console.error('Screener error:', err);
    state.loading = false; setRefreshSpinning(false);
    renderAlpacaError(err.message); return;
  }

  state.loading = false;
  setRefreshSpinning(false);
  renderSignalsTab();
  updateNavBadges();
  writeRatingSnapshots(state.signals);
}

// Best-effort mirror of this run's qualifying signals into Supabase, plus a
// purge of anything older than 90 days. Never blocks or interrupts the
// screener — any failure (write or purge) is caught and logged, not thrown.
async function writeRatingSnapshots(signals) {
  const toWrite = (signals || []).filter(s => s.score >= 60);
  if (!toWrite.length) return;
  try {
    const capturedAt = new Date().toISOString();
    const rows = toWrite.map(s => ({
      ticker: s.ticker,
      captured_at: capturedAt,
      score: s.score,
      label: s.signal,
      rsi: s.rsi,
      volume_ratio: s.volRatio,
      price: s.price,
      macro_condition: s.macroCondition || null,
    }));
    const { error } = await supabaseClient.from('rating_snapshots').insert(rows);
    if (error) { console.error('Supabase snapshot write failed:', error.message); return; }
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    await supabaseClient.from('rating_snapshots').delete().lt('captured_at', cutoff);
  } catch(e) {
    console.error('Supabase snapshot write failed:', e.message);
  }
}

async function computePreMarketMovers(snapshots, candidates, allBars, newsMap) {
  const movers = candidates.map(([ticker, snap]) => {
    const prePrice = snap.minuteBar?.c || snap.latestTrade?.p || 0;
    const prevClose = snap.prevDailyBar?.c || 0;
    const pct = prevClose > 0 ? ((prePrice - prevClose) / prevClose) * 100 : 0;
    const bars = allBars[ticker];
    const rsi = (bars && bars.length) ? calcRSI(bars.map(b => b.c)) : null;
    const news = newsMap[ticker] || null;
    return { ticker, prePrice, pct, rsi, news };
  }).filter(m => m.prePrice > 0);

  movers.sort((a,b) => Math.abs(b.pct) - Math.abs(a.pct));
  state.preMarketMovers = movers.slice(0, 5);
}

function setRefreshSpinning(on) {
  const btn = document.getElementById('refresh-btn');
  if (btn) btn.classList.toggle('spinning', on);
}

function handleRefresh() {
  if (state.activeTab === 'signals') {
    const baseList = STOCK_UNIVERSES[state.selectedUniverse] || MASTER_TICKERS;
    TICKERS = baseList.length ? baseList : MASTER_TICKERS;
    runScreener();
  }
  else if (state.activeTab === 'portfolio') renderPortfolioTab();
}

// ── 11. SIGNALS TAB ───────────────────────────────────────────────

function renderSignalsTab() {
  const container = document.getElementById('tab-content');
  updateBudgetBar();

  if (!state.settings.alpacaKey) { renderNoKeys(); return; }

  const ms = getMarketStatus();
  const aft = isAfternoonMode();
  const title = aft ? 'AFTERNOON REVIEW' : 'MORNING SCAN';

  let html = `
    <div class="tab-header">
      <h1 class="tab-title">${title}</h1>
      <button class="btn btn-sm btn-primary" onclick="handleRefresh()">↻ Refresh</button>
    </div>
    ${getFreshnessHtml()}
    ${buildMacroBanner()}
  `;

  // Exit alerts (afternoon mode)
  if (aft && state.portfolio.length > 0) {
    const exitTickers = state.portfolio
      .filter(p => {
        const sig = state.signals.find(s => s.ticker === p.ticker);
        if (!sig) return false;
        const result = calcUnifiedRecommendation({ ...p, currentPrice: sig.price, rsi: sig.rsi }, sig, state.macroContext);
        return result.hardFloor || result.label === 'SELL NOW';
      })
      .map(p => p.ticker);
    if (exitTickers.length) {
      html += `<div class="exit-alerts-banner">🚨 EXIT ALERTS: ${exitTickers.join(', ')}</div>`;
    }
  }

  // Pre-market movers
  if (ms.status === 'PRE' && state.preMarketMovers?.length > 0) {
    html += renderPreMarketSection(state.preMarketMovers);
  }

  // Filters
  html += renderFilterButtons();

  if (!state.signals.length && !state.lastScanTime) {
    html += `<div class="empty-state">
      <div class="empty-icon">📊</div>
      <p>Tap Refresh to run your first scan.</p>
    </div>`;
  } else if (!state.signals.length) {
    html += `<div class="scan-summary">Market is quiet — no signals above threshold.</div>`;
    html += `<div class="empty-state">
      <div class="empty-icon">🔇</div>
      <p>Market is quiet right now. Try refreshing later.</p>
      <button class="btn btn-primary" onclick="runScreener()">↻ Refresh</button>
    </div>`;
  } else {
    // Exclude already-owned positions so the summary counts match the cards below.
    const unowned = state.signals.filter(s => !getOwnedPosition(s.ticker));
    const sb  = unowned.filter(s => s.signal === 'STRONG BUY').length;
    const sfb = unowned.filter(s => s.signal === 'SOFT BUY').length;
    const w   = unowned.filter(s => s.signal === 'WATCH').length;
    const total = TICKERS.length;
    const universe = state.selectedUniverse || 'OTHER';
    html += `<div class="scan-summary">Scanned ${total} stocks <span class="ss-universe">[${universe}]</span> — <span class="ss-strong">${sb} strong buy</span>, <span class="ss-soft">${sfb} soft buy</span>, <span class="ss-watch">${w} watch</span></div>`;

    const filtered = getFilteredSignals();
    if (!filtered.length) {
      html += `<div class="empty-state"><p>No signals match current filters.</p></div>`;
    } else {
      filtered.forEach(s => { html += renderStockCard(s, ms.status === 'CLOSED'); });
    }
  }

  container.innerHTML = html;
}

function renderPreMarketSection(movers) {
  let html = `<div class="premarket-section">
    <div class="premarket-title">⚡ PRE-MARKET MOVERS</div>`;
  movers.forEach(m => {
    const cls = m.pct >= 0 ? 'pos' : 'neg';
    const sign = m.pct >= 0 ? '▲' : '▼';
    html += `<div class="premarket-row" onclick="togglePreMarketRow('${m.ticker}')">
      <strong class="mono">${m.ticker}</strong>
      <span class="mono ${cls}">$${m.prePrice.toFixed(2)} ${sign}${Math.abs(m.pct).toFixed(1)}%</span>
    </div>`;
    html += buildPreMarketDetailPanel(m);
  });
  html += `<div style="font-size:10px;color:var(--muted);margin-top:6px;">Pre-market — exercise caution, lower liquidity</div>`;
  html += `</div>`;
  return html;
}

// RSI-from-yesterday's-close label used both in the detail panel and the
// Groq prompt (Step 4) — kept as one helper so the two stay in sync.
function preMarketRsiLabel(rsi) {
  if (rsi == null) return null;
  if (rsi < 45) return 'Oversold — potential bounce';
  if (rsi <= 65) return 'Neutral';
  return 'Elevated — may be extended';
}

// Yesterday's close isn't stored on the mover object (Step 1 fixed the shape
// at { ticker, prePrice, pct, rsi, news }) — it's recoverable exactly from
// prePrice/pct since pct was derived from it in computePreMarketMovers.
function preMarketPrevClose(m) {
  return m.prePrice / (1 + (m.pct || 0) / 100);
}

function buildPreMarketDetailPanel(m) {
  const company = COMPANY_NAMES[m.ticker];
  const prevClose = preMarketPrevClose(m);
  const rsiLabel = preMarketRsiLabel(m.rsi);
  const rsiStr = m.rsi == null ? 'N/A' : m.rsi.toFixed(1);
  const headline = m.news?.headline || null;

  return `<div class="premarket-detail hidden" id="premarket-detail-${m.ticker}">
    <div class="premarket-detail-name">${m.ticker}${company ? ` — ${company}` : ''}</div>
    <div class="premarket-detail-row">
      <span class="premarket-detail-label">Yesterday's close</span>
      <span class="mono">$${prevClose.toFixed(2)}</span>
    </div>
    <div class="premarket-detail-row">
      <span class="premarket-detail-label">RSI (yesterday's close)</span>
      <span class="mono">${rsiStr}${rsiLabel ? ` — ${rsiLabel}` : ''}</span>
    </div>
    <div class="premarket-detail-row">
      <span class="premarket-detail-label">News</span>
      <span>${headline ? `"${headline}"` : 'No recent news'}</span>
    </div>
    <button class="btn btn-sm btn-primary" style="margin-top:8px" onclick="event.stopPropagation();analyzePreMarketMover('${m.ticker}')">📊 Analyze with Groq</button>
    <div id="premarket-groq-${m.ticker}" class="premarket-groq-result"></div>
  </div>`;
}

// Only one row expanded at a time — collapse every panel first, then
// re-open the tapped one unless it was already open (tap-to-collapse).
function togglePreMarketRow(ticker) {
  const panel = document.getElementById(`premarket-detail-${ticker}`);
  if (!panel) return;
  const wasHidden = panel.classList.contains('hidden');
  document.querySelectorAll('.premarket-detail').forEach(el => el.classList.add('hidden'));
  if (wasHidden) {
    panel.classList.remove('hidden');
    if (state.preMarketGroqCache[ticker]) {
      renderPreMarketGroqResult(ticker, state.preMarketGroqCache[ticker]);
    }
  }
}

// Separate Groq call from groqAnalyze()/buildAIPrompt() — different prompt,
// different response labels (CONTINUES AFTER OPEN / FADES AT OPEN, which
// parseAIAnswers doesn't recognize), and its own session cache
// (state.preMarketGroqCache) so it doesn't collide with state.aiCache when
// the same ticker is both a pre-market mover and a regular signal.
function buildPreMarketGroqPrompt(m) {
  const prevClose = preMarketPrevClose(m);
  const rsiStr = m.rsi == null ? 'unavailable' : m.rsi.toFixed(1);
  const rsiContext = preMarketRsiLabel(m.rsi) || 'unavailable';
  const headline = m.news?.headline || 'none';
  const ctx = state.macroContext;
  const conditionLabel = ctx?.condition || 'N/A';
  const marketContext = ctx ? (ctx.explanation || MACRO_INTERPRETATIONS[ctx.condition] || 'N/A') : 'N/A';
  const spyPct = ctx?.changes?.SPY;
  const spyPreMarket = spyPct != null ? `${spyPct >= 0 ? '+' : ''}${spyPct.toFixed(2)}%` : 'unavailable';

  return `You are a short-term trading analyst evaluating a pre-market
price move. The regular market has not opened yet. Be direct and
specific. Express probabilities as whole number percentages.

Stock: ${m.ticker}
Pre-market price: $${m.prePrice.toFixed(2)}
Pre-market move: ${m.pct.toFixed(1)}% vs yesterday's close of $${prevClose.toFixed(2)}
RSI from yesterday's close: ${rsiStr}
RSI context: ${rsiContext}
Recent news: ${headline}
Current macro condition: ${conditionLabel}
Market context: ${marketContext}
SPY pre-market: ${spyPreMarket}

Important context: Pre-market moves on low volume frequently
reverse at market open. Moves backed by news or unusually high
pre-market volume are more likely to continue. Moves with no
news catalyst and RSI already elevated are high risk at open.

Respond in exactly this format with no extra text:

CONTINUES AFTER OPEN: {X}% likely
Key factor: {one sentence — the single most important reason}

FADES AT OPEN: {X}% likely
Key factor: {one sentence — the single most important reason}

Keep response to exactly 4 lines. No preamble, no disclaimers.`;
}

// Mirrors parseAIAnswers()'s shape but matches this prompt's own labels.
function parsePreMarketAIAnswer(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const labelRe = /^\**\s*(CONTINUES AFTER OPEN|FADES AT OPEN)\s*:\s*(\d+)\s*%\s*likely\s*\**$/i;
  const factorRe = /^\**\s*Key factor\s*:\s*(.*)$/i;

  const pairs = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(labelRe);
    if (!m) continue;
    const factorMatch = lines[i + 1] ? lines[i + 1].match(factorRe) : null;
    pairs.push({
      label: m[1].replace(/\s+/g, ' ').trim(),
      pct: parseInt(m[2], 10),
      factor: factorMatch ? factorMatch[1].trim() : '',
    });
  }

  if (pairs.length >= 2) return { pairs: pairs.slice(0, 2) };
  return { raw: text.trim() };
}

async function analyzePreMarketMover(ticker) {
  const m = (state.preMarketMovers || []).find(x => x.ticker === ticker);
  if (!m) return;
  const resultEl = document.getElementById(`premarket-groq-${ticker}`);
  if (!resultEl) return;

  if (state.preMarketGroqCache[ticker]) {
    renderPreMarketGroqResult(ticker, state.preMarketGroqCache[ticker]);
    return;
  }

  resultEl.innerHTML = `<div class="ai-loading">📊 Analyzing...</div>`;

  try {
    const key = state.settings.groqKey;
    if (!key) throw new Error('No Groq key');

    const prompt = buildPreMarketGroqPrompt(m);
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 2000
      })
    });
    if (!r.ok) throw new Error(`Groq ${r.status}`);
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || '';

    const result = parsePreMarketAIAnswer(text);
    state.preMarketGroqCache[ticker] = result;
    renderPreMarketGroqResult(ticker, result);
  } catch(e) {
    console.error('Pre-market Groq error:', e);
    resultEl.innerHTML = `<div class="ai-loading">Analysis unavailable</div>`;
  }
}

// Same visual pattern as renderAIResult() (bolded label + pct, factor on the
// next line) but targets this row's own result container instead of the
// modal's fixed #ai-section.
function renderPreMarketGroqResult(ticker, result) {
  const resultEl = document.getElementById(`premarket-groq-${ticker}`);
  if (!resultEl) return;
  let html = '';
  if (result.pairs) {
    result.pairs.forEach(p => {
      html += `<div class="ai-bullet">• <strong>${p.label}: ${p.pct}% likely</strong>${p.factor ? ` — ${p.factor}` : ''}</div>`;
    });
  } else {
    html += `<div class="ai-bullet">${(result.raw || '').replace(/\n/g, '<br>')}</div>`;
  }
  resultEl.innerHTML = html;
}

function renderFilterButtons() {
  const pf = state.filters.priceRange;
  const df = state.filters.duration;
  const t  = state.signalToggles;
  const u  = state.selectedUniverse || 'OTHER';
  const universes = ['HEALTHCARE','ENERGY','TECH','RETAIL','FINANCIAL','INDUSTRIAL','REAL_ESTATE','CONSUMER','OTHER'];
  return `
    <div class="filter-label">Universe</div>
    <div class="filter-row universe-row">
      ${universes.map(v =>
        `<button class="universe-btn ${u===v?'active':''}" onclick="setUniverse('${v}')">${v}</button>`
      ).join('')}
    </div>
    <div class="filter-row signal-toggle-row">
      <button class="signal-toggle signal-toggle-strong ${t.strongBuy?'active':''}" onclick="toggleSignal('strongBuy')">STRONG BUY</button>
      <button class="signal-toggle signal-toggle-soft ${t.softBuy?'active':''}" onclick="toggleSignal('softBuy')">SOFT BUY</button>
      <button class="signal-toggle signal-toggle-watch ${t.watch?'active':''}" onclick="toggleSignal('watch')">WATCH</button>
      <button class="signal-toggle signal-toggle-catalyst ${state.filters.catalystOnly?'active':''}" onclick="toggleCatalystFilter()">CATALYST</button>
    </div>
    <div class="filter-label">Price Range</div>
    <div class="filter-row">
      ${['all','$1–$3','$4–$9','$10–$20'].map(v =>
        `<button class="filter-btn ${pf===v?'active':''}" onclick="setFilter('priceRange','${v}')">${v==='all'?'All':v}</button>`
      ).join('')}
    </div>
    <div class="filter-label">Trade Duration</div>
    <div class="filter-row">
      ${['all','DAY','3-DAY','WEEK'].map(v =>
        `<button class="filter-btn ${df===v?'active':''}" onclick="setFilter('duration','${v}')">${v==='all'?'All':v==='DAY'?'Exit Today':v==='3-DAY'?'2-4 Days':'5-7 Days'}</button>`
      ).join('')}
    </div>
  `;
}

function setFilter(key, val) {
  state.filters[key] = val;
  renderSignalsTab();
}

function setUniverse(name) {
  state.selectedUniverse = name;
  persist('selectedUniverse');
  const baseList = STOCK_UNIVERSES[name] || MASTER_TICKERS;
  TICKERS = baseList.length ? baseList : MASTER_TICKERS;
  runScreener();
}

function toggleSignal(category) {
  state.signalToggles[category] = !state.signalToggles[category];
  persist('signalToggles');
  renderSignalsTab();
}

function toggleCatalystFilter() {
  state.filters.catalystOnly = !state.filters.catalystOnly;
  renderSignalsTab();
}

function sigToggleKey(signal) {
  if (signal === 'STRONG BUY' || signal === 'BUY') return 'strongBuy';
  if (signal === 'SOFT BUY') return 'softBuy';
  return 'watch';
}

function getFilteredSignals() {
  return state.signals.filter(s => {
    // Already-owned positions don't belong in buy-signal results.
    if (getOwnedPosition(s.ticker)) return false;
    if (!state.signalToggles[sigToggleKey(s.signal)]) return false;
    const { priceRange, duration, catalystOnly } = state.filters;
    if (catalystOnly && !s.catalystSetup) return false;
    if (priceRange !== 'all' && s.priceRange !== priceRange) return false;
    if (duration !== 'all' && s.duration !== duration) return false;
    return true;
  });
}

function renderSkeletons() {
  const container = document.getElementById('tab-content');
  let html = `
    <div class="tab-header"><h1 class="tab-title">SCANNING MARKET…</h1></div>
    <div class="scan-progress">
      <span id="scan-progress-text">Scanning… 0 / ${TICKERS.length.toLocaleString()} stocks</span>
      <div class="scan-progress-track"><div id="scan-progress-bar" class="scan-progress-bar" style="width:0%"></div></div>
    </div>
  `;
  for (let i = 0; i < 5; i++) html += `<div class="skel-card skeleton"></div>`;
  container.innerHTML = html;
}

function updateScanProgress(done, total) {
  const txt = document.getElementById('scan-progress-text');
  const bar = document.getElementById('scan-progress-bar');
  if (txt) txt.textContent = `Scanning… ${done.toLocaleString()} / ${total.toLocaleString()} stocks`;
  if (bar) bar.style.width = `${Math.round((done / total) * 100)}%`;
}

function renderNoKeys() {
  document.getElementById('tab-content').innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">🔑</div>
      <p>Welcome to EDGE.<br>Go to Settings to add your Alpaca and Groq API keys to get started.</p>
      <button class="btn btn-primary" onclick="switchTab('settings')">Open Settings</button>
    </div>`;
}

function renderAlpacaError(msg) {
  document.getElementById('tab-content').innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">⚠️</div>
      <p>Could not reach Alpaca. Check your API keys in Settings.</p>
      <p style="font-size:11px;color:var(--muted)">${msg}</p>
      <button class="btn btn-primary" onclick="switchTab('settings')">Open Settings</button>
    </div>`;
}

// ── 12. STOCK CARD ────────────────────────────────────────────────

function sigBadgeClass(signal) {
  if (signal === 'STRONG BUY' || signal === 'BUY') return 'badge-strong-buy';
  if (signal === 'SOFT BUY') return 'badge-soft-buy';
  return 'badge-watch';
}

function buildAHStrip(ticker) {
  if (!isAfterHoursMode()) return '';
  const ah = getAHData(ticker);
  if (!ah) return '';
  const { ahPrice, ahChangePct } = ah;
  const sign = ahChangePct >= 0 ? '+' : '';
  const cls  = ahChangePct >= 0 ? 'pos' : 'neg';
  const moverNote = Math.abs(ahChangePct) >= 2
    ? `<span class="ah-mover">${ahChangePct >= 0 ? '📈' : '📉'} Watch AM open</span>`
    : '';
  return `<div class="ah-strip">
    <span class="ah-label">After Hours</span>
    <span class="ah-price mono">$${ahPrice.toFixed(2)}</span>
    <span class="ah-change ${cls}">${sign}${ahChangePct.toFixed(2)}%</span>
    ${moverNote}
    <div class="ah-disclaimer">After hours — lower liquidity, wider spreads.</div>
  </div>`;
}

// Builds the 6-badge 2×3 grid for the redesigned stock card. Order matches
// the approved mockup: volume multiple, RSI, exit timing, buy/sell signal +
// score, volume-pattern flag, risk score. Pattern-flag priority (when more
// than one of volBuild/meanReversion/consUpDays fires at once, only one
// badge slot is available) is: reversal > volume build > consecutive up
// days > none — an arbitrary but consistent tie-break, not a data change.
function buildScBadges(s) {
  const isBuySignal = s.signal === 'STRONG BUY' || s.signal === 'BUY' || s.signal === 'SOFT BUY';
  const isDayExit = s.duration === 'DAY';
  let patternValue = '—', patternLabel = 'PATTERN';
  if (s.meanReversion) { patternValue = 'REVERSAL'; patternLabel = 'PATTERN'; }
  else if (s.volBuild) { patternValue = 'BUILDING'; patternLabel = 'VOL PATTERN'; }
  else if ((s.consUpDays || 0) >= 3) { patternValue = `${s.consUpDays}`; patternLabel = 'UP DAYS'; }
  // Same 1-3/4-6/7-10 thresholds as calcRiskScore's existing risk-low/mid/hi
  // buckets, remapped onto the new badge palette: amber is reserved for
  // urgency/timing (not risk), so mid-risk reads as neutral rather than
  // amber here.
  const riskCls = s.risk <= 3 ? 'sc-badge-green' : s.risk <= 6 ? 'sc-badge-neutral' : 'sc-badge-red';

  const badges = [
    { value: `${s.volRatio.toFixed(1)}×`, label: 'VOLUME', cls: 'sc-badge-neutral' },
    { value: `${s.rsi.toFixed(0)}`, label: 'RSI', cls: 'sc-badge-neutral' },
    { value: durBadgeText(s.duration), label: 'TIMING', cls: isDayExit ? 'sc-badge-amber' : 'sc-badge-neutral' },
    { value: `${s.score}`, label: s.signal, cls: isBuySignal ? 'sc-badge-green' : 'sc-badge-neutral' },
    { value: patternValue, label: patternLabel, cls: 'sc-badge-neutral' },
    { value: `${s.risk}/10`, label: 'RISK', cls: riskCls },
  ];
  // Change D: 7th badge, only present when CATALYST_SETUP fires — the grid is
  // auto-flowing (grid-auto-rows), not a fixed 2×3, so this just adds a 4th row.
  if (s.catalystSetup) {
    badges.push({ value: '🔍', label: 'CATALYST', cls: 'sc-badge-green' });
  }

  return badges.map(b => `
    <div class="sc-badge ${b.cls}">
      <div class="sc-badge-value">${b.value}</div>
      <div class="sc-badge-label">${b.label}</div>
    </div>`).join('');
}

function renderStockCard(s, marketClosed) {
  const priceCls = s.todayChange >= 0 ? 'pos' : 'neg';
  const chgSign  = s.todayChange >= 0 ? '▲' : '▼';
  const upside   = ((s.target - s.price) / s.price * 100).toFixed(1);
  // rawTarget in calcEntryTargetStop() is an ATR-volatility projection off
  // entry; cappedBy (when set) means that projection got capped down to a
  // nearby resistance level instead — this note reflects whichever actually
  // determined the shown target, it isn't new copy.
  const targetNote = s.cappedBy ? `Target capped at ${s.cappedBy}` : 'Target based on ATR-volatility projection';
  const ahStrip      = buildAHStrip(s.ticker);
  const actionBanner = buildSignalActionBanner(s);
  // Change 11: not marketClosed by construction whenever this is true (see
  // isDayTradeSuppressed comment), but guarded explicitly anyway so the two
  // overlays can never both render even if that invariant ever changes.
  const daySuppressed = !marketClosed && isDayTradeSuppressed(s.duration);
  const daySuppressedOverlay = daySuppressed
    ? `<div class="day-suppressed-overlay">⚠ Entry window closed — DAY trade signals expire at 10am</div>`
    : '';

  return `
    <div class="stock-card${daySuppressed ? ' stock-card-suppressed' : ''}" onclick="openStockModal('${s.ticker}')">
      ${daySuppressedOverlay}
      ${actionBanner}
      <div class="sc-header">
        <div class="sc-header-row">
          <span class="sc-ticker">${s.ticker}</span>
          <span class="sc-price ${priceCls}">$${s.price.toFixed(2)}</span>
          <span class="sc-pct ${priceCls}">${chgSign}${Math.abs(s.todayChange).toFixed(1)}%</span>
        </div>
        <div class="sc-company">${s.company}</div>
      </div>
      <div class="sc-grid">
        <div class="sc-target-card">
          <div class="sc-target-row">Target $${s.target.toFixed(2)}<span class="sc-target-pct">▲${upside}%</span></div>
          <div class="sc-target-note">${targetNote}</div>
          <div class="sc-stop-row">Stop $${s.stop.toFixed(2)}</div>
        </div>
        <div class="sc-badge-grid">
          ${buildScBadges(s)}
        </div>
      </div>
      ${buildCardNewsSnippet(s)}
      ${buildScoreBreakdown(s)}
      ${ahStrip}
    </div>`;
}

function buildSignalActionBanner(s) {
  const pt = getPT();
  const ptMin = pt.getHours() * 60 + pt.getMinutes();
  const isDay = s.duration === 'DAY';
  const tradingDay = isTradingDay(pt);

  // Change 11: once the 10am suppression overlay is active for a DAY trade,
  // don't also show these older MISSED/WINDOW CLOSING banners underneath it —
  // the grayed-out card + overlay already communicates "entry window closed,"
  // and the new threshold (10am) is always reached before either of these.
  if (isDay && isDayTradeSuppressed(s.duration)) return '';

  if (isDay && tradingDay && ptMin >= 720) {
    return `<div class="action-banner action-missed"><strong>MISSED — TOO LATE TODAY</strong></div>`;
  }
  if (isDay && tradingDay && ptMin >= 690) {
    return `<div class="action-banner action-window"><strong>WINDOW CLOSING</strong></div>`;
  }

  if (s.score < 50) return '';

  const allGreen = s.rsi >= 45 && s.rsi <= 72 && s.volRatio > 1.3 && s.price > s.ma20;
  if (allGreen) {
    return `<div class="action-banner action-buy-now"><strong>BUY NOW</strong> — All signals aligned</div>`;
  }

  let waitReason = '';
  if (s.rsi > 72) waitReason = `Wait for RSI to pull back below 70 (currently ${s.rsi.toFixed(0)})`;
  else if (s.volRatio <= 1.3) waitReason = `Wait for volume to exceed 1.3× avg (currently ${s.volRatio.toFixed(1)}×)`;
  else if (s.price <= s.ma20) waitReason = `Wait for price to reclaim 20-day MA`;

  return `<div class="action-banner action-wait"><strong>WAIT — WATCH FOR ENTRY</strong><span class="action-reason">${waitReason}</span></div>`;
}

// ── Card news + score breakdown helpers ──────────────────────────

function newsTimeAgo(news) {
  const ageH = (Date.now() - new Date(news.created_at).getTime()) / 3600000;
  if (ageH < 1) return `${Math.floor(ageH * 60)}m ago`;
  if (ageH < 24) return `${Math.floor(ageH)}h ago`;
  return `${Math.floor(ageH / 24)}d ago`;
}

function getNewsSentiment(hasNeg, createdAt) {
  if (hasNeg) return 'NEGATIVE';
  const ageH = (Date.now() - new Date(createdAt).getTime()) / 3600000;
  return ageH < 12 ? 'POSITIVE' : 'NEUTRAL';
}

function buildCardNewsSnippet(s) {
  if (!s.news) return `<div class="sc-news"><span class="sc-news-nonews">No recent news</span></div>`;
  const ageH = (Date.now() - new Date(s.news.created_at).getTime()) / 3600000;
  if (ageH > 24) return `<div class="sc-news"><span class="sc-news-nonews">No recent news</span></div>`;
  const ageStr = newsTimeAgo(s.news);
  const sentiment = getNewsSentiment(s.hasNegNews, s.news.created_at);
  const sentCls = sentiment === 'POSITIVE' ? 'sent-pos' : sentiment === 'NEGATIVE' ? 'sent-neg' : 'sent-neutral';
  const chgCls = s.todayChange >= 0 ? 'pos' : 'neg';
  const chgStr = `${s.todayChange >= 0 ? '+' : ''}${s.todayChange.toFixed(1)}% today`;
  const hl = (s.news.headline || '').substring(0, 85);
  const tail = (s.news.headline || '').length > 85 ? '…' : '';
  return `<div class="sc-news">
    <div class="sc-news-headline">"${hl}${tail}"</div>
    <div class="sc-news-meta">
      <span class="card-news-age">${ageStr}</span>
      <span class="news-sentiment ${sentCls}">${sentiment}</span>
      <span class="${chgCls}">${chgStr}</span>
    </div>
  </div>`;
}

function computeScoreBreakdown(s) {
  // Change 9 (Scoring Formula v2) — must mirror scoreStock()'s volume buckets exactly.
  let volPts = 0;
  let volNote = 'Too quiet — insufficient liquidity signal';
  if (s.volRatio >= 3) { volPts = -10; volNote = 'Volume spike — late entry risk'; }
  else if (s.volRatio >= 2) { volPts = 10; volNote = 'Elevated volume — moderate signal'; }
  else if (s.volRatio >= 1) { volPts = 20; volNote = 'Healthy volume — best win-rate zone'; }
  else if (s.volRatio >= 0.5) { volPts = 15; volNote = 'Quiet accumulation — strong historical performer'; }

  let momPts = 0;
  if (s.todayChange >= 4) momPts = 20;
  else if (s.todayChange >= 2) momPts = 10;

  // Change 8 (Scoring Formula v2) — must mirror scoreStock()'s RSI buckets exactly.
  let rsiPts = 0;
  let rsiNote = 'Overbought — caution';
  if (s.rsi >= 55 && s.rsi <= 65) { rsiPts = 20; rsiNote = 'Sweet spot — historically best win rate'; }
  else if (s.rsi >= 35 && s.rsi < 55) { rsiPts = 15; rsiNote = 'Neutral-bullish — solid performer'; }
  else if (s.rsi < 35) { rsiPts = 10; rsiNote = 'Oversold — potential bounce setup'; }
  else if (s.rsi > 65 && s.rsi <= 75) { rsiPts = 0; rsiNote = 'Elevated — no scoring bonus'; }
  else if (s.rsi > 75) { rsiPts = -10; rsiNote = 'Overbought — caution'; }

  const maPts      = s.price > s.ma20 ? 10 : 0;
  const volBuildPts = s.volBuild ? 15 : 0;
  const meanRevPts  = s.meanReversion ? 20 : 0;

  // Use pre-computed values from signal, fall back to recomputing
  const rsVsSPY       = s.rsVsSPY       ?? (s.todayChange - (s.spyChange || 0));
  const relStrPts     = s.relStrengthPts ?? (rsVsSPY >= 2 ? 15 : rsVsSPY >= 1 ? 10 : rsVsSPY > 0 ? 5 : 0);
  const consUpDays    = s.consUpDays     ?? 0;
  const consUpPts     = s.consUpPts      ?? (consUpDays >= 4 ? 15 : consUpDays === 3 ? 10 : consUpDays === 2 ? 5 : 0);

  const spySign = (s.spyChange || 0) >= 0 ? '+' : '';
  const rsSign  = rsVsSPY >= 0 ? '+' : '';

  const rows = [
    { key: 'vol',    short: 'vol',       label: `Volume (${s.volRatio.toFixed(1)}× avg) — ${volNote}`,                          pts: volPts,     fired: volPts > 0, neutral: volPts === 0 },
    { key: 'mom',    short: 'momentum',  label: `Price momentum (${s.todayChange>=0?'+':''}${s.todayChange.toFixed(1)}% today)`, pts: momPts,     fired: momPts > 0 },
    { key: 'rsi',    short: 'RSI',       label: `RSI position (${s.rsi.toFixed(0)}) — ${rsiNote}`,                              pts: rsiPts,     fired: rsiPts > 0, neutral: rsiPts === 0 },
    { key: 'ma',     short: 'MA',        label: `Above 20-day MA ($${s.ma20.toFixed(2)})`,                                      pts: maPts,      fired: maPts > 0 },
    { key: 'relstr', short: 'rel str',   label: `Relative strength (${rsSign}${rsVsSPY.toFixed(1)}% vs SPY ${spySign}${(s.spyChange||0).toFixed(1)}%)`, pts: relStrPts, fired: relStrPts > 0 },
    { key: 'consup', short: 'up days',   label: `Consecutive up days (${consUpDays} day${consUpDays !== 1 ? 's' : ''})`,        pts: consUpPts,  fired: consUpPts > 0 },
    { key: 'vbuild', short: 'vol build', label: `Volume build (2 days rising)`,                                                 pts: volBuildPts, fired: volBuildPts > 0 },
    { key: 'rev',    short: 'reversal',  label: `Mean reversion`,                                                               pts: meanRevPts, fired: meanRevPts > 0 },
  ];

  // Sub-$10 entry timing (Change C) — must mirror scoreStock()'s buckets exactly.
  // Only shown for sub-$10 stocks (both $1-$3 and $4-$9 tiers); no row at all
  // at $10+, same conditional-push pattern as the macro/catalyst rows below.
  if (s.price < 10) {
    let sub10Pts = 0;
    if (s.rsi < 45) sub10Pts += 10;
    else if (s.rsi >= 45 && s.rsi <= 55) sub10Pts += 5;
    else if (s.rsi > 60) sub10Pts -= 10;

    if (s.volRatio < 1.5) sub10Pts += 5;
    else if (s.volRatio > 2.5) sub10Pts -= 10;

    const sub10Label = sub10Pts > 0 ? 'Early entry bonus' : sub10Pts < 0 ? 'Late entry penalty' : 'Neutral entry timing';
    rows.push({
      key: 'sub10', short: 'entry timing',
      label: `Sub-$10 entry timing — ${sub10Label}`,
      pts: sub10Pts,
      fired: sub10Pts > 0,
      neutral: sub10Pts === 0,
    });
  }

  // CATALYST_SETUP (Change D: now scored +10, was 0-pt informational-only).
  // Contributes to the raw pre-normalization score in scoreStock(), so — unlike
  // the macro row below, which is applied post-normalization — this must be
  // pushed before the reconciliation row so it's counted in rawTotal.
  if (s.catalystSetup) {
    rows.push({
      key: 'catalyst', short: 'catalyst',
      label: `✓ Catalyst setup detected`,
      pts: 10,
      fired: true,
      neutral: false,
    });
  }

  const rawTotal = rows.reduce((sum, r) => sum + r.pts, 0);

  // Macro Market Overlay (Step 4) — only shown once macroContext has actually
  // loaded (s.macroCondition truthy); omitted entirely otherwise rather than
  // faking a CHOPPY/0pt row for data that was never fetched.
  const macroPts = s.macroCondition ? (s.macroAdjustment || 0) : 0;
  if (s.macroCondition) {
    rows.push({
      key: 'macro', short: 'macro',
      label: `Market condition: ${s.macroCondition} (${formatMacroConditionDetail(s.macroCondition, s.macroChanges)})`,
      pts: macroPts,
      fired: macroPts > 0,
      neutral: macroPts === 0,
    });
  }

  // The real final score: raw signal points + macro adjustment, floored at 0
  // exactly like scoreStock() does. Callers should display this, not s.score
  // — s.score can be stale or a hardcoded placeholder (see openStockModal's
  // fallback stock object for tickers no longer in the current scan), while
  // this is always freshly derived from the rows just computed above.
  const total = Math.max(0, rawTotal + macroPts);

  return { rows, total };
}

// Every row here fires at pts>=0 (never negative) except the Step 4 macro
// row, which can be negative (✗), zero-but-neutral/CHOPPY (—), or positive
// (✓). `neutral` is only set on rows where a 0-pt result should render as
// "—" instead of the default "✗" for not-fired.
function sbCheckIcon(r) {
  if (r.pts > 0) return { icon: '✓', cls: 'sb-chk-yes' };
  if (r.pts < 0) return { icon: '✗', cls: 'sb-chk-no' };
  return r.neutral ? { icon: '—', cls: 'sb-chk-neutral' } : { icon: '✗', cls: 'sb-chk-no' };
}

// Category color for a score-breakdown row, matching the card's badge
// semantics: volume/technical stats read as the neutral/blue "informational"
// tone, momentum-family signals read green (matches the buy-signal badge
// tone), and any negative contribution reads red regardless of category —
// it's still hurting the score. Purely a display grouping, not a change to
// which rows exist or what they're worth (see computeScoreBreakdown).
function sbContribClass(key, pts) {
  if (pts < 0) return 'sc-contrib-negative';
  if (key === 'vol' || key === 'rsi' || key === 'ma' || key === 'vbuild') return 'sc-contrib-vol';
  if (key === 'mom' || key === 'relstr' || key === 'consup' || key === 'rev') return 'sc-contrib-momentum';
  if (key === 'macro') return pts > 0 ? 'sc-contrib-momentum' : 'sc-contrib-neutral';
  return 'sc-contrib-neutral';
}

function buildScoreBreakdown(s) {
  // Always called with a real state.signals entry (Signals tab cards never
  // render from a fallback object) — s.score is authoritative and immune to
  // any later modal-open recomputation, so use it directly rather than
  // computeScoreBreakdown()'s own total (see buildModalScoreBreakdown for
  // why that distinction matters).
  const { rows } = computeScoreBreakdown(s);
  const total = s.score;
  const id   = `sb-${s.ticker}`;

  // Compact contributions line: every row that actually moved the score
  // (excludes any 0-pt rows), dot-separated, colored by category.
  const contribRows = rows.filter(r => r.pts !== 0);
  const contribsHtml = contribRows.length
    ? contribRows.map(r => `<span class="sc-contrib ${sbContribClass(r.key, r.pts)}">${r.short} ${r.pts > 0 ? '+' : ''}${r.pts}</span>`).join('<span class="sc-contrib-dot">·</span>')
    : `<span class="sc-contrib sc-contrib-neutral">No contributing signals</span>`;

  const rowsHtml = rows.map(r => {
    const ptsCls = r.pts > 0 ? 'sb-pos' : r.pts < 0 ? 'sb-neg' : 'sb-zero';
    const ptsStr = r.pts > 0 ? `+${r.pts}` : `${r.pts}`;
    const { icon, cls } = sbCheckIcon(r);
    return `<div class="sb-row">
      <span class="sb-check ${cls}">${icon}</span>
      <span class="sb-label">${r.label}</span>
      <span class="sb-pts ${ptsCls}">${ptsStr} pts</span>
    </div>`;
  }).join('');

  return `<div class="sc-score">
    <div class="sc-score-header">
      <span class="sc-score-title">Score breakdown</span>
      <span class="sc-score-total">${total} pts</span>
    </div>
    <div class="sc-score-contribs">${contribsHtml}</div>
    <button class="sc-score-toggle" onclick="event.stopPropagation();toggleBreakdown('${id}')">
      Full breakdown <span class="sb-arrow">▼</span>
    </button>
    <div class="sc-score-body hidden" id="${id}">${rowsHtml}</div>
  </div>`;
}

// authoritativeTotal/authoritativeSignal: the score/signal openStockModal
// already resolved (real signal → s.score/.signal; owned-but-unscanned →
// state.ownedScores; neither → null/null). When null, this function falls
// back to computeScoreBreakdown()'s own fresh total as a last resort.
//
// Deliberately NOT computeScoreBreakdown()'s total whenever an authoritative
// value exists: openStockModal recomputes consUpDays/consUpPts/rsVsSPY/
// relStrengthPts from its own independent bars fetch and overwrites them on
// this same object (for the Groq prompt's benefit) before this function
// ever runs, so by the time computeScoreBreakdown() reads them here they
// can differ from whatever produced the authoritative value — a single new
// day's bar is enough to flip a "2 consecutive up days" into "4", a real
// 5-to-15-point swing.
function buildModalScoreBreakdown(s, authoritativeTotal, authoritativeSignal) {
  const { rows, total: freshTotal } = computeScoreBreakdown(s);
  const total = authoritativeTotal != null ? authoritativeTotal : freshTotal;
  const signal = authoritativeSignal || (total >= 116 ? 'STRONG BUY' : total >= 73 ? 'SOFT BUY' : 'WATCH');
  const sigCls = signal === 'STRONG BUY' ? 'msb-strong'
               : signal === 'SOFT BUY' ? 'msb-soft' : 'msb-watch';

  const rowsHtml = rows.map(r => {
    const ptsCls = r.pts > 0 ? 'sb-pos' : r.pts < 0 ? 'sb-neg' : 'sb-zero';
    const ptsStr = r.pts > 0 ? `+${r.pts}` : r.pts === 0 ? '+0' : `${r.pts}`;
    const { icon, cls } = sbCheckIcon(r);
    return `<div class="sb-row msb-row">
      <span class="sb-check ${cls}">${icon}</span>
      <span class="sb-label msb-label">${r.label}</span>
      <span class="sb-pts ${ptsCls}">${ptsStr} pts</span>
    </div>`;
  }).join('');

  return `
    <div class="section-label">Score Breakdown</div>
    <div class="modal-score-breakdown">
      ${rowsHtml}
      <div class="msb-divider"></div>
      <div class="sb-row msb-row msb-total-row">
        <span class="sb-check" style="opacity:0">✓</span>
        <span class="sb-label msb-label msb-total-label">TOTAL</span>
        <span class="sb-pts sb-pos msb-total-pts">${total} pts</span>
      </div>
      <div class="sb-row msb-row">
        <span class="sb-check" style="opacity:0">✓</span>
        <span class="sb-label msb-label msb-total-label">SIGNAL</span>
        <span class="sb-pts ${sigCls} msb-total-pts">${signal}</span>
      </div>
    </div>`;
}

function toggleBreakdown(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const hidden = el.classList.toggle('hidden');
  const arrow = el.previousElementSibling?.querySelector('.sb-arrow');
  if (arrow) arrow.textContent = hidden ? '▼' : '▲';
}

function buildModalNewsSection(ticker) {
  const now = Date.now();
  const items = (state.news || [])
    .filter(n => (n.symbols || []).includes(ticker))
    .slice(0, 3);
  if (!items.length) return `<div class="section-label">Recent News</div><div class="card-no-news" style="padding:4px 0 8px">No recent news</div>`;
  const rowsHtml = items.map(n => {
    const ageH = (now - new Date(n.created_at).getTime()) / 3600000;
    const ageStr = ageH < 1 ? `${Math.floor(ageH*60)}m ago` : ageH < 24 ? `${Math.floor(ageH)}h ago` : `${Math.floor(ageH/24)}d ago`;
    const isNeg = NEG_KEYWORDS.some(kw => (n.headline||'').toLowerCase().includes(kw));
    const sentiment = getNewsSentiment(isNeg, n.created_at);
    const sentCls = sentiment === 'POSITIVE' ? 'sent-pos' : sentiment === 'NEGATIVE' ? 'sent-neg' : 'sent-neutral';
    return `<div class="modal-news-item">
      <div class="modal-news-headline">${n.headline||''}</div>
      <div class="modal-news-meta">
        <span class="card-news-age">${ageStr}</span>
        <span class="news-sentiment ${sentCls}">${sentiment}</span>
      </div>
    </div>`;
  }).join('');
  return `<div class="section-label">Recent News</div>${rowsHtml}`;
}

// ── 13. STOCK DETAIL MODAL ────────────────────────────────────────

let _priceChart = null;
let _chartBarsMinute  = [];
let _chartBarsHourly  = [];
let _chartCurrentPrice = 0;
let _modalStock = null;

async function openStockModal(ticker) {
  const s = state.signals.find(x => x.ticker === ticker);
  const ownedPos = getOwnedPosition(ticker);

  showModal(`<div class="modal-handle"></div>
    <div class="modal-header">
      <div>
        <div class="modal-title">${ticker}</div>
        <div style="font-size:12px;color:var(--muted)">${COMPANY_NAMES[ticker]||ticker}</div>
      </div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body" id="stock-modal-body">
      <div class="ai-loading"><span class="spinner"></span> Loading chart data…</div>
    </div>
    <div class="modal-footer" id="stock-modal-footer"></div>
  `);

  try {
    const [bars, minuteBars, hourlyBars] = await Promise.all([fetchSingleBars(ticker, 300), fetchMinuteBars(ticker), fetchHourlyBars(ticker)]);
    const sorted = [...bars].sort((a,b) => new Date(a.t) - new Date(b.t));
    _chartBarsMinute = [...minuteBars].sort((a,b) => new Date(a.t) - new Date(b.t));
    _chartBarsHourly = [...hourlyBars].sort((a,b) => new Date(a.t) - new Date(b.t));
    const closes = sorted.map(b => b.c);
    const vols   = sorted.map(b => b.v);

    const price   = (s?.price) || sorted[sorted.length-1]?.c || 0;
    _chartCurrentPrice = price;
    const prevClose = closes.length >= 2 ? closes[closes.length-2] : price;
    const fallbackTodayChange = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
    const rsi     = calcRSI(closes);
    const atr     = calcATR(sorted);
    const trimmedAtr = calcTrimmedATR(sorted);
    const ma20    = calcMA(closes, 20);
    const avgVol10 = calcAvgVolume(vols, 10);
    const volRatio = avgVol10 > 0 ? ((sorted[sorted.length-1]?.v||0) / avgVol10) : 1;

    const last252 = sorted.slice(-252);
    const high52  = last252.length ? Math.max(...last252.map(b => b.h)) : price;
    const low52   = last252.length ? Math.min(...last252.map(b => b.l)) : price;
    const last10ExclToday = sorted.slice(-11, -1);
    const swingHigh10 = last10ExclToday.length ? Math.max(...last10ExclToday.map(b => b.h)) : null;

    const stock = s || {
      ticker, company: COMPANY_NAMES[ticker]||ticker,
      price, rsi, atr, ma20, volRatio, bars: sorted,
      duration: classifyDuration(rsi, volRatio, closes),
      ...calcEntryTargetStop(price, trimmedAtr, classifyDuration(rsi, volRatio, closes), { high52, swingHigh10, ma20 }),
      score: 0, risk: calcRiskScore(price, atr, rsi, volRatio, false),
      priceRange: price <= 3 ? '$1–$3' : price <= 9 ? '$4–$9' : '$10–$20',
      todayChange: fallbackTodayChange, signal: 'WATCH', news: null
    };
    _modalStock = stock;
    // Genuinely live price/RSI from this modal's own fresh bar fetch — distinct from
    // stock.price/stock.rsi, which can be a stale state.signals cache entry when the
    // ticker is also in the current Signals scan. Used for owned-stock sell-warning calc.
    //
    // Prefers the latest 1-minute bar close (same live intraday data the "1 Day"
    // chart range uses) over the daily-bars endpoint's last row: during market
    // hours that daily bar is typically still yesterday's completed session, which
    // was silently overriding a correct `price` here and fed a stale P&L sign into
    // buildAIPrompt()'s owned-position branch (CONTINUE HIGHER vs FURTHER DROP).
    _modalStock.livePrice = _chartBarsMinute[_chartBarsMinute.length - 1]?.c || price;
    _modalStock.liveRsi = rsi;

    // Always recompute new signal values from fresh bars
    let modalConsUpDays = 0;
    for (let i = sorted.length - 1; i > 0; i--) {
      if (sorted[i].c > sorted[i-1].c) modalConsUpDays++;
      else break;
    }
    const modalConsUpPts  = modalConsUpDays >= 4 ? 15 : modalConsUpDays === 3 ? 10 : modalConsUpDays === 2 ? 5 : 0;
    const modalSpyChg     = state.spyChange || 0;
    const modalRsVsSPY    = (stock.todayChange || 0) - modalSpyChg;
    const modalRelStrPts  = modalRsVsSPY >= 2 ? 15 : modalRsVsSPY >= 1 ? 10 : modalRsVsSPY > 0 ? 5 : 0;
    stock.consUpDays     = modalConsUpDays;
    stock.consUpPts      = modalConsUpPts;
    stock.spyChange      = modalSpyChg;
    stock.rsVsSPY        = modalRsVsSPY;
    stock.relStrengthPts = modalRelStrPts;

    // Score/signal source, in priority order:
    // 1. Real state.signals entry (s exists) — stock.score/.signal are an
    //    authoritative scoreStock() result. Must be used as-is: the
    //    consUpDays/relStrengthPts recompute a few lines above mutates this
    //    same object for the Groq prompt's benefit and can disagree with
    //    what scoreStock() actually used, but never touches .score/.signal.
    // 2. No signals entry, but this is an owned position — state.ownedScores
    //    is refreshed for every owned ticker on every screener run (see
    //    runScreener()'s missingOwnedTickers pass), specifically so the
    //    Portfolio card's Score Now always has a fresh, authoritative value.
    //    That's exactly what this modal must also show — NOT an independent
    //    recompute from this modal's own bars fetch, which runs at a
    //    different time and would just reintroduce the same
    //    card-vs-modal mismatch one level down.
    // 3. Neither — a ticker with no signal and no ownedScores history at
    //    all. Only here does a best-effort fresh computeScoreBreakdown()
    //    total apply, since there's nothing authoritative to defer to.
    const ownedScoreEntry = state.ownedScores[ticker];
    let modalScoreTotal, modalScoreSignal;
    if (s) {
      modalScoreTotal = stock.score;
      modalScoreSignal = stock.signal;
    } else if (ownedScoreEntry) {
      modalScoreTotal = ownedScoreEntry.score;
      modalScoreSignal = ownedScoreEntry.label;
    } else {
      modalScoreTotal = computeScoreBreakdown(stock).total;
      modalScoreSignal = modalScoreTotal >= 116 ? 'STRONG BUY' : modalScoreTotal >= 73 ? 'SOFT BUY' : 'WATCH';
    }

    const chgCls  = stock.todayChange >= 0 ? 'change-pos' : 'change-neg';
    const chgSign = stock.todayChange >= 0 ? '▲' : '▼';
    const sigBadge = sigBadgeClass(modalScoreSignal);
    const riskCls  = stock.risk <= 3 ? 'risk-low' : stock.risk <= 6 ? 'risk-mid' : 'risk-hi';

    const rsiLabel = stock.rsi > 75 ? 'Overbought — caution'
      : stock.rsi < 35 ? 'Oversold bounce setup'
      : stock.rsi > 60 ? 'Bullish momentum'
      : 'Neutral';

    // When opened from Portfolio, Price Levels + duration reflect the actual position
    // (recorded at purchase), not a fresh recalculation — RSI/volume/score/chart still do.
    const displayEntry     = ownedPos ? ownedPos.buyPrice : stock.entry;
    const displayStop      = ownedPos ? ownedPos.stop     : stock.stop;
    const displayDuration  = ownedPos ? ownedPos.duration : stock.duration;
    const originalTarget   = ownedPos ? ownedPos.target   : stock.target;
    const originalCappedBy = ownedPos ? ownedPos.cappedByAtBuy : stock.cappedBy;
    const liveTarget       = stock.target; // already the fresh figure the Groq prompt uses
    const targetDriftPct   = ownedPos ? ((liveTarget - originalTarget) / originalTarget) * 100 : 0;
    const showLiveTarget   = ownedPos && Math.abs(targetDriftPct) > 5;
    const pnlDollar = ownedPos ? (price - ownedPos.buyPrice) * ownedPos.shares : null;
    const pnlPct    = ownedPos ? ((price - ownedPos.buyPrice) / ownedPos.buyPrice) * 100 : null;

    const durBadge = durBadgeClass(displayDuration);
    const durWhy = displayDuration === 'DAY'
      ? 'RSI elevated or volume spike detected — quick exit expected'
      : displayDuration === 'WEEK'
      ? 'RSI moderate with upward trend and steady volume — patient setup'
      : 'Moderate RSI with volume confirmation — medium-term swing';

    const upside = ((originalTarget - displayEntry) / displayEntry * 100).toFixed(1);
    const downside = ((displayStop - displayEntry) / displayEntry * 100).toFixed(1);

    // Change 11: Portfolio-tab positions (ownedPos truthy) are unaffected —
    // suppression only applies to Signals tab screener results.
    const daySuppressed = !ownedPos && isDayTradeSuppressed(displayDuration);
    const daySuppressedBanner = daySuppressed
      ? `<div class="day-suppressed-overlay" style="margin-bottom:12px">⚠ DAY trade — entry window has closed for today</div>`
      : '';

    // Unified recommendation — only meaningful for an owned position. Uses
    // this modal's own fresh live price/RSI (not the possibly-stale
    // state.signals snapshot).
    const unifiedModalBlock = ownedPos
      ? buildUnifiedRecommendationModalBlock(calcUnifiedRecommendation(
          { ...ownedPos, currentPrice: _modalStock.livePrice, rsi: _modalStock.liveRsi },
          s || state.ownedScores[ticker] || null,
          state.macroContext
        ))
      : '';

    document.getElementById('stock-modal-body').innerHTML = `
      ${daySuppressedBanner}
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
        <span class="price-mono" style="font-size:20px">$${price.toFixed(2)}</span>
        <span class="${chgCls}">${chgSign}${Math.abs(stock.todayChange).toFixed(1)}%</span>
        <span class="badge ${sigBadge}">${modalScoreSignal} ${modalScoreTotal}</span>
        <span class="badge ${durBadge}">${durBadgeText(displayDuration)}</span>
        ${stock.catalystSetup ? `<span class="badge badge-catalyst">🔍 CATALYST</span>` : ''}
        <span class="risk-pill ${riskCls}">Risk ${stock.risk}/10</span>
      </div>

      <div class="chart-range-btns">
        <button class="chart-range-btn active" data-range="1D" onclick="renderChartRange('1D')">1 Day</button>
        <button class="chart-range-btn" data-range="1W" onclick="renderChartRange('1W')">1 Week</button>
        <button class="chart-range-btn" data-range="1M" onclick="renderChartRange('1M')">1 Month</button>
      </div>
      <div class="chart-wrap">
        <canvas id="price-chart"></canvas>
      </div>

      <div class="section-label">Price Levels</div>
      <div class="levels-grid">
        <div class="level-cell">
          <div class="level-cell-label">52-Week High</div>
          <div class="level-cell-val pos">$${high52.toFixed(2)}</div>
        </div>
        <div class="level-cell">
          <div class="level-cell-label">52-Week Low</div>
          <div class="level-cell-val neg">$${low52.toFixed(2)}</div>
        </div>
        <div class="level-cell">
          <div class="level-cell-label">Entry</div>
          <div class="level-cell-val">$${displayEntry.toFixed(2)}</div>
        </div>
        <div class="level-cell">
          <div class="level-cell-label">Target (▲${upside}%)</div>
          <div class="level-cell-val pos">$${originalTarget.toFixed(2)}</div>
          ${originalCappedBy ? `<div class="target-capped-note">Capped at ${originalCappedBy}</div>` : ''}
          ${showLiveTarget ? `<div class="target-capped-note">Live: $${liveTarget.toFixed(2)} ⚠ Shifted</div>` : ''}
        </div>
        <div class="level-cell">
          <div class="level-cell-label">Stop-Loss (${downside}%)</div>
          <div class="level-cell-val neg">$${displayStop.toFixed(2)}</div>
        </div>
        <div class="level-cell">
          <div class="level-cell-label">20-Day MA</div>
          <div class="level-cell-val">$${stock.ma20.toFixed(2)}</div>
        </div>
        ${ownedPos ? `
        <div class="level-cell">
          <div class="level-cell-label">Unrealized P&L</div>
          <div class="level-cell-val ${pnlDollar>=0?'pos':'neg'}">${pnlDollar>=0?'+':''}$${pnlDollar.toFixed(2)} (${pnlPct>=0?'+':''}${pnlPct.toFixed(1)}%)</div>
        </div>` : ''}
      </div>

      <div class="section-label">Signal Breakdown</div>
      ${unifiedModalBlock}
      <div class="signal-row">
        <span class="signal-key">RSI (14-day)</span>
        <span class="signal-val">${stock.rsi.toFixed(1)} — ${rsiLabel}</span>
      </div>
      <div class="signal-row">
        <span class="signal-key">Volume vs 10-day avg</span>
        <span class="signal-val">${stock.volRatio.toFixed(2)}×</span>
      </div>
      <div class="signal-row">
        <span class="signal-key">vs 20-day MA</span>
        <span class="signal-val">${stock.price > stock.ma20 ? '✓ Above' : '✗ Below'} ${stock.maPct != null ? '(' + (stock.maPct >= 0 ? '+' : '') + stock.maPct.toFixed(1) + '%)' : ''}</span>
      </div>
      <div class="signal-row">
        <span class="signal-key">Volume Trend</span>
        <span class="signal-val">${
          (stock.volTrend || 'normal') === 'building' ? '📈 Building (3 days)' :
          (stock.volTrend || 'normal') === 'spike'    ? '⚡ Spike (today only)' :
                                                         'Normal'
        }</span>
      </div>
      <div class="signal-row">
        <span class="signal-key">vs Market</span>
        <span class="signal-val">${modalRsVsSPY >= 0
          ? `Outperforming SPY by ${modalRsVsSPY.toFixed(1)}%`
          : `Underperforming SPY by ${Math.abs(modalRsVsSPY).toFixed(1)}%`}
          <span style="color:var(--muted);font-size:11px"> (SPY ${modalSpyChg>=0?'+':''}${modalSpyChg.toFixed(1)}%)</span>
        </span>
      </div>
      <div class="signal-row">
        <span class="signal-key">Price Trend</span>
        <span class="signal-val">${modalConsUpDays >= 2
          ? `Up ${modalConsUpDays} days in a row`
          : modalConsUpDays === 1 ? 'Up 1 day'
          : 'No consecutive up days'}</span>
      </div>
      ${stock.meanReversion ? `<div class="signal-row">
        <span class="signal-key">Mean Reversion</span>
        <span class="signal-val" style="color:var(--purple);font-size:11px;max-width:60%;text-align:right">Oversold bounce setup — price significantly below average and momentum turning up</span>
      </div>` : ''}
      <div class="signal-row">
        <span class="signal-key">Duration</span>
        <span class="signal-val">${durBadgeText(displayDuration)} — ${durWhy}</span>
      </div>
      <div style="font-size:10px;color:var(--muted);padding:2px 0 8px;line-height:1.4">
        Duration is an estimate based on historical volatility. Always follow sell warnings over duration labels.
      </div>
      <div class="signal-row">
        <span class="signal-key">Price Range</span>
        <span class="signal-val">${stock.priceRange}</span>
      </div>

      ${buildModalScoreBreakdown(stock, modalScoreTotal, modalScoreSignal)}

      <div class="modal-news-section">${buildModalNewsSection(ticker)}</div>

      <div class="ai-section" id="ai-section">
        <div class="ai-title">AI Analysis <span style="font-size:10px;color:var(--muted)">(Groq)</span></div>
        <button class="btn btn-sm btn-primary" onclick="loadAIAnalysis('${ticker}')">${ownedPos ? '📊 Should I Hold or Sell?' : '📊 Should I Buy Now?'}</button>
      </div>
    `;

    document.getElementById('stock-modal-footer').innerHTML = ownedPos ? `
      <button class="btn btn-ghost" style="flex:1" disabled>✓ In Portfolio</button>
      <button class="btn btn-ghost" onclick="closeModal()">✕</button>
    ` : daySuppressed ? `
      <button class="btn btn-ghost" style="flex:1" disabled title="Entry window closed for today">+ Add to Portfolio</button>
      <button class="btn btn-ghost" onclick="closeModal()">✕</button>
    ` : `
      <button class="btn btn-success" style="flex:1" onclick="openAddPortfolioModal('${ticker}')">+ Add to Portfolio</button>
      <button class="btn btn-ghost" onclick="closeModal()">✕</button>
    `;

    // Draw chart — default 1D
    renderChartRange('1D');

    // Restore AI if cached
    if (state.aiCache[ticker]) {
      renderAIResult(state.aiCache[ticker]);
    }

  } catch(err) {
    document.getElementById('stock-modal-body').innerHTML = `
      <div class="empty-state"><p>Failed to load data for ${ticker}.<br><small>${err.message}</small></p></div>`;
  }
}

function renderChartRange(range) {
  document.querySelectorAll('.chart-range-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.range === range);
  });

  let bars, granularity = 'hourly';
  if (range === '1D') {
    granularity = 'minute';
    // Today's minute bars only. If today has none yet (pre-market, or the
    // feed's latest bar is from a prior session on a weekend/holiday), fall
    // back to whichever calendar day is most recent in the already-fetched
    // minute window rather than showing an empty chart.
    if (_chartBarsMinute.length) {
      const latestDay = new Date(_chartBarsMinute[_chartBarsMinute.length - 1].t).toDateString();
      bars = _chartBarsMinute.filter(b => new Date(b.t).toDateString() === latestDay);
    } else {
      bars = [];
    }
  } else if (range === '1W') {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
    bars = _chartBarsHourly.filter(b => new Date(b.t) >= cutoff);
  } else if (range === '1M') {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    bars = _chartBarsHourly.filter(b => new Date(b.t) >= cutoff);
  } else {
    bars = [];
  }

  renderPriceChart(bars, _chartCurrentPrice, granularity);
}

function renderPriceChart(bars, currentPrice, granularity = 'hourly') {
  const canvas = document.getElementById('price-chart');
  if (!canvas) return;
  if (_priceChart) { _priceChart.destroy(); _priceChart = null; }

  // 'minute' (1D, 1-min bars): time-of-day ticks on the hour, matching
  // Robinhood's intraday tick style. 'hourly' (1W/1M, 1-hour bars): date
  // ticks whenever the calendar day changes.
  const labels = bars.map((b, i) => {
    const d = new Date(b.t);
    const prev = i > 0 ? new Date(bars[i-1].t) : null;
    if (granularity === 'minute') {
      return (!prev || d.getHours() !== prev.getHours())
        ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
    }
    return (!prev || d.getDate() !== prev.getDate())
      ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  });

  _priceChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          data: bars.map(b => b.c),
          borderColor: '#00b4d8',
          borderWidth: 2,
          fill: false,
          tension: 0.2,
          pointRadius: 0,
        },
        {
          data: bars.map(() => currentPrice),
          borderColor: '#ffd16680',
          borderWidth: 1,
          borderDash: [5,5],
          fill: false,
          pointRadius: 0,
          tension: 0,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: ctx => `$${ctx.parsed.y.toFixed(2)}` }
        }
      },
      scales: {
        x: {
          grid: { color: '#1a2330' },
          ticks: { color: '#4a6070', maxRotation: 0,
            callback: (_, i) => labels[i] }
        },
        y: {
          grid: { color: '#1a2330' },
          ticks: { color: '#4a6070', callback: v => `$${v.toFixed(2)}` }
        }
      }
    }
  });
}

async function loadAIAnalysis(ticker) {
  const stock = _modalStock;
  if (!stock) return;
  const pos = getOwnedPosition(ticker);

  const sec = document.getElementById('ai-section');
  if (!sec) return;
  sec.innerHTML = `<div class="ai-title">AI Analysis</div><div class="ai-loading"><span class="spinner"></span> Analyzing with Groq…</div>`;

  try {
    const prompt = buildAIPrompt(stock, pos);
    const result = await groqAnalyze(ticker, prompt);
    renderAIResult(result);
  } catch(e) {
    console.error('Groq AI error:', e);
    sec.innerHTML = `<div class="ai-title">AI Analysis</div>
      <div class="ai-loading" style="color:var(--red)">AI unavailable — ${e.message}. Check Groq key in Settings.</div>`;
  }
}

function renderAIResult(result) {
  const sec = document.getElementById('ai-section');
  if (!sec) return;
  let html = `<div class="ai-title">AI Analysis <span style="font-size:10px;color:var(--muted)">(Groq)</span></div>`;
  if (result.pairs) {
    result.pairs.forEach(p => {
      html += `<div class="ai-bullet">• <strong>${p.label}: ${p.pct}% likely</strong>${p.factor ? ` — ${p.factor}` : ''}</div>`;
    });
  } else {
    // Parsing failed to find the expected 2-pair shape — show the raw
    // response rather than silently dropping what Groq actually returned.
    html += `<div class="ai-bullet">${(result.raw || '').replace(/\n/g, '<br>')}</div>`;
  }
  sec.innerHTML = html;
}

// ── 14. MODAL HELPERS ─────────────────────────────────────────────

function showModal(html) {
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.body.style.overflow = '';
  if (_priceChart) { _priceChart.destroy(); _priceChart = null; }
}

function handleOverlayClick(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
}

function showConfirm(msg, cb, confirmLabel) {
  document.getElementById('confirm-msg').textContent = msg;
  const btn = document.getElementById('confirm-btn');
  if (btn) btn.textContent = confirmLabel || 'Confirm';
  state._confirmCb = cb;
  document.getElementById('confirm-overlay').classList.remove('hidden');
}

function closeConfirm() {
  document.getElementById('confirm-overlay').classList.add('hidden');
  state._confirmCb = null;
}

function confirmAction() {
  if (state._confirmCb) state._confirmCb();
  closeConfirm();
}

// ── 15. PORTFOLIO TAB ──────────────────────────────────────────────

function openAddPortfolioModal(ticker) {
  const price = state.signals.find(s => s.ticker === ticker)?.price || 0;
  const today = new Date().toISOString().split('T')[0];

  showModal(`<div class="modal-handle"></div>
    <div class="modal-header">
      <div class="modal-title">Add ${ticker} to Portfolio</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Shares Purchased</label>
        <input id="pf-shares" class="form-input" type="number" min="0.01" step="0.01" placeholder="100">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Price Paid per Share</label>
          <input id="pf-price" class="form-input" type="number" step="0.01" value="${price.toFixed(2)}">
        </div>
        <div class="form-group">
          <label class="form-label">Date Purchased</label>
          <input id="pf-date" class="form-input" type="date" value="${today}">
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-success" style="flex:1" onclick="confirmAddPortfolio('${ticker}', this)">+ Add Position</button>
    </div>`);
}

// Buy-time signal-component derivation for trade-record capture (data
// capture only — duplicates scoreStock()'s bucket logic rather than
// refactoring it, since scoring itself must not change). Keep these in
// sync with scoreStock() (app.js ~2178-2271) if any bucket ever changes.
function deriveVolSpikePts(volRatio) {
  if (volRatio == null) return null;
  if (volRatio >= 3) return -10;
  if (volRatio >= 2) return 10;
  if (volRatio >= 1) return 20;
  if (volRatio >= 0.5) return 15;
  return 0;
}
function derivePriceMomentumPts(todayChange) {
  if (todayChange == null) return null;
  if (todayChange >= 4) return 20;
  if (todayChange >= 2) return 10;
  return 0;
}
function deriveRsiPts(rsi) {
  if (rsi == null) return null;
  if (rsi >= 55 && rsi <= 65) return 20;
  if (rsi >= 35 && rsi < 55) return 15;
  if (rsi < 35) return 10;
  if (rsi > 65 && rsi <= 75) return 0;
  return -10; // rsi > 75
}

async function confirmAddPortfolio(ticker, btn) {
  const shares = parseFloat(document.getElementById('pf-shares').value);
  const price  = parseFloat(document.getElementById('pf-price').value);
  const date   = document.getElementById('pf-date').value;

  if (!shares || !price || isNaN(shares) || isNaN(price)) {
    alert('Please enter shares and price.'); return;
  }

  const sig = state.signals.find(s => s.ticker === ticker);

  const position = {
    id: Date.now().toString(),
    ticker,
    company: COMPANY_NAMES[ticker] || ticker,
    shares, buyPrice: price, buyDate: date,
    target:   sig?.target || price * 1.10,
    stop:     sig?.stop   || price * 0.92,
    duration: sig?.duration || '3-DAY',
    scoreAtBuy:      sig?.score || 0,
    rsiAtBuy:        sig?.rsi   || 0,
    volRatioAtBuy:   sig?.volRatio || 0,
    riskAtBuy:       sig?.risk  || 5,
    newsAtBuy:       sig?.news?.headline || '',
    signalsFiredAtBuy: sig?.signalsFired || [],
    volBuildNearMiss:      sig?.volBuildNearMiss      || null,
    meanReversionNearMiss: sig?.meanReversionNearMiss || null,
    cappedByAtBuy: sig?.cappedBy || null,
    rawAtrAtBuy:     sig?.atr        ?? null,
    trimmedAtrAtBuy: sig?.trimmedAtr ?? null,
    macroConditionAtBuy: sig?.macroCondition || null,
    thresholdAtBuy: sig?.thresholdAtBuy ?? BASE_SCORE_THRESHOLD,
    catalystSetup: sig?.catalystSetup || false,
    peakPrice:   price,
    peakPriceDate: date,
    momentumProtectionActivated: false,
    rsiSuspendedAtGainPct: null,
    buyTime: (() => {
      const pt = getPT();
      return `${String(pt.getHours()).padStart(2,'0')}:${String(pt.getMinutes()).padStart(2,'0')}`;
    })(),
    buyDayOfWeek: DAY_NAMES[getPT().getDay()],
    buySession: isPreMarketHours() ? 'PRE_MARKET' : 'REGULAR',
    subTenEntryAdjustment: sig?.sub10Pts ?? 0,
    // Buy-time score breakdown capture (data capture only). scoreStock() no
    // longer normalizes (Change 1, raw-score project) — sig.score IS the raw
    // score now, so rawScoreAtBuy trivially mirrors scoreAtBuy for any trade
    // captured from this version forward. Kept as a separate field (rather
    // than deleted) for continuity with trades captured before this change,
    // where it really was a distinct back-calculated approximation.
    priceMomentumPts: sig ? derivePriceMomentumPts(sig.todayChange) : null,
    volSpikePts:      sig ? deriveVolSpikePts(sig.volRatio) : null,
    rsiPts:           sig ? deriveRsiPts(sig.rsi) : null,
    maPts:            sig ? (sig.price > sig.ma20 ? 10 : 0) : null,
    volBuildPts:      sig ? (sig.volBuild ? 15 : 0) : null,
    meanReversionPts: sig ? (sig.meanReversion ? 20 : 0) : null,
    consUpDays:       sig?.consUpDays ?? null,
    consUpPts:        sig?.consUpPts ?? null,
    relStrengthPts:   sig?.relStrengthPts ?? null,
    macroAdjustmentPts: sig?.macroAdjustment ?? null,
    maPctAtBuy:       sig?.maPct ?? null,
    rawScoreAtBuy:    sig ? sig.score : null,
    groqProbabilityAtBuy: (() => {
      const cached = state.aiCache[ticker];
      const firstPair = cached?.pairs?.[0];
      return firstPair ? `${firstPair.label}: ${firstPair.pct}% likely` : null;
    })(),
  };

  // Supabase is now the source of truth for portfolio (Data Migration
  // project, Step 5) — await the write and only reflect it locally on
  // success, so state.portfolio can never show a position that isn't
  // actually saved. On failure, leave the modal open so the user can retry
  // rather than silently losing the add.
  if (btn) btn.disabled = true;
  try {
    await savePositionToSupabase(position);
  } catch(e) {
    alert('Could not save position to Supabase: ' + e.message);
    if (btn) btn.disabled = false;
    return;
  }

  state.portfolio.push(position);
  closeModal();
  updateNavBadges();
  switchTab('portfolio');
}

async function renderPortfolioTab() {
  const container = document.getElementById('tab-content');
  updateBudgetBar();
  const aft = isAfternoonMode();

  if (!state.portfolio.length) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-icon">💼</div>
      <p>No open positions yet.<br>Find a signal and tap "+ Add to Portfolio".</p>
    </div>`;
    return;
  }

  const weekendBanner = buildWeekendBanner();
  container.innerHTML = `<div class="tab-header">
    <h1 class="tab-title">PORTFOLIO</h1>
    <button class="btn btn-sm btn-ghost" onclick="renderPortfolioTab()">↻</button>
  </div>
  ${weekendBanner}
  <div id="pf-list"><div class="empty-state"><span class="spinner"></span></div></div>
  <div id="pf-summary"></div>`;

  // Fetch live prices
  const tickers = state.portfolio.map(p => p.ticker);
  let snapshots = {};
  let allBars   = {};
  let pfAHSnaps = {};
  try {
    if (state.settings.alpacaKey) {
      const fetches = [fetchSnapshots(tickers), fetchMultiBars(tickers, 100)];
      if (isAfterHoursMode()) fetches.push(fetchAHSnapshots(tickers));
      const results = await Promise.all(fetches);
      [snapshots, allBars] = results;
      if (isAfterHoursMode()) pfAHSnaps = results[2] || {};
    }
  } catch(e) {}

  let totalCost = 0, totalValue = 0;
  let html = '';

  // Sort by urgency: how much of the position's intended hold duration has
  // elapsed. Ratio >= 1.0 (at/past max duration) naturally sorts to the top
  // since it's just the largest values in a descending sort.
  const maxHoldDays = { DAY: 1, '3-DAY': 4, WEEK: 7 };
  const sortedPortfolio = [...state.portfolio].sort((a, b) => {
    const daysHeldA = Math.floor((Date.now() - new Date(a.buyDate).getTime()) / 86400000);
    const daysHeldB = Math.floor((Date.now() - new Date(b.buyDate).getTime()) / 86400000);
    const ratioA = daysHeldA / maxHoldDays[a.duration];
    const ratioB = daysHeldB / maxHoldDays[b.duration];
    return ratioB - ratioA;
  });

  sortedPortfolio.forEach(p => {
    const snap = snapshots[p.ticker];
    const bars = (allBars[p.ticker] || []).sort((a,b) => new Date(a.t)-new Date(b.t));
    const closes = bars.map(b => b.c);

    const currentPrice = getLivePrice(snap) || p.buyPrice;
    const rsi = closes.length >= 15 ? calcRSI(closes) : p.rsiAtBuy;
    const trimmedAtr = bars.length >= 15 ? calcTrimmedATR(bars) : 0;

    // Snapshot the prior render's RSI before overwriting — calcPeakRiskScore
    // needs this to detect "declining from peak" (RSI was >70, now lower).
    // No stored value yet (first render / never-before-seen ticker) → null,
    // so that factor is skipped rather than assumed.
    const prevRSI = state.ownedPrevRSI[p.ticker] ?? null;
    p.prevRSI = prevRSI;
    if (rsi != null) {
      state.ownedPrevRSI[p.ticker] = rsi;
      persist('ownedPrevRSI');
      // Running max across the hold — feeds peakRsiDuringHold on the sold
      // record at confirmMarkSold() time (Change 5).
      state.ownedPeakRSI[p.ticker] = Math.max(state.ownedPeakRSI[p.ticker] ?? -Infinity, rsi);
      persist('ownedPeakRSI');
    }

    // Live recalculated target (display-only — sell warnings keep using p.target)
    const liveTarget = trimmedAtr > 0 ? calcEntryTargetStop(currentPrice, trimmedAtr, p.duration).target : null;
    p.liveTarget = liveTarget;

    // Update peak + Momentum Protection state (Rule 1). Activation is sticky —
    // once true it never reverts, even if price later pulls back under +20%,
    // so RSI/target suspension (Rule 2) doesn't flicker on and off.
    // Supabase writes below are fire-and-forget (errors logged, not thrown) —
    // these are passive background refinements during a render, not a user
    // action, so blocking the whole Portfolio tab on a network round-trip
    // per position per field would be a real UX regression. Unlike
    // confirmAddPortfolio()/confirmMarkSold() (Step 5), a lost write here
    // just gets recomputed and re-sent on the next render.
    if (currentPrice > (p.peakPrice || 0)) {
      p.peakPrice = currentPrice;
      p.peakPriceDate = new Date().toISOString().split('T')[0];
      if (state.deletedPositionIds.has(p.id)) return;
      savePositionToSupabase(p).catch(e => console.error('Supabase portfolio update failed:', e.message));
    }
    if (!p.momentumProtectionActivated && p.peakPrice >= p.buyPrice * 1.20) {
      p.momentumProtectionActivated = true;
      if (state.deletedPositionIds.has(p.id)) return;
      savePositionToSupabase(p).catch(e => console.error('Supabase portfolio update failed:', e.message));
    }
    // Rule 5 support: first time RSI hits the (soon-to-be-suspended) 72+ threshold
    // while protected, snapshot the gain% at that instant — sticky, never overwritten —
    // so the report can later show what an RSI-based exit would have left on the table.
    if (p.momentumProtectionActivated && p.rsiSuspendedAtGainPct == null && rsi >= 72) {
      p.rsiSuspendedAtGainPct = ((currentPrice - p.buyPrice) / p.buyPrice) * 100;
      if (state.deletedPositionIds.has(p.id)) return;
      savePositionToSupabase(p).catch(e => console.error('Supabase portfolio update failed:', e.message));
    }

    state.portfolioPrices[p.ticker] = currentPrice;

    const cost  = p.shares * p.buyPrice;
    const value = p.shares * currentPrice;
    totalCost  += cost;
    totalValue += value;

    const pnlDollar = value - cost;
    const pnlPct    = ((currentPrice - p.buyPrice) / p.buyPrice * 100);
    const pnlCls    = pnlDollar >= 0 ? 'pos' : 'neg';

    const days = Math.floor((Date.now() - new Date(p.buyDate).getTime()) / 86400000);
    const durLabel = durHoldLabel(p.duration);

    const currentSignal = state.signals.find(s => s.ticker === p.ticker) || state.ownedScores[p.ticker] || null;
    const unifiedResult = calcUnifiedRecommendation({ ...p, currentPrice, rsi }, currentSignal, state.macroContext, snap);
    const portBanner = buildUnifiedPortfolioBanner(unifiedResult);
    const fridayFlag   = buildFridayFlag(p, currentPrice, pnlPct);
    const priceDiffPct = ((currentPrice - p.buyPrice) / p.buyPrice) * 100;
    const nowCls = Math.abs(priceDiffPct) < 1 ? 'pf-now-flat' : priceDiffPct > 0 ? 'pf-now-up' : 'pf-now-down';
    const priceBarCls = pnlDollar >= 0 ? 'pf-bar-profit' : 'pf-bar-loss';

    // Display-only target (sell warnings keep using p.target) — same >5% drift
    // threshold used for the card's "⚠ Shifted" note and the SELL SOON banner.
    const targetDriftPct = liveTarget ? ((liveTarget - p.target) / p.target) * 100 : 0;
    const priceBarTarget = (liveTarget && Math.abs(targetDriftPct) > 5) ? liveTarget : p.target;

    // Rule 4: trailing stop recalculated from peakPrice every refresh, same threshold
    // as the trailing-stop-warning factor in calcUnifiedRecommendation.
    const momentumBadge = p.momentumProtectionActivated
      ? `<div class="pf-momentum">🚀 Momentum protection active — trailing stop $${(p.peakPrice * 0.85).toFixed(2)}</div>`
      : '';

    // Build AH row for portfolio card
    let pfAHHtml = '';
    if (isAfterHoursMode()) {
      const ahSnap = pfAHSnaps[p.ticker];
      const ahPrice = ahSnap?.latestTrade?.p;
      const regClose = ahSnap?.dailyBar?.c || currentPrice;
      if (ahPrice && ahPrice !== regClose) {
        const ahChg = ((ahPrice - regClose) / regClose) * 100;
        const ahSign = ahChg >= 0 ? '+' : '';
        const ahCls  = ahChg >= 0 ? 'pos' : 'neg';
        const moverTag = Math.abs(ahChg) >= 2
          ? `<span class="ah-mover">${ahChg >= 0 ? '📈' : '📉'} Watch AM</span>` : '';
        pfAHHtml = `<div class="pf-ah-row">
          <span class="ah-label">After Hours</span>
          <span class="mono" style="color:var(--yellow)">$${ahPrice.toFixed(2)}</span>
          <span class="ah-change ${ahCls}">${ahSign}${ahChg.toFixed(2)}%</span>
          ${moverTag}
          <div class="ah-disclaimer">After hours — lower liquidity, wider spreads.</div>
        </div>`;
      }
    }

    // Purchased-on date, formatted MM / DD / YYYY (buyDate is stored as an
    // ISO yyyy-mm-dd string from the <input type="date"> in Add to Portfolio).
    const [buyY, buyM, buyD] = p.buyDate.split('-');
    const purchasedOnDisplay = `${buyM} / ${buyD} / ${buyY}`;

    // Score at purchase — same STRONG BUY/SOFT BUY/WATCH thresholds as the live
    // scoring formula (scoreStock), applied to the score snapshotted at buy time.
    const scoreBuyLabel = p.scoreAtBuy >= 116 ? 'STRONG BUY' : p.scoreAtBuy >= 73 ? 'SOFT BUY' : 'WATCH';
    const scoreBuyCls   = p.scoreAtBuy >= 116 ? 'pf-score-green' : 'pf-score-yellow';

    // Score now — state.ownedScores is snapshotted every screener run for owned
    // tickers specifically (see runScreener), even when they no longer clear the
    // display threshold and so don't appear in state.signals. Fall back to
    // state.signals for the rare case ownedScores hasn't been populated yet
    // (e.g. a position added before this cache existed), else show a placeholder.
    //
    // Known limitation: this can disagree with the Stock Detail Modal, which
    // recomputes a fresh score from live bars when opened (see openStockModal)
    // rather than reading this same cache. Making this card do a live fetch
    // per position on every render would be a much larger change, so instead
    // the "(last scan)" label makes the cache explicit rather than silently
    // showing a number that might not match what the modal shows right now.
    const ownedScore = state.ownedScores[p.ticker];
    const liveSignal = state.signals.find(s => s.ticker === p.ticker);
    const nowScore = ownedScore
      ? ownedScore
      : liveSignal ? { score: liveSignal.score, label: liveSignal.signal } : null;
    const scoreNowDisplay = nowScore
      ? `${nowScore.score} <span class="pf-score-label ${nowScore.score >= 116 ? 'pf-score-green' : 'pf-score-yellow'}">${nowScore.label}</span>${ownedScore ? ' <span class="pf-score-stale">(last scan)</span>' : ''}`
      : `<span class="pf-score-na">—</span>`;

    // Duration urgency — same maxHoldDays map used for the card sort order above.
    const maxHold = maxHoldDays[p.duration];
    const daysLeft = Math.max(0, maxHold - days);
    const durationPct = Math.min(100, (days / maxHold) * 100);
    const durationCls = daysLeft <= 0 ? 'pf-dur-red' : daysLeft === 1 ? 'pf-dur-orange' : 'pf-dur-blue';

    // Single source of AI probability reads: the modal's "Should I Hold or
    // Sell?" button (loadAIAnalysis -> groqAnalyze) writing to state.aiCache.
    // Only show a line here if the user already ran that this session —
    // no separate prompt, no separate call, so it can never disagree with
    // what the modal shows for the same ticker.
    const cachedAi = state.aiCache[p.ticker];
    const firstAiPair = cachedAi?.pairs?.[0];
    const aiReadHtml = firstAiPair
      ? `<div class="pf-quick-read">${firstAiPair.label}: ${firstAiPair.pct}% likely</div>`
      : '';

    html += `<div class="portfolio-card">
      ${portBanner}
      ${fridayFlag}
      <div class="pf-header">
        <div>
          <div class="pf-ticker">${p.ticker}</div>
          <div class="pf-company">${p.company}</div>
        </div>
        <div class="pf-header-pnl">
          <div class="pf-pnl-dollar ${pnlCls}">${pnlDollar>=0?'+':''}$${pnlDollar.toFixed(2)}</div>
          <div class="pf-pnl-pct ${pnlCls}">${pnlDollar>=0?'▲':'▼'}${Math.abs(pnlPct).toFixed(1)}%</div>
        </div>
      </div>
      ${pfAHHtml}
      <div class="pf-price-bar ${priceBarCls}">
        <div class="pf-price-cell">
          <div class="pf-price-label">Bought</div>
          <div class="pf-price-val pf-muted">$${p.buyPrice.toFixed(2)}</div>
        </div>
        <div class="pf-price-cell">
          <div class="pf-price-label">Now</div>
          <div class="pf-price-val ${nowCls}">$${currentPrice.toFixed(2)}</div>
        </div>
        <div class="pf-price-divider"></div>
        <div class="pf-price-cell">
          <div class="pf-price-label">Target</div>
          <div class="pf-price-val pf-yellow">$${priceBarTarget.toFixed(2)}</div>
        </div>
        <div class="pf-price-cell">
          <div class="pf-price-label">Stop</div>
          <div class="pf-price-val pf-red">$${p.stop.toFixed(2)}</div>
        </div>
      </div>
      <div class="pf-grid">
        <div class="pf-grid-cell">
          <div class="pf-grid-label">Purchased On</div>
          <div class="pf-grid-val">${purchasedOnDisplay}</div>
        </div>
        <div class="pf-grid-cell">
          <div class="pf-grid-label">Total Investment</div>
          <div class="pf-grid-val">${p.shares} shares | $${cost.toFixed(2)}</div>
        </div>
        <div class="pf-grid-cell">
          <div class="pf-grid-label">Score at Purchase</div>
          <div class="pf-grid-val">${p.scoreAtBuy} <span class="pf-score-label ${scoreBuyCls}">${scoreBuyLabel}</span></div>
        </div>
        <div class="pf-grid-cell">
          <div class="pf-grid-label">Score Now</div>
          <div class="pf-grid-val">${scoreNowDisplay}</div>
        </div>
      </div>
      ${aiReadHtml}
      <div class="pf-duration">
        <div class="pf-duration-row">
          <span>Day ${days+1} of ${durLabel} trade</span>
          <span class="${durationCls}">${daysLeft} days left</span>
        </div>
        <div class="pf-duration-track"><div class="pf-duration-fill ${durationCls}" style="width:${durationPct}%"></div></div>
      </div>
      ${momentumBadge}
      <div class="pf-actions">
        <button class="btn btn-danger" onclick="openMarkSoldModal('${p.id}', ${currentPrice})">Mark as sold</button>
        <button class="btn btn-ghost" onclick="openStockModal('${p.ticker}')">View signal</button>
      </div>
    </div>`;
  });

  const totalPnL    = totalValue - totalCost;
  const totalPnLPct = totalCost > 0 ? (totalPnL / totalCost * 100) : 0;
  const allTimePnL  = state.sold.reduce((sum, s) => sum + s.pnlDollar, 0);

  const sumHtml = `<div class="pf-summary">
    <div class="section-label">Portfolio Summary</div>
    <div class="pf-summary-row"><span>Total Value</span><span class="mono">$${totalValue.toFixed(2)}</span></div>
    <div class="pf-summary-row"><span>Unrealized P&L</span><span class="mono ${totalPnL>=0?'pos':'neg'}">${totalPnL>=0?'+':''}$${totalPnL.toFixed(2)} (${totalPnLPct.toFixed(1)}%)</span></div>
    <div class="pf-summary-row"><span>All-Time Realized P&L</span><span class="mono ${allTimePnL>=0?'pos':'neg'}">${allTimePnL>=0?'+':''}$${allTimePnL.toFixed(2)}</span></div>
  </div>`;

  const listEl = document.getElementById('pf-list');
  const sumEl  = document.getElementById('pf-summary');
  if (listEl) listEl.innerHTML = html;
  if (sumEl)  sumEl.innerHTML  = sumHtml;
}

function buildWeekendBanner() {
  const pt = getPT();
  if (pt.getDay() !== 5 || !isTradingDay(pt)) return '';
  const ptMin = pt.getHours() * 60 + pt.getMinutes();
  if (ptMin < 660) return ''; // before 11:00am PT
  const minsToClose = 780 - ptMin; // market closes at 1:00pm PT (780 min)
  const timeStr = minsToClose > 0
    ? `${(minsToClose / 60).toFixed(1)} hours`
    : 'soon';
  return `<div class="weekend-banner">⚠️ WEEKEND RISK — Market closes in ${timeStr}. Consider taking profits on winning positions before close to avoid weekend exposure.</div>`;
}

function buildFridayFlag(p, currentPrice, pnlPct) {
  const pt = getPT();
  if (pt.getDay() !== 5 || !isTradingDay(pt)) return '';
  const ptMin = pt.getHours() * 60 + pt.getMinutes();
  if (ptMin < 660) return ''; // before 11:00am PT

  if (p.duration === 'DAY') {
    return `<div class="friday-flag friday-urgent">📅 EXIT TODAY — do not hold over weekend</div>`;
  }

  const distToStop = ((currentPrice - p.stop) / currentPrice) * 100;
  if (currentPrice <= p.stop || distToStop <= 3 || pnlPct <= -8) {
    return `<div class="friday-flag friday-urgent">📅 Friday — strongly consider exiting before weekend</div>`;
  }

  if (pnlPct >= 0) {
    return `<div class="friday-flag">📅 Friday — consider taking profits before close</div>`;
  }

  return `<div class="friday-flag">📅 Friday — are you comfortable holding this risk over the weekend?</div>`;
}

// ── 16b. UNIFIED RECOMMENDATION ENGINE ──────────────────────────────
// Per edge2-unified-recommendation-engine.md. Sole recommendation system
// driving the Portfolio banner, Signals tab exit alerts, nav badge, owned-
// stock Groq prompt, and sold trade records — the old getPortfolioTier()/
// calcSellWarning()/buildPortfolioBanner() system it replaced (SELL NOW/
// SELL SOON/HOLD trip wires) ran in parallel behind a beta toggle for
// evaluation and was retired once it was found to be equivalent-or-better.

const MAX_HOLD_DAYS = { DAY: 1, '3-DAY': 4, WEEK: 7 };
const MACRO_TAILWIND_CONDITIONS = ['BROAD_RALLY', 'MOMENTUM_DAY'];
const DURATION_WINDOW_LABEL = { DAY: 'exit-today', '3-DAY': '2-4 day', WEEK: '5-7 day' };

// position: a portfolio position object AUGMENTED by the caller with live
//   `currentPrice` and `rsi` fields (the position itself only persists
//   buy-time snapshots — renderPortfolioTab already computes fresh
//   currentPrice/rsi every render and must attach them before calling,
//   e.g. calcUnifiedRecommendation({...p, currentPrice, rsi}, sig, ctx)).
// currentSignal: the live state.signals entry for this ticker if still in
//   the last scan (full fields: score/signal/rsi/volRatio/macroCondition/
//   category/catalystSetup/maPct), or the reduced state.ownedScores entry
//   (score/label only) if it dropped out, or null/undefined if untracked.
//   Any factor needing a field currentSignal doesn't have is skipped
//   gracefully rather than throwing — see individual checks below.
// macroContext: state.macroContext ({condition, changes, ...}) or null.
//
// Returns { label, composite, factors, topFactors, hardFloor, mixed }.
// factors/topFactors entries are { name, points } — points sign implies
// direction (negative = exit pressure/down-arrow, positive = hold
// pressure/up-arrow). composite is null when hardFloor is true, since the
// hard floor bypasses composite scoring entirely per spec.
function calcUnifiedRecommendation(position, currentSignal, macroContext, snap) {
  const price = position.currentPrice;
  const rsi = position.rsi;

  // ── HARD FLOOR — must be the very first thing evaluated, before any
  // factor scoring, and bypasses the composite entirely.
  if (price <= position.stop) {
    const factor = { name: 'Stop-loss breach', points: null };
    return {
      label: 'SELL NOW — Stop-loss hit',
      composite: null,
      factors: [factor],
      topFactors: [factor],
      hardFloor: true,
    };
  }

  const factors = [];
  const add = (name, points) => factors.push({ name, points });

  const pnlPct = ((price - position.buyPrice) / position.buyPrice) * 100;
  const days = Math.floor((Date.now() - new Date(position.buyDate).getTime()) / 86400000);
  const maxHold = MAX_HOLD_DAYS[position.duration];
  const inProtection = !!position.momentumProtectionActivated;

  // ── Loss % vs trailing-stop — mutually exclusive per spec note: trailing
  // stop factors replace the standard loss % factors while protection is
  // active, never both.
  if (inProtection) {
    const pullbackPct = ((position.peakPrice - price) / position.peakPrice) * 100;
    if (pullbackPct >= 20) {
      add(`Pulled back ${pullbackPct.toFixed(0)}% from peak (trailing stop)`, -50);
    } else if (pullbackPct >= 15) {
      add(`Pulled back ${pullbackPct.toFixed(0)}% from peak (trailing stop)`, -25);
    } else {
      add('Momentum protection active — above trailing stop', 30);
    }
  } else {
    if (pnlPct <= -20) {
      add(`Down ${Math.abs(pnlPct).toFixed(0)}% from purchase`, -60);
    } else if (pnlPct <= -8) {
      add(`Down ${Math.abs(pnlPct).toFixed(0)}% from purchase`, -30);
    }
  }

  // ── Duration
  if (maxHold != null) {
    const overdueDays = days - maxHold;
    if (overdueDays >= 3) {
      add('Severely past intended hold window', -50);
    } else if (overdueDays >= 1) {
      add('Past intended hold window', -25);
    } else {
      add(`Within intended ${DURATION_WINDOW_LABEL[position.duration]} window`, 20);
      if (days < maxHold / 2) add('Early in hold window', 10);
    }
  }

  // ── RSI (current)
  if (rsi != null) {
    if (rsi > 75) add(`RSI overbought at ${rsi.toFixed(0)}`, -25);
    else if (rsi >= 65) add(`RSI elevated at ${rsi.toFixed(0)}`, -10);
    else if (rsi >= 55) add(`RSI in sweet spot at ${rsi.toFixed(0)}`, 20);
    else if (rsi >= 35) add(`RSI neutral-bullish at ${rsi.toFixed(0)}`, 15);
  }

  // ── Current signal score (tier + drift vs score at buy)
  const nowScore = currentSignal?.score;
  if (nowScore != null) {
    if (nowScore > 116) add(`Current score ${nowScore} — support signal`, 50);
    else if (nowScore >= 94) add(`Current score ${nowScore} — support signal`, 30);
    else if (nowScore >= 73) add(`Current score ${nowScore} — support signal`, 15);
    else if (nowScore >= 44) add(`Current score ${nowScore} — weak signal`, -10);
    else add(`Current score ${nowScore} — weak signal`, -25);

    if (position.scoreAtBuy != null) {
      if (nowScore > position.scoreAtBuy) {
        add(`Score improved from ${position.scoreAtBuy} → ${nowScore}`, 20);
      } else if (position.scoreAtBuy - nowScore > 29) {
        add(`Score dropped from ${position.scoreAtBuy} → ${nowScore}`, -15);
      }
    }
  }

  // ── Macro condition — skipped entirely (treated as 0 pts) when the
  // "Disable macro overlay" setting is on, same as scoreStock()'s
  // macroAdjustment gate above.
  const condition = macroContext?.condition;
  if (condition && !state.settings.disableMacroOverlay) {
    if (BROAD_ELEVATED_CONDITIONS.includes(condition)) {
      add(`Macro: ${condition}`, -20);
    } else if (MACRO_TAILWIND_CONDITIONS.includes(condition)) {
      add(`Macro: ${condition}`, 20);
    } else if (currentSignal?.category) {
      const affected = SECTOR_WEAKNESS_THRESHOLD_CATEGORIES[condition];
      if (affected && affected.includes(currentSignal.category)) {
        add(`Macro: ${condition} (sector)`, -15);
      }
    }
  }

  // ── Volume ratio (current)
  const volRatio = currentSignal?.volRatio;
  if (volRatio != null) {
    if (volRatio < 0.5) add(`Volume fading at ${volRatio.toFixed(1)}x`, -10);
    else if (volRatio < 1.0) add(`Quiet accumulation at ${volRatio.toFixed(1)}x`, 10);
    else if (volRatio <= 2.0) add(`Healthy volume ${volRatio.toFixed(1)}x`, 15);
  }

  // ── 20-day MA position (current)
  const maPct = currentSignal?.maPct;
  if (maPct != null) {
    if (maPct < 0) add('Below 20-day MA', -10);
    else if (maPct > 0) add('Above 20-day MA', 15);
  }

  // ── Catalyst setup (current scan flag, not buy-time)
  if (currentSignal?.catalystSetup) add('Catalyst setup active', 20);

  // ── Near target (profitable + within 10% of target either side)
  if (position.target && pnlPct > 0) {
    const distFromTargetPct = Math.abs((price - position.target) / position.target) * 100;
    if (distFromTargetPct <= 10) {
      add(`Near target — ${distFromTargetPct.toFixed(0)}% away`, 15);
    }
  }

  // ── Price tier (current price)
  if (price >= 10 && price <= 20) add('Price tier $10–$20 (best win rate)', 10);

  const composite = factors.reduce((sum, f) => sum + f.points, 0);

  let label, peakRisk = null;
  if (composite < -60) label = 'SELL NOW';
  else if (composite < -30) label = 'SELL SOON';
  else if (composite < 10) label = 'CONSIDER SELLING';
  else if (composite < 30) label = 'HOLD';
  else {
    // Composite is genuinely strong (+30 or above) — check peak risk before
    // committing to HOLD STRONG. peakRiskScore is evaluated independently
    // (never added into composite) and only ever computed in this branch.
    // LOCK IN PROFITS never fires on a losing position even if composite is
    // positive here, per spec.
    peakRisk = calcPeakRiskScore(position, currentSignal, snap);
    label = (pnlPct > 0 && peakRisk.score <= -40) ? 'LOCK IN PROFITS' : 'HOLD STRONG';
  }

  const topFactors = [...factors]
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
    .slice(0, 3);

  return {
    label,
    composite,
    factors,
    topFactors,
    hardFloor: false,
    peakRisk,
    pnlPct,
  };
}

// Peak Risk Detection (URE v2, Change 2) — a separate factor sum from the
// main composite above, evaluated independently and NOT added into it.
// position: expects currentPrice, buyPrice, target, duration, buyDate, rsi,
//   and prevRSI (set by renderPortfolioTab from state.ownedPrevRSI — see
//   Step 2; null/undefined means no prior reading, so that factor is skipped
//   rather than assumed).
// currentSignal: expects maPct, volRatio, consUpDays, bars (same shape as a
//   state.signals entry — the sparse state.ownedScores fallback lacks these,
//   so those factors just don't fire, same defensive pattern already used
//   in calcUnifiedRecommendation above).
// snap: the raw Alpaca snapshot for the ticker (dailyBar.h/.c, prevDailyBar.c)
//   — used directly for the intraday-giveup and today's-direction factors so
//   they don't depend on currentSignal's completeness.
function calcPeakRiskScore(position, currentSignal, snap) {
  const factors = [];
  const add = (name, points) => factors.push({ name, points });

  const price = position.currentPrice;
  const rsi = position.rsi;
  const prevRSI = position.prevRSI;

  // ── RSI turning from high
  if (prevRSI != null && prevRSI > 70 && rsi != null && rsi < prevRSI) {
    add(`RSI declining from peak (${prevRSI.toFixed(0)} → ${rsi.toFixed(0)})`, -30);
  }

  // ── RSI elevated and high
  if (rsi != null && rsi > 75) {
    add(`RSI overbought extreme at ${rsi.toFixed(0)}`, -25);
  }

  // ── Overextension vs 20-day MA (mutually exclusive: severe beats moderate)
  const maPct = currentSignal?.maPct;
  if (maPct != null) {
    if (maPct > 20) add(`${maPct.toFixed(0)}% above 20-day MA — severe overextension`, -25);
    else if (maPct >= 10) add(`${maPct.toFixed(0)}% above 20-day MA — moderate overextension`, -15);
  }

  // ── Hard resistance ceiling — price within 3% below the 52-week high or
  // the recent 10-day swing high. Same window/approximation calcEntryTargetStop
  // uses for target capping (bars: sorted is whatever ~100-125 trading days
  // the screener fetched, not a true 252-day window).
  const bars = currentSignal?.bars;
  if (bars && bars.length && price != null) {
    const high52 = Math.max(...bars.map(b => b.h));
    const last10ExclToday = bars.slice(-11, -1);
    const swingHigh10 = last10ExclToday.length ? Math.max(...last10ExclToday.map(b => b.h)) : null;
    const near = (ceiling) => ceiling != null && price <= ceiling && price >= ceiling * 0.97;
    if (near(high52)) add(`Within 3% of 52-week high ($${high52.toFixed(2)})`, -20);
    else if (near(swingHigh10)) add(`Within 3% of 10-day swing high ($${swingHigh10.toFixed(2)})`, -20);
  }

  // ── Consecutive up days exhaustion
  if ((currentSignal?.consUpDays ?? 0) >= 4) {
    add(`${currentSignal.consUpDays} consecutive up days — exhaustion risk`, -20);
  }

  // ── Intraday gain giveup — today's high more than 3% above current price
  const todayHigh = snap?.dailyBar?.h;
  if (todayHigh != null && price != null && price > 0) {
    const giveupPct = ((todayHigh - price) / price) * 100;
    if (giveupPct > 3) add(`Gave back ${giveupPct.toFixed(0)}% off today's high`, -25);
  }

  // ── Volume declining on an up day
  const prevClose = snap?.prevDailyBar?.c;
  const todayUp = prevClose != null && price != null && price > prevClose;
  if (todayUp && currentSignal?.volRatio != null && currentSignal.volRatio < 0.7) {
    add(`Up today on thin volume (${currentSignal.volRatio.toFixed(1)}x) — distribution signal`, -15);
  }

  // ── Profit exceeds 2x target
  if (position.target != null && position.buyPrice) {
    const targetPct = ((position.target - position.buyPrice) / position.buyPrice) * 100;
    const pnlPct = price != null ? ((price - position.buyPrice) / position.buyPrice) * 100 : null;
    if (targetPct > 0 && pnlPct != null && pnlPct > targetPct * 2) {
      add(`Profit ${pnlPct.toFixed(0)}% exceeds 2× target (${targetPct.toFixed(0)}%)`, -15);
    }
  }

  // ── Well past duration window while still winning
  const maxHold = MAX_HOLD_DAYS[position.duration];
  if (maxHold != null && position.buyDate) {
    const days = Math.floor((Date.now() - new Date(position.buyDate).getTime()) / 86400000);
    const overdueDays = days - maxHold;
    const pnlPct = price != null ? ((price - position.buyPrice) / position.buyPrice) * 100 : null;
    if (overdueDays > 3 && pnlPct != null && pnlPct > 0) {
      add(`${overdueDays} days past intended hold window, still winning`, -20);
    }
  }

  const score = factors.reduce((sum, f) => sum + f.points, 0);
  const topFactors = [...factors]
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
    .slice(0, 3);

  return { score, factors, topFactors };
}

// label -> CSS class per the Step 3 color mapping. Hard-floor label is
// 'SELL NOW — Stop-loss hit', hence the startsWith check.
function getUnifiedBannerClass(label) {
  if (label.startsWith('SELL NOW')) return 'ur-sell-now';
  return {
    'SELL SOON':        'ur-sell-soon',
    'CONSIDER SELLING': 'ur-consider-selling',
    'HOLD':              'ur-hold',
    // HOLD STRONG now spans what used to be HOLD STRONG + HIGH CONVICTION
    // HOLD (Change 1 consolidation) — reuses the more prominent
    // ur-high-conviction treatment rather than the plainer ur-hold-strong.
    'HOLD STRONG':       'ur-high-conviction',
    'LOCK IN PROFITS':   'ur-lock-profits',
  }[label] || 'ur-hold-mixed';
}

// Plain single-line banner (label only) for the unified engine — the Step 4
// wiring point. The full two-line display (top factors, arrows, "conflicted"
// note) from the requirements doc's Step 4 spec is added in the next pass;
// this keeps the toggle usable end-to-end in the meantime.
function unifiedFactorLine(f, cssClass) {
  const arrow = f.points >= 0 ? '↑' : '↓';
  const sign = f.points >= 0 ? '+' : '';
  return `<div class="${cssClass} ${f.points >= 0 ? 'ur-factor-up' : 'ur-factor-down'}">
    <span>${arrow} ${f.name}</span><span class="ur-pts">(${sign}${f.points})</span>
  </div>`;
}

// Line 1: recommendation label. Line 2: top 2-3 factors with arrows + points,
// net composite, and — if the composite is within ±10 — a "conflicted" note.
// Hard floor renders as a plain single-line banner (no factors/net; composite
// is null and there's nothing to break down beyond the stop-loss hit itself).
function buildUnifiedPortfolioBanner(result) {
  const cls = getUnifiedBannerClass(result.label);
  if (result.hardFloor) {
    return `<div class="port-banner ur-banner ${cls}"><strong>${result.label}</strong></div>`;
  }
  if (result.label === 'LOCK IN PROFITS') {
    // Peak-risk factors only — the main composite factors that got the
    // position to +30 are deliberately not shown here (Change 2 spec).
    const pnlSign = result.pnlPct >= 0 ? '+' : '';
    return `<div class="port-banner ur-banner ${cls}">
      <div class="ur-label"><strong>${result.label}</strong></div>
      <div class="ur-factors">
        <div class="ur-factor ur-factor-up"><span>↑ Up ${pnlSign}${result.pnlPct.toFixed(0)}% — strong position</span></div>
        ${result.peakRisk.topFactors.map(f => unifiedFactorLine(f, 'ur-factor')).join('')}
      </div>
      <div class="ur-exit-window">This is the exit window — consider selling now</div>
    </div>`;
  }
  const netSign = result.composite >= 0 ? '+' : '';
  return `<div class="port-banner ur-banner ${cls}">
    <div class="ur-label"><strong>${result.label}</strong></div>
    <div class="ur-factors">
      ${result.topFactors.map(f => unifiedFactorLine(f, 'ur-factor')).join('')}
      <div class="ur-net">Net: ${netSign}${result.composite}</div>
    </div>
  </div>`;
}

// Modal RECOMMENDATION block — shows ALL factors (not just top 2-3), split
// into hold vs sell groups, each sorted by descending magnitude.
function buildUnifiedRecommendationModalBlock(result) {
  const cls = getUnifiedBannerClass(result.label);
  if (result.hardFloor) {
    return `<div class="ur-modal-block">
      <div class="ur-modal-title">UNIFIED RECOMMENDATION</div>
      <div class="ur-modal-headline ${cls}">${result.label}</div>
    </div>`;
  }
  const holdFactors = result.factors.filter(f => f.points > 0).sort((a, b) => b.points - a.points);
  if (result.label === 'LOCK IN PROFITS') {
    // Peak risk factors replace the normal sell-factor list here — the
    // position isn't showing composite-level sell factors (composite is
    // +30 or above), it's showing reversal risk instead (Change 2 spec).
    const peakFactors = [...result.peakRisk.factors].sort((a, b) => a.points - b.points);
    const compositeSign = result.composite >= 0 ? '+' : '';
    return `<div class="ur-modal-block">
      <div class="ur-modal-title">UNIFIED RECOMMENDATION</div>
      <div class="ur-modal-headline ${cls}">${result.label} (composite ${compositeSign}${result.composite}, peak risk ${result.peakRisk.score})</div>
      ${holdFactors.length ? `
        <div class="ur-modal-group-label">Why the stock is still strong:</div>
        ${holdFactors.map(f => unifiedFactorLine(f, 'ur-modal-factor')).join('')}
      ` : ''}
      ${peakFactors.length ? `
        <div class="ur-modal-group-label">Why the exit window is closing:</div>
        ${peakFactors.map(f => unifiedFactorLine(f, 'ur-modal-factor')).join('')}
      ` : ''}
      <div class="ur-modal-recommendation">Recommendation: The position is strong but reversal signals are building. This is the optimal exit zone — selling now preserves gains before momentum fades.</div>
    </div>`;
  }
  const sellFactors = result.factors.filter(f => f.points < 0).sort((a, b) => a.points - b.points);
  return `<div class="ur-modal-block">
    <div class="ur-modal-title">UNIFIED RECOMMENDATION</div>
    <div class="ur-modal-headline ${cls}">${result.label} (${result.composite >= 0 ? '+' : ''}${result.composite} composite)</div>
    ${holdFactors.length ? `
      <div class="ur-modal-group-label">Factors for holding:</div>
      ${holdFactors.map(f => unifiedFactorLine(f, 'ur-modal-factor')).join('')}
    ` : ''}
    ${sellFactors.length ? `
      <div class="ur-modal-group-label">Factors for selling:</div>
      ${sellFactors.map(f => unifiedFactorLine(f, 'ur-modal-factor')).join('')}
    ` : ''}
  </div>`;
}

// ── 17. MARK AS SOLD ──────────────────────────────────────────────

function openMarkSoldModal(posId, currentPrice) {
  const today = new Date().toISOString().split('T')[0];
  showModal(`<div class="modal-handle"></div>
    <div class="modal-header">
      <div class="modal-title">Mark as Sold</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Sale Price per Share</label>
          <input id="sold-price" class="form-input" type="number" step="0.01" value="${currentPrice.toFixed(2)}">
        </div>
        <div class="form-group">
          <label class="form-label">Date Sold</label>
          <input id="sold-date" class="form-input" type="date" value="${today}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Why did you sell?</label>
        <div class="decision-btns">
          <div class="decision-btn selected" id="dec-app" onclick="selectDecision('app')">App Signal</div>
          <div class="decision-btn" id="dec-own" onclick="selectDecision('own')">My Own Call</div>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" style="flex:1" onclick="confirmMarkSold('${posId}', this)">Confirm Sale</button>
    </div>`);

  window._saleDecision = 'app';
}

function selectDecision(dec) {
  window._saleDecision = dec;
  document.getElementById('dec-app').classList.toggle('selected', dec === 'app');
  document.getElementById('dec-own').classList.toggle('selected', dec === 'own');
}

// Best-effort mirror of the sold trade into Supabase. Never blocks or
// throws into the caller — localStorage (state.sold) remains the source
// of truth; this is purely additive persistence for later analysis/export.
async function writeTradeToSupabase(pos, record, saleDate, salePrice, pnlDollar, pnlPct) {
  try {
    const signalLabel = pos.scoreAtBuy >= 116 ? 'STRONG BUY' : pos.scoreAtBuy >= 73 ? 'SOFT BUY' : 'WATCH';
    const { data, error } = await supabaseClient.from('trades').insert([{
      ticker: pos.ticker,
      company: pos.company,
      buy_date: pos.buyDate,
      buy_time: pos.buyTime || null,
      buy_day_of_week: pos.buyDayOfWeek || null,
      buy_session: pos.buySession || null,
      sell_date: saleDate,
      sell_time: record.sellTime,
      sell_day_of_week: record.sellDayOfWeek,
      shares: pos.shares,
      buy_price: pos.buyPrice,
      sell_price: salePrice,
      pnl_dollars: pnlDollar,
      pnl_pct: pnlPct,
      signal_score: pos.scoreAtBuy,
      signal_label: signalLabel,
      rsi_at_buy: pos.rsiAtBuy,
      volume_ratio_at_buy: pos.volRatioAtBuy,
      risk_score: pos.riskAtBuy,
      duration_classification: pos.duration,
      price_tier: record.priceRange,
      macro_condition: pos.macroConditionAtBuy,
      catalyst_setup: !!pos.catalystSetup,
      sub10_adjustment: pos.subTenEntryAdjustment ?? 0,
      groq_at_purchase: pos.groqProbabilityAtBuy || null,
      distance_from_target: record.distanceFromTargetAtSale,
      momentum_protection: !!pos.momentumProtectionActivated,
      source: record.source,
      unified_recommendation_at_sale: record.unifiedRecommendationAtSale,
      unified_composite_at_sale: record.unifiedCompositeAtSale,
      top_exit_factors_at_sale: record.topExitFactorsAtSale,
      top_hold_factors_at_sale: record.topHoldFactorsAtSale,
      lock_in_profits_fired: record.lockInProfitsFired,
      peak_risk_score_at_sale: record.peakRiskScoreAtSale,
      peak_rsi_during_hold: record.peakRsiDuringHold,
      top_peak_risk_factors_at_sale: record.topPeakRiskFactorsAtSale,
      price_momentum_pts: pos.priceMomentumPts,
      vol_spike_pts: pos.volSpikePts,
      rsi_pts: pos.rsiPts,
      ma_pts: pos.maPts,
      vol_build_pts: pos.volBuildPts,
      mean_reversion_pts: pos.meanReversionPts,
      cons_up_days: pos.consUpDays,
      cons_up_pts: pos.consUpPts,
      rel_strength_pts: pos.relStrengthPts,
      macro_adjustment_pts: pos.macroAdjustmentPts,
      ma_pct_at_buy: pos.maPctAtBuy,
      raw_score_at_buy: pos.rawScoreAtBuy,
      full_ure_factors_at_sale: record.fullUreFactorsAtSale,
      full_peak_risk_factors_at_sale: record.fullPeakRiskFactorsAtSale,
    }]).select('id');
    if (error) { console.error('Supabase trade write failed:', error.message); return; }
    // record is the same object reference already sitting in state.sold —
    // capturing the Supabase row id here lets Sell Timing Analysis (Lazy
    // Resolution project) later UPDATE this exact row instead of matching
    // on ticker+dates. persist('sold') re-runs here since confirmMarkSold's
    // own persist('sold') already fired before this async write completed.
    if (data && data[0]) {
      record.supabaseId = data[0].id;
      persist('sold');
    }
  } catch(e) {
    console.error('Supabase trade write failed:', e.message);
  }
}

// Unified recommendation snapshot for a trade record at time of sale. Uses
// pos.rsiAtBuy rather than any live RSI since a sale is a point-in-time
// event with no "current" bar fetch of its own at this point in the flow.
function computeUnifiedSaleFields(pos, salePrice) {
  const currentSignal = state.signals.find(s => s.ticker === pos.ticker) || state.ownedScores[pos.ticker] || null;
  const ur = calcUnifiedRecommendation({ ...pos, currentPrice: salePrice, rsi: pos.rsiAtBuy }, currentSignal, state.macroContext);
  // Independent of composite/hardFloor — tracked across the whole hold by
  // renderPortfolioTab (Change 2), falls back to rsiAtBuy if this ticker was
  // sold without ever being rendered in the Portfolio tab.
  const peakRsiDuringHold = state.ownedPeakRSI[pos.ticker] ?? pos.rsiAtBuy ?? null;
  if (ur.hardFloor) {
    return {
      unifiedRecommendationAtSale: ur.label,
      unifiedCompositeAtSale: null,
      topExitFactorsAtSale: ['Stop-loss breach'],
      topHoldFactorsAtSale: [],
      lockInProfitsFired: false,
      peakRiskScoreAtSale: null,
      topPeakRiskFactorsAtSale: [],
      peakRsiDuringHold,
      fullUreFactorsAtSale: ur.factors,
      fullPeakRiskFactorsAtSale: null,
    };
  }
  return {
    unifiedRecommendationAtSale: ur.label,
    unifiedCompositeAtSale: ur.composite,
    topExitFactorsAtSale: ur.factors.filter(f => f.points < 0).sort((a, b) => a.points - b.points).slice(0, 2).map(f => f.name),
    topHoldFactorsAtSale: ur.factors.filter(f => f.points > 0).sort((a, b) => b.points - a.points).slice(0, 2).map(f => f.name),
    lockInProfitsFired: ur.label === 'LOCK IN PROFITS',
    peakRiskScoreAtSale: ur.peakRisk ? ur.peakRisk.score : null,
    topPeakRiskFactorsAtSale: ur.peakRisk ? ur.peakRisk.topFactors.map(f => f.name) : [],
    peakRsiDuringHold,
    fullUreFactorsAtSale: ur.factors,
    fullPeakRiskFactorsAtSale: ur.peakRisk ? ur.peakRisk.factors : null,
  };
}

async function confirmMarkSold(posId, btn) {
  const salePrice = parseFloat(document.getElementById('sold-price').value);
  const saleDate  = document.getElementById('sold-date').value;
  if (!salePrice || isNaN(salePrice)) { alert('Enter sale price.'); return; }

  const pos = state.portfolio.find(p => p.id === posId);
  if (!pos) { closeModal(); return; }

  // Supabase is now the source of truth for portfolio — await the delete
  // and only remove the position locally (move it to Sold) on success. A
  // silent failure here would leave the position "sold" locally but still
  // open in Supabase, which the next reload would resurrect as an open
  // position while it's also sitting in Sold history.
  if (btn) btn.disabled = true;
  state.deletedPositionIds.add(pos.id);
  try {
    await deletePositionFromSupabase(pos.id);
  } catch(e) {
    alert('Could not remove position from Supabase: ' + e.message);
    if (btn) btn.disabled = false;
    return;
  }

  const days = Math.floor((new Date(saleDate) - new Date(pos.buyDate)) / 86400000);
  const pnlDollar = (salePrice - pos.buyPrice) * pos.shares;
  const pnlPct    = ((salePrice - pos.buyPrice) / pos.buyPrice) * 100;
  const targetDriftPct = (pos.liveTarget != null && pos.target)
    ? ((pos.liveTarget - pos.target) / pos.target) * 100
    : null;
  // Rule 5: did the position actually exit via the trailing stop threshold?
  const trailingStopTriggered = !!pos.momentumProtectionActivated && salePrice <= pos.peakPrice * 0.85;
  const unifiedSaleFields = computeUnifiedSaleFields(pos, salePrice);

  const record = {
    id: Date.now().toString(),
    ticker: pos.ticker,
    company: pos.company,
    shares: pos.shares,
    buyPrice: pos.buyPrice,
    sellPrice: salePrice,
    buyDate: pos.buyDate,
    sellDate: saleDate,
    daysHeld: days,
    pnlDollar, pnlPct,
    source: window._saleDecision === 'app' ? 'App Signal' : 'Own Decision',
    scoreAtBuy: pos.scoreAtBuy,
    rsiAtBuy: pos.rsiAtBuy,
    volRatioAtBuy: pos.volRatioAtBuy,
    riskAtBuy: pos.riskAtBuy,
    newsAtBuy: pos.newsAtBuy,
    signalsFiredAtBuy: pos.signalsFiredAtBuy || [],
    volBuildNearMiss:      pos.volBuildNearMiss      || null,
    meanReversionNearMiss: pos.meanReversionNearMiss || null,
    cappedByAtBuy: pos.cappedByAtBuy || null,
    rawAtrAtBuy:     pos.rawAtrAtBuy     ?? null,
    trimmedAtrAtBuy: pos.trimmedAtrAtBuy ?? null,
    macroConditionAtBuy: pos.macroConditionAtBuy || null,
    thresholdAtBuy: pos.thresholdAtBuy ?? BASE_SCORE_THRESHOLD,
    catalystSetup: pos.catalystSetup || false,
    duration: pos.duration,
    priceRange: salePrice <= 3 ? '$1–$3' : salePrice <= 9 ? '$4–$9' : '$10–$20',
    // Retired along with calcSellWarning() — historical trades keep their
    // old SELL_NOW/SELL_SOON/HOLDING value; new trades use the
    // unifiedRecommendationAtSale fields below instead.
    sellWarningAtSale: null,
    targetDriftPct,
    peakPrice: pos.peakPrice,
    peakPriceDate: pos.peakPriceDate || null,
    momentumProtectionActivated: !!pos.momentumProtectionActivated,
    trailingStopTriggered,
    rsiSuspendedAtGainPct: pos.rsiSuspendedAtGainPct ?? null,
    sellTime: (() => {
      const pt = getPT();
      return `${String(pt.getHours()).padStart(2,'0')}:${String(pt.getMinutes()).padStart(2,'0')}`;
    })(),
    sellDayOfWeek: DAY_NAMES[getPT().getDay()],
    distanceFromTargetAtSale: pos.target
      ? Math.round(((pos.target - salePrice) / pos.target) * 1000) / 10
      : null,
    ...unifiedSaleFields,
  };

  state.sold.unshift(record);
  state.portfolio = state.portfolio.filter(p => p.id !== posId);
  persist('sold');
  // Clear this ticker's RSI-hold tracking now that it's sold, so a future
  // re-buy of the same ticker starts a fresh hold rather than inheriting
  // stale prev/peak RSI from this position — unless another open position
  // on the same ticker still exists.
  if (!state.portfolio.some(p => p.ticker === pos.ticker)) {
    delete state.ownedPrevRSI[pos.ticker];
    delete state.ownedPeakRSI[pos.ticker];
    persist('ownedPrevRSI');
    persist('ownedPeakRSI');
  }
  writeTradeToSupabase(pos, record, saleDate, salePrice, pnlDollar, pnlPct);
  closeModal();
  updateNavBadges();
  renderPortfolioTab();
}

// ── 18. SOLD TAB ──────────────────────────────────────────────────

// Sold-trade card display for Sell Timing Analysis — replaces the old
// live "what if held" comparison (removed along with its fetchSnapshots
// call above) per the Lazy Resolution project. No fetch of its own: State
// A trades show a static "resolves in N trading days" message computed
// from sellDate alone (per your call not to live-fetch for still-open
// trades), State B trades read the already-resolved/persisted fields
// straight off the trade record.
function buildSellTimingHtml(s) {
  if (!s.sellDate) return '';

  if (s.sellTimingResolved) {
    if (s.bestExitPrice == null || s.bestExitTiming == null) {
      return `<div class="sell-timing pending">Sell timing data unavailable</div>`;
    }
    const gapPct = ((s.bestExitPrice - s.sellPrice) / s.sellPrice) * 100;
    const daysDiff = Math.abs(Math.round((new Date(s.bestExitDate) - new Date(s.sellDate)) / 86400000));

    let timingLine;
    if (s.bestExitTiming === 'ON') {
      timingLine = `<span class="good">Sold at peak — perfect timing ✓</span>`;
    } else if (s.bestExitTiming === 'BEFORE') {
      timingLine = `Best exit was $${s.bestExitPrice.toFixed(2)} on ${s.bestExitDate} (${daysDiff}d before sale) — <span class="bad">missed +${gapPct.toFixed(1)}%</span>`;
    } else {
      timingLine = `Best exit was $${s.bestExitPrice.toFixed(2)} on ${s.bestExitDate} (${daysDiff}d after sale) — <span class="bad">could have gained +${gapPct.toFixed(1)}%</span>`;
    }

    let plus5Line = '';
    if (s.priceAt5Days != null) {
      const plus5Pct = ((s.priceAt5Days - s.sellPrice) / s.sellPrice) * 100;
      const higher = plus5Pct > 0;
      plus5Line = `<div class="mt4">+5 trading days: $${s.priceAt5Days.toFixed(2)} →
        <span class="${higher?'bad':'good'}">
          ${higher ? `Should have held longer (+${plus5Pct.toFixed(1)}%)` : `Selling was right ✓ (${plus5Pct.toFixed(1)}%)`}
        </span>
      </div>`;
    }

    return `<div class="sell-timing">${timingLine}${plus5Line}</div>`;
  }

  const today = new Date().toISOString().split('T')[0];
  const resolveDate = addTradingDays(s.sellDate, 5);
  if (today >= resolveDate) {
    return `<div class="sell-timing pending">Resolving sell timing…</div>`;
  }
  const remaining = countTradingDaysBetween(today, resolveDate);
  return `<div class="sell-timing pending">Sell timing resolves in ${remaining} trading day${remaining===1?'':'s'}</div>`;
}

async function renderSoldTab() {
  const container = document.getElementById('tab-content');

  if (!state.sold.length) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-icon">✅</div>
      <p>No completed trades yet. Your sold positions will appear here with performance analysis.</p>
    </div>`;
    return;
  }

  // Sell Timing Analysis lazy resolution — not awaited, so the tab renders
  // immediately with whatever's already resolved; re-renders itself once
  // any pending trades finish (fetch+compute+Supabase write all happen
  // inside resolveSellTimingForSoldTrades). A no-op call when nothing needs
  // resolving (the common case), so this doesn't fetch on every tab open.
  resolveSellTimingForSoldTrades().then(anyResolved => {
    if (anyResolved) renderSoldTab();
  });

  const wins = state.sold.filter(s => s.pnlPct > 0);
  const losses = state.sold.filter(s => s.pnlPct <= 0);
  const winRate = state.sold.length ? (wins.length / state.sold.length * 100).toFixed(0) : 0;
  const totalPnL = state.sold.reduce((sum, s) => sum + s.pnlDollar, 0);

  container.innerHTML = `
    <button id="report-btn" class="report-btn" onclick="generateClaudeReport()">📋 Generate Claude Report</button>

    <div class="sold-summary">
      <div class="section-label" style="padding:0 0 8px 0">Trade Summary</div>
      <div class="sold-summary-grid">
        <div class="summary-cell">
          <div class="summary-cell-val">${state.sold.length}</div>
          <div class="summary-cell-label">Trades</div>
        </div>
        <div class="summary-cell">
          <div class="summary-cell-val">${winRate}%</div>
          <div class="summary-cell-label">Win Rate</div>
        </div>
        <div class="summary-cell">
          <div class="summary-cell-val ${totalPnL>=0?'pos':'neg'}">${totalPnL>=0?'+':''}$${totalPnL.toFixed(0)}</div>
          <div class="summary-cell-label">Total P&L</div>
        </div>
        <div class="summary-cell">
          <div class="summary-cell-val">${wins.length}W / ${losses.length}L</div>
          <div class="summary-cell-label">Record</div>
        </div>
      </div>
    </div>

    <div id="sold-list"><div class="empty-state"><span class="spinner"></span></div></div>
  `;

  let html = '';
  state.sold.forEach(s => {
    const pnlCls = s.pnlDollar >= 0 ? 'profit' : 'loss';

    html += `<div class="sold-card ${pnlCls}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="display:flex;align-items:center;gap:6px">
            <span class="ticker-sym">${s.ticker}</span>
            <span style="font-size:11px;color:var(--muted)">${s.source}</span>
          </div>
          <div class="company-name mt4">${s.company}</div>
          <div class="pf-meta">${s.shares} sh · Buy $${s.buyPrice.toFixed(2)} → Sell $${s.sellPrice.toFixed(2)}</div>
          <div class="pf-meta">${s.buyDate} → ${s.sellDate} (${s.daysHeld}d)</div>
        </div>
        <div class="sold-pnl ${s.pnlDollar>=0?'pos':'neg'}">
          ${s.pnlDollar>=0?'+':''}$${s.pnlDollar.toFixed(2)}<br>
          <span style="font-size:13px">${s.pnlPct>=0?'▲':'▼'}${Math.abs(s.pnlPct).toFixed(1)}%</span>
        </div>
      </div>
      <div class="card-sub mt4">
        Score ${s.scoreAtBuy}/100 · RSI ${s.rsiAtBuy?.toFixed(0)} · ${s.duration} · ${s.sellWarningAtSale?.replace('_',' ')||'HOLDING'} at sale
      </div>
      ${buildSellTimingHtml(s)}
    </div>`;
  });

  const listEl = document.getElementById('sold-list');
  if (listEl) listEl.innerHTML = html;
}

// Rating snapshots have no localStorage equivalent at all — genuinely
// Supabase-only, unlike the trade fields above. Failure or an empty table
// both fall through to the same "no snapshot history" message; there's
// nothing to fall back to.
async function buildRatingSnapshotHistorySection(sold) {
  const noDataMsg = `=== RATING SNAPSHOT HISTORY ===

No snapshot history yet — snapshots are recorded after each screener run for stocks scoring 60+`;

  let data;
  try {
    const res = await withTimeout(
      supabaseClient.from('rating_snapshots').select('ticker, captured_at, score').order('captured_at', { ascending: true }),
      10000,
      'Supabase rating_snapshots query timed out after 10s'
    );
    if (res.error) throw res.error;
    data = res.data;
  } catch(e) {
    console.error('Rating snapshot history fetch failed:', e.message);
    return noDataMsg;
  }
  if (!data || !data.length) return noDataMsg;

  const total = data.length;
  const earliest = data[0].captured_at.split('T')[0];
  const latest = data[data.length - 1].captured_at.split('T')[0];

  const byTicker = {};
  data.forEach(row => {
    (byTicker[row.ticker] ??= []).push(row);
  });

  const topTickers = Object.entries(byTicker)
    .map(([ticker, rows]) => {
      const scores = rows.map(r => r.score).filter(s => s != null);
      const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      return {
        ticker, count: rows.length, avgScore,
        minScore: scores.length ? Math.min(...scores) : 0,
        maxScore: scores.length ? Math.max(...scores) : 0,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  const topTickersText = topTickers
    .map(t => `  ${t.ticker}: ${t.count} snapshots | avg score ${t.avgScore.toFixed(1)} | score range ${t.minScore}–${t.maxScore}`)
    .join('\n');

  // Cross-reference: tickers that show up in both snapshot history and this
  // report's trades. For a ticker traded more than once, each purchase gets
  // its own 7-day-before/7-day-after window, and those per-purchase averages
  // are themselves averaged into one before/after figure for the ticker.
  const tradeTickers = [...new Set(sold.map(s => s.ticker))];
  const overlapTickers = tradeTickers.filter(t => byTicker[t]);

  let correlationText;
  if (!overlapTickers.length) {
    correlationText = '  No tickers currently overlap between snapshot history and trade history.';
  } else {
    const lines = overlapTickers.map(ticker => {
      const trades = sold.filter(s => s.ticker === ticker && s.buyDate);
      const beforeAvgs = [], afterAvgs = [];
      trades.forEach(trade => {
        const buyDate = new Date(trade.buyDate);
        const windowStart = new Date(buyDate.getTime() - 7 * 86400000);
        const windowEnd = new Date(buyDate.getTime() + 7 * 86400000);
        const before = byTicker[ticker].filter(r => { const d = new Date(r.captured_at); return d >= windowStart && d < buyDate; }).map(r => r.score).filter(s => s != null);
        const after = byTicker[ticker].filter(r => { const d = new Date(r.captured_at); return d > buyDate && d <= windowEnd; }).map(r => r.score).filter(s => s != null);
        if (before.length) beforeAvgs.push(before.reduce((a, b) => a + b, 0) / before.length);
        if (after.length) afterAvgs.push(after.reduce((a, b) => a + b, 0) / after.length);
      });
      if (!beforeAvgs.length && !afterAvgs.length) return null;
      const avgBefore = beforeAvgs.length ? beforeAvgs.reduce((a, b) => a + b, 0) / beforeAvgs.length : null;
      const avgAfter = afterAvgs.length ? afterAvgs.reduce((a, b) => a + b, 0) / afterAvgs.length : null;
      const trend = (avgBefore == null || avgAfter == null) ? 'insufficient data'
        : avgAfter > avgBefore ? 'improving'
        : avgAfter < avgBefore ? 'declining'
        : 'stable';
      return `  ${ticker}:
    Avg score in 7 days before purchase: ${avgBefore != null ? avgBefore.toFixed(1) : 'N/A'}
    Avg score in 7 days after purchase:  ${avgAfter != null ? avgAfter.toFixed(1) : 'N/A'}
    Score trend: ${trend}`;
    }).filter(Boolean);
    correlationText = lines.length ? lines.join('\n\n') : '  No snapshots fall within a 7-day window around any purchase.';
  }

  return `=== RATING SNAPSHOT HISTORY ===

Total snapshots recorded: ${total}
Date range: ${earliest} to ${latest}
Most frequently appearing tickers (top 10):
${topTickersText}

Tickers appearing in both snapshots and trades:
${correlationText}`;
}

// ── PORTFOLIO / SETTINGS SUPABASE MIGRATION ────────────────────────
// Read/write functions for the `portfolio` and `settings` tables (Data
// Migration project). Not wired into the app yet — loadState()/persist()
// still own portfolio and settings until the later wiring step.
//
// Unlike writeTradeToSupabase()/writeRatingSnapshots() above, which swallow
// errors internally (console.error + return, since a failed historical-data
// write shouldn't block the UI action that triggered it), these THROW on
// error instead. That's deliberate: the migration button and app-init read
// path both need to catch a real failure and show it explicitly rather than
// silently continuing — swallowing the error here would defeat the point.

// position.id (client Date.now().toString()) <-> portfolio.position_id.
// buy_date/peak_price_date come back from Postgres as full timestamptz
// strings; sliced to plain yyyy-mm-dd since that's the format the rest of
// the app assumes (e.g. the p.buyDate.split('-') display code).
function mapSupabasePortfolioRowToPosition(row) {
  return {
    id: row.position_id,
    ticker: row.ticker,
    company: row.company,
    shares: row.shares,
    buyPrice: row.buy_price,
    buyDate: row.buy_date ? row.buy_date.split('T')[0] : row.buy_date,
    target: row.target,
    stop: row.stop,
    duration: row.duration,
    scoreAtBuy: row.score_at_buy,
    rsiAtBuy: row.rsi_at_buy,
    volRatioAtBuy: row.vol_ratio_at_buy,
    riskAtBuy: row.risk_at_buy,
    newsAtBuy: row.news_at_buy,
    signalsFiredAtBuy: row.signals_fired_at_buy || [],
    volBuildNearMiss: row.vol_build_near_miss,
    meanReversionNearMiss: row.mean_reversion_near_miss,
    cappedByAtBuy: row.capped_by_at_buy,
    rawAtrAtBuy: row.raw_atr_at_buy,
    trimmedAtrAtBuy: row.trimmed_atr_at_buy,
    macroConditionAtBuy: row.macro_condition_at_buy,
    thresholdAtBuy: row.threshold_at_buy,
    catalystSetup: !!row.catalyst_setup,
    peakPrice: row.peak_price,
    peakPriceDate: row.peak_price_date ? row.peak_price_date.split('T')[0] : row.peak_price_date,
    momentumProtectionActivated: !!row.momentum_protection_activated,
    rsiSuspendedAtGainPct: row.rsi_suspended_at_gain_pct,
    buyTime: row.buy_time,
    buyDayOfWeek: row.buy_day_of_week,
    buySession: row.buy_session,
    subTenEntryAdjustment: row.sub_ten_entry_adjustment,
    groqProbabilityAtBuy: row.groq_probability_at_buy,
    priceMomentumPts: row.price_momentum_pts,
    volSpikePts: row.vol_spike_pts,
    rsiPts: row.rsi_pts,
    maPts: row.ma_pts,
    volBuildPts: row.vol_build_pts,
    meanReversionPts: row.mean_reversion_pts,
    consUpDays: row.cons_up_days,
    consUpPts: row.cons_up_pts,
    relStrengthPts: row.rel_strength_pts,
    macroAdjustmentPts: row.macro_adjustment_pts,
    maPctAtBuy: row.ma_pct_at_buy,
    rawScoreAtBuy: row.raw_score_at_buy,
  };
}

function mapPositionToSupabaseRow(position) {
  return {
    position_id: position.id,
    ticker: position.ticker,
    company: position.company,
    shares: position.shares,
    buy_price: position.buyPrice,
    buy_date: position.buyDate,
    target: position.target,
    stop: position.stop,
    duration: position.duration,
    score_at_buy: position.scoreAtBuy,
    rsi_at_buy: position.rsiAtBuy,
    vol_ratio_at_buy: position.volRatioAtBuy,
    risk_at_buy: position.riskAtBuy,
    news_at_buy: position.newsAtBuy,
    signals_fired_at_buy: position.signalsFiredAtBuy || [],
    vol_build_near_miss: position.volBuildNearMiss,
    mean_reversion_near_miss: position.meanReversionNearMiss,
    capped_by_at_buy: position.cappedByAtBuy,
    raw_atr_at_buy: position.rawAtrAtBuy,
    trimmed_atr_at_buy: position.trimmedAtrAtBuy,
    macro_condition_at_buy: position.macroConditionAtBuy,
    threshold_at_buy: position.thresholdAtBuy,
    catalyst_setup: !!position.catalystSetup,
    peak_price: position.peakPrice,
    peak_price_date: position.peakPriceDate,
    momentum_protection_activated: !!position.momentumProtectionActivated,
    rsi_suspended_at_gain_pct: position.rsiSuspendedAtGainPct,
    buy_time: position.buyTime,
    buy_day_of_week: position.buyDayOfWeek,
    buy_session: position.buySession,
    sub_ten_entry_adjustment: position.subTenEntryAdjustment,
    groq_probability_at_buy: position.groqProbabilityAtBuy,
    price_momentum_pts: position.priceMomentumPts,
    vol_spike_pts: position.volSpikePts,
    rsi_pts: position.rsiPts,
    ma_pts: position.maPts,
    vol_build_pts: position.volBuildPts,
    mean_reversion_pts: position.meanReversionPts,
    cons_up_days: position.consUpDays,
    cons_up_pts: position.consUpPts,
    rel_strength_pts: position.relStrengthPts,
    macro_adjustment_pts: position.macroAdjustmentPts,
    ma_pct_at_buy: position.maPctAtBuy,
    raw_score_at_buy: position.rawScoreAtBuy,
    updated_at: new Date().toISOString(),
  };
}

async function loadPortfolioFromSupabase() {
  const { data, error } = await supabaseClient.from('portfolio').select('*').order('buy_date', { ascending: true });
  if (error) throw error;
  return (data || []).map(mapSupabasePortfolioRowToPosition);
}

async function savePortfolioToSupabase(portfolio) {
  if (!portfolio.length) return;
  const rows = portfolio.map(mapPositionToSupabaseRow);
  const { error } = await supabaseClient.from('portfolio').upsert(rows, { onConflict: 'position_id' });
  if (error) throw error;
}

async function savePositionToSupabase(position) {
  const row = mapPositionToSupabaseRow(position);
  const { error } = await supabaseClient.from('portfolio').upsert([row], { onConflict: 'position_id' });
  if (error) throw error;
}

async function deletePositionFromSupabase(positionId) {
  const { error } = await supabaseClient.from('portfolio').delete().eq('position_id', positionId);
  if (error) throw error;
}

// settings has no natural unique key (single-row table, no auth/RLS scoping
// per the migration's explicit scope) — read-then-write against whatever row
// currently has the highest id, insert a fresh row only if none exists yet.
// API keys/PIN are intentionally absent from both directions; the caller is
// responsible for merging those back in from localStorage.
async function loadSettingsFromSupabase() {
  const { data, error } = await supabaseClient
    .from('settings').select('*').order('id', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    budget: data.budget,
    includeUnder2: !!data.include_under2,
    showWatch: !!data.show_watch,
    minVolume: data.min_volume,
    forcePreMarketMode: !!data.force_pre_market_mode,
    disableMacroOverlay: !!data.disable_macro_overlay,
  };
}

async function saveSettingsToSupabase(settings) {
  const row = {
    budget: settings.budget,
    include_under2: !!settings.includeUnder2,
    show_watch: !!settings.showWatch,
    min_volume: settings.minVolume,
    force_pre_market_mode: !!settings.forcePreMarketMode,
    disable_macro_overlay: !!settings.disableMacroOverlay,
    updated_at: new Date().toISOString(),
  };
  const { data: existing, error: selectError } = await supabaseClient
    .from('settings').select('id').order('id', { ascending: false }).limit(1).maybeSingle();
  if (selectError) throw selectError;
  if (existing) {
    const { error } = await supabaseClient.from('settings').update(row).eq('id', existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabaseClient.from('settings').insert([row]);
    if (error) throw error;
  }
}

// Normalizes a Supabase trades row (snake_case, ~30 columns) into the same
// shape as a state.sold record (camelCase, ~40 fields) so the rest of
// generateClaudeReport() below can run unmodified against either source.
// Fields with no Supabase column (near-miss data, ATR, peak price, trailing
// stop, RSI-suspended gain, news, signals-fired list, the retired sell-
// warning enum) come back null/[] — every section already treats those as
// "no data for this trade" rather than crashing, the same way it already
// handles pre-update localStorage trades that predate a given field.
function mapSupabaseTradeToSoldShape(row) {
  const daysHeld = (row.buy_date && row.sell_date)
    ? Math.floor((new Date(row.sell_date) - new Date(row.buy_date)) / 86400000)
    : null;
  return {
    id: String(row.id),
    ticker: row.ticker,
    company: row.company || row.ticker,
    shares: row.shares,
    buyPrice: row.buy_price,
    sellPrice: row.sell_price,
    buyDate: row.buy_date,
    sellDate: row.sell_date,
    daysHeld,
    pnlDollar: row.pnl_dollars,
    pnlPct: row.pnl_pct,
    source: row.source,
    scoreAtBuy: row.signal_score,
    rsiAtBuy: row.rsi_at_buy,
    volRatioAtBuy: row.volume_ratio_at_buy,
    riskAtBuy: row.risk_score,
    newsAtBuy: null,
    signalsFiredAtBuy: [],
    volBuildNearMiss: null,
    meanReversionNearMiss: null,
    cappedByAtBuy: null,
    rawAtrAtBuy: null,
    trimmedAtrAtBuy: null,
    macroConditionAtBuy: row.macro_condition,
    thresholdAtBuy: null,
    catalystSetup: !!row.catalyst_setup,
    duration: row.duration_classification,
    priceRange: row.price_tier,
    sellWarningAtSale: null,
    targetDriftPct: null,
    peakPrice: null,
    peakPriceDate: null,
    momentumProtectionActivated: !!row.momentum_protection,
    trailingStopTriggered: false,
    rsiSuspendedAtGainPct: null,
    sellTime: row.sell_time,
    sellDayOfWeek: row.sell_day_of_week,
    distanceFromTargetAtSale: row.distance_from_target,
    unifiedRecommendationAtSale: row.unified_recommendation_at_sale,
    unifiedCompositeAtSale: row.unified_composite_at_sale,
    topExitFactorsAtSale: row.top_exit_factors_at_sale || [],
    topHoldFactorsAtSale: row.top_hold_factors_at_sale || [],
    buyTime: row.buy_time,
    buyDayOfWeek: row.buy_day_of_week,
    buySession: row.buy_session,
    subTenEntryAdjustment: row.sub10_adjustment,
    groqProbabilityAtBuy: row.groq_at_purchase,
    lockInProfitsFired: !!row.lock_in_profits_fired,
    peakRiskScoreAtSale: row.peak_risk_score_at_sale,
    peakRsiDuringHold: row.peak_rsi_during_hold,
    topPeakRiskFactorsAtSale: row.top_peak_risk_factors_at_sale || [],
    sellTimingResolved: !!row.sell_timing_resolved,
    bestExitPrice: row.best_exit_price,
    bestExitDate: row.best_exit_date,
    bestExitTiming: row.best_exit_timing,
    priceAt5Days: row.price_at_plus5_days,
    priceMomentumPts: row.price_momentum_pts,
    volSpikePts: row.vol_spike_pts,
    rsiPts: row.rsi_pts,
    maPts: row.ma_pts,
    volBuildPts: row.vol_build_pts,
    meanReversionPts: row.mean_reversion_pts,
    consUpDays: row.cons_up_days,
    consUpPts: row.cons_up_pts,
    relStrengthPts: row.rel_strength_pts,
    macroAdjustmentPts: row.macro_adjustment_pts,
    maPctAtBuy: row.ma_pct_at_buy,
    rawScoreAtBuy: row.raw_score_at_buy,
    fullUreFactorsAtSale: row.full_ure_factors_at_sale || [],
    fullPeakRiskFactorsAtSale: row.full_peak_risk_factors_at_sale || null,
  };
}

// Races a promise against a timeout so a hung Supabase query can never hang
// report generation — used for both the trades query and the rating
// snapshot query below, each independently.
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

// Winner Exit Timing Analysis (URE v2, Change 5) — evaluates whether LOCK IN
// PROFITS exits, HOLD STRONG holds, and peak-RSI-during-hold actually lined
// up with good outcomes. Some metrics need peakPrice, which
// mapSupabaseTradeToSoldShape() leaves null (not tracked in Supabase) — those
// specific lines degrade to a labeled '—' rather than showing wrong numbers
// when the report is Supabase-sourced (the default path).
async function buildWinnerExitTimingSection(sold) {
  const avg = (arr, fn) => arr.length ? (arr.reduce((s,x) => s + fn(x), 0) / arr.length) : 0;

  const lockInTrades = sold.filter(s => s.lockInProfitsFired);
  const holdStrongTrades = sold.filter(s => s.unifiedRecommendationAtSale === 'HOLD STRONG');
  const peakPriceUnavailable = sold.some(s => s.peakPrice == null);

  const lockInBlock = (() => {
    if (!lockInTrades.length) return `Trades where LOCK IN PROFITS was showing at time of sale:
  No completed trades with LOCK IN PROFITS on record yet.`;
    const wins = lockInTrades.filter(s => s.pnlPct > 0);
    const withPeak = lockInTrades.filter(s => s.peakPrice != null && s.buyPrice);
    const gainPreserved = withPeak.length
      ? `${avg(withPeak, s => {
          const peakGainPct = ((s.peakPrice - s.buyPrice) / s.buyPrice) * 100;
          return peakGainPct > 0 ? (s.pnlPct / peakGainPct) * 100 : 100;
        }).toFixed(1)}%`
      : '— (peakPrice not tracked for this data source)';
    return `Trades where LOCK IN PROFITS was showing at time of sale:
  Total: ${lockInTrades.length} | win rate ${(wins.length/lockInTrades.length*100).toFixed(0)}% | avg outcome ${avg(lockInTrades, s=>s.pnlPct).toFixed(1)}%
  Avg gain preserved at exit: ${gainPreserved}`;
  })();

  const holdStrongBlock = await (async () => {
    if (!holdStrongTrades.length) return `Trades where HOLD STRONG was showing at time of sale:
  No completed trades with HOLD STRONG on record yet.`;
    const wins = holdStrongTrades.filter(s => s.pnlPct > 0);
    // Capped at the 25 most recent trades — this metric needs a live
    // next-day bar fetch per trade (no stored field for it), so the cap
    // bounds report-generation time/API calls regardless of history size.
    const sample = [...holdStrongTrades]
      .filter(s => s.sellDate)
      .sort((a, b) => new Date(b.sellDate) - new Date(a.sellDate))
      .slice(0, 25);
    const whatIfResults = await Promise.all(sample.map(async s => {
      const nextClose = await fetchNextDayClose(s.ticker, s.sellDate);
      return nextClose != null ? ((nextClose - s.sellPrice) / s.sellPrice) * 100 : null;
    }));
    const validWhatIf = whatIfResults.filter(v => v != null);
    const whatIfLine = validWhatIf.length
      ? `${(validWhatIf.reduce((a,b)=>a+b,0)/validWhatIf.length).toFixed(1)}% (${validWhatIf.length} of ${sample.length} most recent trades)`
      : 'not available (no next-day bar data for the sampled trades)';
    return `Trades where HOLD STRONG was showing at time of sale:
  Total: ${holdStrongTrades.length} | win rate ${(wins.length/holdStrongTrades.length*100).toFixed(0)}% | avg outcome ${avg(holdStrongTrades, s=>s.pnlPct).toFixed(1)}%
  What-if: avg outcome if held 1 more day: ${whatIfLine}
  (based on next day's close vs sale price)`;
  })();

  const heldPastBlock = (() => {
    const withPeak = sold.filter(s => s.peakPrice != null && s.buyPrice && (s.peakRsiDuringHold ?? 0) > 70);
    if (!withPeak.length) {
      return `Trades where you held PAST a LOCK IN PROFITS signal:
  (approximated: trades where peak RSI during hold exceeded 70
   but final outcome was lower than peak unrealized gain)
  No qualifying trades on record yet${peakPriceUnavailable ? " (peakPrice isn't tracked for Supabase-sourced trades)" : ''}.`;
    }
    const heldPast = withPeak.filter(s => {
      const peakGainPct = ((s.peakPrice - s.buyPrice) / s.buyPrice) * 100;
      return s.pnlPct < peakGainPct;
    });
    const avgGiven = heldPast.length
      ? avg(heldPast, s => (((s.peakPrice - s.buyPrice) / s.buyPrice) * 100) - s.pnlPct).toFixed(1)
      : '0.0';
    return `Trades where you held PAST a LOCK IN PROFITS signal:
  (approximated: trades where peak RSI during hold exceeded 70
   but final outcome was lower than peak unrealized gain)
  Total: ${heldPast.length} | avg gain given back: ${avgGiven}%`;
  })();

  const rsiBucketBlock = (() => {
    const withRsi = sold.filter(s => s.peakRsiDuringHold != null);
    if (!withRsi.length) {
      return `Peak RSI reached during hold vs final outcome:
  No completed trades with peak RSI tracking on record yet.`;
    }
    const bucket = (label, predicate) => {
      const t = withRsi.filter(predicate);
      return `  ${label.padEnd(28)}${t.length} trades | avg outcome ${t.length ? avg(t, s=>s.pnlPct).toFixed(1) : '—'}%`;
    };
    return `Peak RSI reached during hold vs final outcome:
${bucket('Peak RSI <65 during hold:', s => s.peakRsiDuringHold < 65)}
${bucket('Peak RSI 65-75 during hold:', s => s.peakRsiDuringHold >= 65 && s.peakRsiDuringHold <= 75)}
${bucket('Peak RSI 75+ during hold:', s => s.peakRsiDuringHold > 75)}`;
  })();

  const peakFactorsBlock = (() => {
    if (!lockInTrades.length) {
      return `Most common peak risk factors at time of LOCK IN PROFITS exits:
  No LOCK IN PROFITS exits on record yet.`;
    }
    const counts = {};
    lockInTrades.forEach(s => (s.topPeakRiskFactorsAtSale || []).forEach(name => { counts[name] = (counts[name] || 0) + 1; }));
    const ranked = Object.entries(counts).sort((a,b) => b[1] - a[1]).slice(0, 3);
    if (!ranked.length) {
      return `Most common peak risk factors at time of LOCK IN PROFITS exits:
  No peak risk factor data on record for these exits yet.`;
    }
    return `Most common peak risk factors at time of LOCK IN PROFITS exits:
${ranked.map(([name, n], i) => `  ${i+1}. ${name}: fired in ${n} of ${lockInTrades.length} LOCK IN PROFITS exits`).join('\n')}`;
  })();

  return `=== WINNER EXIT TIMING ANALYSIS ===

${lockInBlock}

${holdStrongBlock}

${heldPastBlock}

${rsiBucketBlock}

${peakFactorsBlock}`;
}

// Sell Timing Analysis (Lazy Resolution project) — only included once at
// least 5 trades have fully resolved (sellTimingResolved with real price
// data), same "not enough data yet" gate the doc specifies. gapPct/plus5Pct
// are derived here from the stored raw prices, same as everywhere else in
// this report — nothing about these percentages is persisted separately.
function buildSellTimingAnalysisSection(sold) {
  const resolved = sold.filter(s => s.sellTimingResolved && s.bestExitPrice != null && s.bestExitTiming != null);
  if (resolved.length < 5) return '';

  const avg = (arr, fn) => arr.length ? (arr.reduce((s,x) => s + fn(x), 0) / arr.length) : 0;
  const gapPct = (s) => ((s.bestExitPrice - s.sellPrice) / s.sellPrice) * 100;
  const plus5Pct = (s) => ((s.priceAt5Days - s.sellPrice) / s.sellPrice) * 100;

  const before = resolved.filter(s => s.bestExitTiming === 'BEFORE');
  const on = resolved.filter(s => s.bestExitTiming === 'ON');
  const after = resolved.filter(s => s.bestExitTiming === 'AFTER');

  const withPlus5 = resolved.filter(s => s.priceAt5Days != null);
  const higher = withPlus5.filter(s => plus5Pct(s) > 0);
  const lower = withPlus5.filter(s => plus5Pct(s) <= 0);

  // Best timed exit: smallest |gap| to the peak — closest to selling right
  // at the top. "% better than average" compares its gap to the average
  // gap across every resolved trade.
  const avgAbsGap = avg(resolved, s => Math.abs(gapPct(s)));
  const best = resolved.reduce((a, b) => Math.abs(gapPct(b)) < Math.abs(gapPct(a)) ? b : a);
  const bestLine = `Best timed exit: ${best.ticker} — sold at peak, ${(avgAbsGap - Math.abs(gapPct(best))).toFixed(1)}% better than average`;

  // Worst timed exit: BEFORE-timing only — "days earlier" only makes sense
  // when the peak actually preceded the sale.
  let worstLine = '';
  if (before.length) {
    const worst = before.reduce((a, b) => gapPct(b) > gapPct(a) ? b : a);
    const daysDiff = Math.abs(Math.round((new Date(worst.bestExitDate) - new Date(worst.sellDate)) / 86400000));
    worstLine = `\nWorst timed exit: ${worst.ticker} — best price was ${gapPct(worst).toFixed(1)}% higher ${daysDiff} days earlier`;
  }

  return `=== SELL TIMING ANALYSIS ===

Trades where best exit was BEFORE sale date:    ${before.length} | avg missed: +${avg(before, gapPct).toFixed(1)}%
Trades where best exit was ON sale date:         ${on.length} | avg: perfect timing
Trades where best exit was AFTER sale date:      ${after.length} | avg extra gain: +${avg(after, gapPct).toFixed(1)}%

At +5 trading days vs actual sale:
  Higher than sale (should have held longer):    ${higher.length} trades | avg ${avg(higher, plus5Pct).toFixed(1)}%
  Lower than sale (selling was right):           ${lower.length} trades | avg ${avg(lower, plus5Pct).toFixed(1)}%

${bestLine}${worstLine}`;
}

// Individual Signal Performance — breaks down win rate by the actual point
// value each scoring component awarded at buy time (Step 5, full-breakdown
// capture project). Gated on volSpikePts as a stand-in for "has buy-time
// breakdown data" since all breakdown fields are captured together in
// confirmAddPortfolio() — presence of one implies presence of all.
function buildIndividualSignalPerformanceSection(sold) {
  const withBreakdown = sold.filter(s => s.volSpikePts != null);
  if (withBreakdown.length < 10) return '';

  const avg = (arr, fn) => arr.length ? (arr.reduce((s,x) => s + fn(x), 0) / arr.length) : 0;
  const bucket = (arr, label) => {
    const w = arr.filter(s => s.pnlPct > 0);
    return `    ${label.padEnd(28)}${arr.length} trades | ${arr.length ? (w.length/arr.length*100).toFixed(0) : '—'}% win rate | avg ${arr.length ? avg(arr, s=>s.pnlPct).toFixed(1) : '—'}%`;
  };
  const byPts = (field, points) => withBreakdown.filter(s => s[field] === points);

  const volSpikeBlock = `  Volume spike points:
${bucket(byPts('volSpikePts', 20),  'Got +20 (1-2x vol):')}
${bucket(byPts('volSpikePts', 15),  'Got +15 (0.5-1x vol):')}
${bucket(byPts('volSpikePts', 10),  'Got +10 (2-3x vol):')}
${bucket(byPts('volSpikePts', -10), 'Got −10 (3x+ vol):')}`;

  const rsiPtsBlock = `  RSI points:
${bucket(byPts('rsiPts', 20),  'Got +20 (RSI 55-65):')}
${bucket(byPts('rsiPts', 15),  'Got +15 (RSI 35-55):')}
${bucket(byPts('rsiPts', 10),  'Got +10 (RSI <35):')}
${bucket(byPts('rsiPts', 0),   'Got 0 (RSI 65-75):')}
${bucket(byPts('rsiPts', -10), 'Got −10 (RSI 75+):')}`;

  const momentumBlock = `  Price momentum points:
${bucket(byPts('priceMomentumPts', 20), 'Got +20 (up 4%+):')}
${bucket(byPts('priceMomentumPts', 10), 'Got +10 (up 2-4%):')}
${bucket(byPts('priceMomentumPts', 0),  'Got 0 (under 2%):')}`;

  const maBlock = `  Above 20-day MA:
${bucket(byPts('maPts', 10), 'Yes (+10 pts):')}
${bucket(byPts('maPts', 0),  'No (0 pts):')}`;

  const volBuildBlock = `  Volume build fired:
${bucket(byPts('volBuildPts', 15), 'Yes (+15 pts):')}
${bucket(byPts('volBuildPts', 0),  'No (0 pts):')}`;

  const meanReversionBlock = `  Mean reversion fired:
${bucket(byPts('meanReversionPts', 20), 'Yes (+20 pts):')}
${bucket(byPts('meanReversionPts', 0),  'No (0 pts):')}`;

  const relStrengthBlock = `  Relative strength vs SPY:
${bucket(byPts('relStrengthPts', 15), 'Got +15 (outperform 2%+):')}
${bucket(byPts('relStrengthPts', 10), 'Got +10 (outperform 1%+):')}
${bucket(byPts('relStrengthPts', 5),  'Got +5 (outperform >0%):')}
${bucket(byPts('relStrengthPts', 0),  'Got 0 (underperform):')}`;

  const macroAdjBlock = `  Macro adjustment applied:
${bucket(withBreakdown.filter(s => s.macroAdjustmentPts > 0), 'Positive adjustment:')}
${bucket(withBreakdown.filter(s => s.macroAdjustmentPts === 0), 'Zero (CHOPPY):')}
${bucket(withBreakdown.filter(s => s.macroAdjustmentPts < 0), 'Negative adjustment:')}`;

  return `=== INDIVIDUAL SIGNAL PERFORMANCE ===

Win rate by signal component at purchase:
${volSpikeBlock}

${rsiPtsBlock}

${momentumBlock}

${maBlock}

${volBuildBlock}

${meanReversionBlock}

${relStrengthBlock}

${macroAdjBlock}`;
}

// URE Factor Accuracy — cross-references the complete factors array captured
// at sale time (Step 6, full-breakdown capture project) against win/loss
// outcome to see which URE factors actually track with profitable exits.
// Gated on fullUreFactorsAtSale (non-empty) as the "has full URE factor
// data" signal — hard-floor stop-loss sales carry a single-factor array
// ('Stop-loss breach') rather than an empty one, so they're included here
// same as any other sale.
function buildUreFactorAccuracySection(sold) {
  const withFactors = sold.filter(s => s.fullUreFactorsAtSale && s.fullUreFactorsAtSale.length);
  if (withFactors.length < 10) return '';

  const wins = withFactors.filter(s => s.pnlPct > 0);
  const losses = withFactors.filter(s => s.pnlPct <= 0);

  const countFactors = (trades) => {
    const counts = {};
    trades.forEach(s => {
      new Set(s.fullUreFactorsAtSale.map(f => f.name)).forEach(name => {
        counts[name] = (counts[name] || 0) + 1;
      });
    });
    return counts;
  };
  const winCounts = countFactors(wins);
  const lossCounts = countFactors(losses);

  const topFactorLines = (counts, total, label) => {
    const ranked = Object.entries(counts).sort((a,b) => b[1] - a[1]).slice(0, 3);
    return ranked.length
      ? ranked.map(([name, c], i) => `  ${i+1}. ${name}: appeared in ${c} of ${total} ${label} trades`).join('\n')
      : `  No completed ${label} trades with factor data yet.`;
  };

  const separationLines = (() => {
    if (!wins.length || !losses.length) {
      return '  Not enough winning and losing trades with factor data yet.';
    }
    const names = new Set([...Object.keys(winCounts), ...Object.keys(lossCounts)]);
    const rows = [...names].map(name => {
      const winPct = ((winCounts[name] || 0) / wins.length) * 100;
      const lossPct = ((lossCounts[name] || 0) / losses.length) * 100;
      return { name, winPct, lossPct };
    }).filter(r => (r.winPct >= 60 && r.lossPct < 40) || (r.lossPct >= 60 && r.winPct < 40));
    if (!rows.length) return '  No factors met the 60%/40% separation threshold yet.';
    rows.sort((a, b) => Math.abs(b.winPct - b.lossPct) - Math.abs(a.winPct - a.lossPct));
    return rows.map(r => {
      const signal = r.winPct > r.lossPct ? 'bullish signal' : 'bearish signal';
      return `  ${r.name}: wins ${r.winPct.toFixed(0)}% | losses ${r.lossPct.toFixed(0)}% — ${signal}`;
    }).join('\n');
  })();

  return `=== URE FACTOR ACCURACY AT SALE ===

Most common factors in winning trades at sale:
${topFactorLines(winCounts, wins.length, 'winning')}

Most common factors in losing trades at sale:
${topFactorLines(lossCounts, losses.length, 'losing')}

Factors that most strongly separated winners from losers:
(factor appearing in 60%+ of wins but <40% of losses, or vice versa)
${separationLines}`;
}

async function generateClaudeReport() {
  const btn = document.getElementById('report-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Fetching data…'; }

  let sold, dataSourceNote;
  try {
    const { data, error } = await withTimeout(
      supabaseClient.from('trades').select('*').order('buy_date', { ascending: true }),
      10000,
      'Supabase trades query timed out after 10s'
    );
    if (error) throw error;
    if (data && data.length) {
      sold = data.map(mapSupabaseTradeToSoldShape);
      dataSourceNote = `Data source: Supabase database (${sold.length} trades)\nNote: near-miss, ATR-trim, peak price, and some momentum-protection detail aren't tracked in Supabase — those sections will show limited data for this run.`;
    } else {
      sold = state.sold;
      dataSourceNote = `Data source: localStorage fallback (${sold.length} trades)`;
    }
  } catch(e) {
    console.error('Supabase trade fetch failed, falling back to localStorage:', e.message);
    const isTimeout = /timed out/i.test(e.message);
    if (btn && isTimeout) {
      btn.innerHTML = '<span class="spinner"></span> Supabase timed out — using local data…';
      await new Promise(r => setTimeout(r, 1500));
    }
    sold = state.sold;
    dataSourceNote = `Data source: localStorage fallback (${sold.length} trades)`;
  }

  if (!sold.length) {
    if (btn) { btn.disabled = false; btn.textContent = '📋 Generate Claude Report'; }
    alert('No completed trades to report yet.');
    return;
  }

  const ratingSnapshotSection = await buildRatingSnapshotHistorySection(sold);
  const winnerExitTimingSection = await buildWinnerExitTimingSection(sold);
  const sellTimingAnalysisSection = buildSellTimingAnalysisSection(sold);
  const individualSignalPerformanceSection = buildIndividualSignalPerformanceSection(sold);
  const ureFactorAccuracySection = buildUreFactorAccuracySection(sold);

  const now = new Date();
  const dateStr = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });

  const wins   = sold.filter(s => s.pnlPct > 0);
  const losses = sold.filter(s => s.pnlPct <= 0);
  const apps   = sold.filter(s => s.source === 'App Signal');
  const owns   = sold.filter(s => s.source === 'Own Decision');
  const appWins = apps.filter(s => s.pnlPct > 0);
  const ownWins = owns.filter(s => s.pnlPct > 0);
  const totalPnL = sold.reduce((s,t) => s + t.pnlDollar, 0);

  const avg = (arr, fn) => arr.length ? (arr.reduce((s,x) => s + fn(x), 0) / arr.length) : 0;
  const avgWinPnL = avg(wins, s => s.pnlDollar).toFixed(2);
  const avgLossPnL = avg(losses, s => s.pnlDollar).toFixed(2);
  const best  = sold.reduce((a,b) => b.pnlPct > a.pnlPct ? b : a, sold[0]);
  const worst = sold.reduce((a,b) => b.pnlPct < a.pnlPct ? b : a, sold[0]);

  const sellNowCount  = sold.filter(s => s.sellWarningAtSale === 'SELL_NOW').length;
  const sellSoonCount = sold.filter(s => s.sellWarningAtSale === 'SELL_SOON').length;
  const holdingCount  = sold.filter(s => s.sellWarningAtSale === 'HOLDING').length;

  const tierStats = (min, max, label) => {
    const t = sold.filter(s => {
      const p = s.sellPrice;
      return p >= min && p <= max;
    });
    const tw = t.filter(s => s.pnlPct > 0);
    return `${label}: ${t.length} trades | ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}% win rate | avg ${t.length?avg(t,s=>s.pnlPct).toFixed(1):'—'}%`;
  };

  const durStats = (dur, label) => {
    const t = sold.filter(s => s.duration === dur);
    const tw = t.filter(s => s.pnlPct > 0);
    return `${label}: ${t.length} trades | ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}% win rate | avg ${t.length?avg(t,s=>s.pnlPct).toFixed(1):'—'}%`;
  };

  const scoreStats = (lo, hi) => {
    const t = sold.filter(s => s.scoreAtBuy >= lo && s.scoreAtBuy <= hi);
    const tw = t.filter(s => s.pnlPct > 0);
    return `Score ${lo}–${hi}: ${t.length} trades | ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}% win rate`;
  };

  const rsiBucket = (lo, hi, label) => {
    const t = sold.filter(s => (s.rsiAtBuy||0) >= lo && (s.rsiAtBuy||0) < hi);
    const tw = t.filter(s => s.pnlPct > 0);
    return `  ${label}: ${t.length} trades | ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}% win rate | avg outcome ${t.length?avg(t,s=>s.pnlPct).toFixed(1):'—'}%`;
  };

  const volBucket = (lo, hi, label) => {
    const t = sold.filter(s => (s.volRatioAtBuy||0) >= lo && (s.volRatioAtBuy||0) < hi);
    const tw = t.filter(s => s.pnlPct > 0);
    return `  ${label}: ${t.length} trades | ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}% win rate | avg outcome ${t.length?avg(t,s=>s.pnlPct).toFixed(1):'—'}%`;
  };

  const macroCondStats = (condition, label) => {
    const t = sold.filter(s => s.macroConditionAtBuy === condition);
    const tw = t.filter(s => s.pnlPct > 0);
    return `  ${label}: ${t.length} trades | ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}% win rate | avg outcome ${t.length?avg(t,s=>s.pnlPct).toFixed(1):'—'}%`;
  };

  const macroSectorWeaknessStats = (label) => {
    const t = sold.filter(s => (s.macroConditionAtBuy||'').startsWith('SECTOR_WEAKNESS'));
    const tw = t.filter(s => s.pnlPct > 0);
    return `  ${label}: ${t.length} trades | ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}% win rate | avg outcome ${t.length?avg(t,s=>s.pnlPct).toFixed(1):'—'}%`;
  };

  const thresholdBucket = (predicate, label) => {
    const t = sold.filter(predicate);
    const tw = t.filter(s => s.pnlPct > 0);
    return `  ${label} ${t.length} | win rate ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}%`;
  };

  const momentumActivatedTrades = sold.filter(s => s.momentumProtectionActivated);
  const momentumTrailingTrades  = sold.filter(s => s.trailingStopTriggered);
  const momentumRsiEarlyTrades  = sold.filter(s => s.rsiSuspendedAtGainPct != null);

  let report = `EDGE TRADE SIGNALS — CLAUDE ANALYSIS REPORT
Generated: ${dateStr}
App Version: ${VERSION}
${dataSourceNote}

=== INSTRUCTIONS FOR CLAUDE ===
I use a mobile trading signals app called EDGE Trade Signals. Below is my complete
trading history including the signal data the app used to make each recommendation.
Please analyze what the scoring system is getting right and wrong, identify which
signals are most predictive of profit for my specific trading style, and write a
revised "Scoring System", "Risk Score Formula", and "Trade Duration Classification"
section I can paste into my Claude Code spec to improve the next version of the app.
Also note any patterns in my behavior (app signals vs own decisions, hold times,
sell warning compliance) that might help me trade better.

=== AUTO-FLAGGED PATTERNS (informational only — not yet acted on) ===
${(()=>{
  if (!sold.length) return '  No completed trades yet.';
  const flags = [];
  const avgRsiW = avg(wins,s=>s.rsiAtBuy||0);
  const avgRsiL = avg(losses,s=>s.rsiAtBuy||0);
  if (wins.length && losses.length && Math.abs(avgRsiW-avgRsiL)/Math.max(avgRsiL,1)*100 > 15) {
    const dir = avgRsiW < avgRsiL ? 'LOWER' : 'HIGHER';
    flags.push(`⚠ Avg RSI at purchase: wins ${avgRsiW.toFixed(1)} vs losses ${avgRsiL.toFixed(1)} — wins had ${dir} RSI than losses.\n  Current scoring rewards RSI 50-65 with 20pts. Sample size: ${sold.length} trades.\n  Consider re-evaluating once sample reaches 25-30 trades.`);
  }
  const avgVolW = avg(wins,s=>s.volRatioAtBuy||0);
  const avgVolL = avg(losses,s=>s.volRatioAtBuy||0);
  if (wins.length && losses.length && Math.abs(avgVolW-avgVolL)/Math.max(avgVolL,1)*100 > 15) {
    const dir = avgVolW < avgVolL ? 'LOWER' : 'HIGHER';
    flags.push(`⚠ Avg volume ratio at purchase: wins ${avgVolW.toFixed(2)}x vs losses ${avgVolL.toFixed(2)}x — wins had ${dir} volume ratio than losses.\n  Current scoring rewards higher volume. Sample size: ${sold.length} trades.\n  Consider re-evaluating once sample reaches 25-30 trades.`);
  }
  const avgScoreW = avg(wins,s=>s.scoreAtBuy||0);
  const avgScoreL = avg(losses,s=>s.scoreAtBuy||0);
  if (wins.length && losses.length && Math.abs(avgScoreW-avgScoreL)/Math.max(avgScoreL,1)*100 > 15) {
    const dir = avgScoreW < avgScoreL ? 'LOWER' : 'HIGHER';
    flags.push(`⚠ Avg signal score at purchase: wins ${avgScoreW.toFixed(1)} vs losses ${avgScoreL.toFixed(1)} — wins had ${dir} score than losses.\n  Current scoring uses 80+ = STRONG BUY. Sample size: ${sold.length} trades.\n  Consider re-evaluating once sample reaches 25-30 trades.`);
  }
  return flags.length ? flags.join('\n\n') : '  No divergences >15% detected between wins and losses on RSI, volume ratio, or signal score.';
})()}

=== APP CONFIGURATION AT TIME OF REPORT ===
Version: ${VERSION}
Budget: $${state.settings.budget}
Min Volume Threshold: ${(state.settings.minVolume||100000).toLocaleString()}
Include Under $2: ${state.settings.includeUnder2?'Yes':'No'}
Show WATCH signals: ${state.settings.showWatch?'Yes':'No'}

=== SUMMARY STATISTICS ===
Total completed trades: ${sold.length}
  - App signal trades: ${apps.length} (${sold.length?(apps.length/sold.length*100).toFixed(0):0}% of total)
  - Own decision trades: ${owns.length} (${sold.length?(owns.length/sold.length*100).toFixed(0):0}% of total)

Overall win rate: ${sold.length?((wins.length/sold.length*100).toFixed(0)):0}%
  - App signal win rate: ${apps.length?((appWins.length/apps.length*100).toFixed(0)):0}%
  - Own decision win rate: ${owns.length?((ownWins.length/owns.length*100).toFixed(0)):0}%

Average profit on wins: +$${avgWinPnL} (${avg(wins,s=>s.pnlPct).toFixed(1)}%)
Average loss on losses: $${avgLossPnL} (${avg(losses,s=>s.pnlPct).toFixed(1)}%)
Best trade: ${best.ticker} +$${best.pnlDollar.toFixed(2)} (+${best.pnlPct.toFixed(1)}%)
Worst trade: ${worst.ticker} $${worst.pnlDollar.toFixed(2)} (${worst.pnlPct.toFixed(1)}%)

Signal data at purchase — wins vs losses:
  Avg RSI:          wins ${avg(wins,s=>s.rsiAtBuy||0).toFixed(1)}  | losses ${avg(losses,s=>s.rsiAtBuy||0).toFixed(1)}
  Avg volume ratio: wins ${avg(wins,s=>s.volRatioAtBuy||0).toFixed(2)}x | losses ${avg(losses,s=>s.volRatioAtBuy||0).toFixed(2)}x
  Avg risk score:   wins ${avg(wins,s=>s.riskAtBuy||0).toFixed(1)}  | losses ${avg(losses,s=>s.riskAtBuy||0).toFixed(1)}
  Avg signal score: wins ${avg(wins,s=>s.scoreAtBuy||0).toFixed(1)}  | losses ${avg(losses,s=>s.scoreAtBuy||0).toFixed(1)}
  Avg hold time:    wins ${avg(wins,s=>s.daysHeld||0).toFixed(1)} days | losses ${avg(losses,s=>s.daysHeld||0).toFixed(1)} days

RSI at purchase — win rate by bucket:
${rsiBucket(0,45,'<45    ')}
${rsiBucket(45,55,'45–55  ')}
${rsiBucket(55,65,'55–65  ')}
${rsiBucket(65,999,'65+    ')}

Volume ratio at purchase — win rate by bucket:
${volBucket(0,1.0,'<1.0x  ')}
${volBucket(1.0,2.0,'1.0–2x ')}
${volBucket(2.0,3.0,'2–3x   ')}
${volBucket(3.0,999,'3x+    ')}

Sell warning compliance:
  Trades where SELL NOW was showing at sale: ${sellNowCount}
  Trades where SELL SOON was showing at sale: ${sellSoonCount}
  Trades where HOLDING was showing at sale: ${holdingCount}

Performance by signal type at purchase:
  VOL BUILD signal fired:
    Trades: ${sold.filter(s=>(s.signalsFiredAtBuy||[]).includes('VOL_BUILD')).length}
    Win rate: ${(()=>{const t=sold.filter(s=>(s.signalsFiredAtBuy||[]).includes('VOL_BUILD'));return t.length?((t.filter(s=>s.pnlPct>0).length/t.length*100).toFixed(0)+'%'):'N/A';})()}
  MEAN REVERSION signal fired:
    Trades: ${sold.filter(s=>(s.signalsFiredAtBuy||[]).includes('MEAN_REVERSION')).length}
    Win rate: ${(()=>{const t=sold.filter(s=>(s.signalsFiredAtBuy||[]).includes('MEAN_REVERSION'));return t.length?((t.filter(s=>s.pnlPct>0).length/t.length*100).toFixed(0)+'%'):'N/A';})()}
  Neither special signal:
    Trades: ${sold.filter(s=>!(s.signalsFiredAtBuy||[]).length).length}
    Win rate: ${(()=>{const t=sold.filter(s=>!(s.signalsFiredAtBuy||[]).length);return t.length?((t.filter(s=>s.pnlPct>0).length/t.length*100).toFixed(0)+'%'):'N/A';})()}

Performance by price tier:
  ${tierStats(1,3,'$1–$3')}
  ${tierStats(4,9,'$4–$9')}
  ${tierStats(10,20,'$10–$20')}

Performance by duration classification:
  ${durStats('DAY','Exit Today')}
  ${durStats('3-DAY','Est. 2-4 Days')}
  ${durStats('WEEK','Est. 5-7 Days')}

Performance by signal score at purchase:
  ${scoreStats(29,72)}
  ${scoreStats(73,115)}
  ${scoreStats(116,Infinity)}

=== NEAR-MISS SIGNAL ANALYSIS ===

VOL_BUILD near-misses (signal didn't fire, but close):
${(()=>{
  // Change 10 (Scoring Formula v2): near-miss threshold shifted from 2 to 1
  // consecutive day, matching VOL_BUILD's firing threshold moving from 3 to 2 days.
  const t2 = sold.filter(s=>s.volBuildNearMiss && s.volBuildNearMiss.consecutiveDays===1);
  const t2w = t2.filter(s=>s.pnlPct>0);
  const tr = sold.filter(s=>s.volBuildNearMiss && s.volBuildNearMiss.volRatio>=1.0 && s.volBuildNearMiss.volRatio<1.3);
  const trw = tr.filter(s=>s.pnlPct>0);
  return `  Trades where consecutive days was 1 (needed 2): ${t2.length} | win rate ${t2.length?((t2w.length/t2.length*100).toFixed(0)):'—'}%
  Trades where vol ratio was 1.0–1.3x (needed 1.3x+): ${tr.length} | win rate ${tr.length?((trw.length/tr.length*100).toFixed(0)):'—'}%`;
})()}

MEAN_REVERSION near-misses:
${(()=>{
  const t48 = sold.filter(s=>s.meanReversionNearMiss && s.meanReversionNearMiss.pctBelowMA<=-4 && s.meanReversionNearMiss.pctBelowMA>-8);
  const t48w = t48.filter(s=>s.pnlPct>0);
  const tr = sold.filter(s=>s.meanReversionNearMiss && s.meanReversionNearMiss.rsi>=45 && s.meanReversionNearMiss.rsi<50);
  const trw = tr.filter(s=>s.pnlPct>0);
  return `  Trades where price was 4–8% below MA (needed 8–15%): ${t48.length} | win rate ${t48.length?((t48w.length/t48.length*100).toFixed(0)):'—'}%
  Trades where RSI was 45–50 (needed <45): ${tr.length} | win rate ${tr.length?((trw.length/tr.length*100).toFixed(0)):'—'}%`;
})()}

Target drift at time of sale:
${(()=>{
  const higher = sold.filter(s=>s.targetDriftPct!=null && s.targetDriftPct>5);
  const higherW = higher.filter(s=>s.pnlPct>0);
  const lower = sold.filter(s=>s.targetDriftPct!=null && s.targetDriftPct<-5);
  const lowerW = lower.filter(s=>s.pnlPct>0);
  const within = sold.filter(s=>s.targetDriftPct!=null && Math.abs(s.targetDriftPct)<=5);
  const withinW = within.filter(s=>s.pnlPct>0);
  return `  Trades where live target was >5% higher than original:  ${higher.length} | win rate ${higher.length?((higherW.length/higher.length*100).toFixed(0)):'—'}%
  Trades where live target was >5% lower than original:   ${lower.length} | win rate ${lower.length?((lowerW.length/lower.length*100).toFixed(0)):'—'}%
  Trades where live target was within 5% of original:     ${within.length} | win rate ${within.length?((withinW.length/within.length*100).toFixed(0)):'—'}%`;
})()}

Target capping at time of purchase:
${(()=>{
  const cap52 = sold.filter(s=>s.cappedByAtBuy==='52-week high');
  const cap52w = cap52.filter(s=>s.pnlPct>0);
  const capSwing = sold.filter(s=>s.cappedByAtBuy==='recent swing high');
  const capSwingW = capSwing.filter(s=>s.pnlPct>0);
  const capMA = sold.filter(s=>s.cappedByAtBuy==='20-day MA');
  const capMAW = capMA.filter(s=>s.pnlPct>0);
  const uncapped = sold.filter(s=>!s.cappedByAtBuy);
  const uncappedW = uncapped.filter(s=>s.pnlPct>0);
  return `  Trades where target was capped by 52-week high:    ${cap52.length} | win rate ${cap52.length?((cap52w.length/cap52.length*100).toFixed(0)):'—'}%
  Trades where target was capped by swing high:      ${capSwing.length} | win rate ${capSwing.length?((capSwingW.length/capSwing.length*100).toFixed(0)):'—'}%
  Trades where target was capped by 20-day MA:       ${capMA.length} | win rate ${capMA.length?((capMAW.length/capMA.length*100).toFixed(0)):'—'}%
  Trades where target was NOT capped (ATR ruled):    ${uncapped.length} | win rate ${uncapped.length?((uncappedW.length/uncapped.length*100).toFixed(0)):'—'}%`;
})()}

ATR trimming impact at time of purchase:
${(()=>{
  const withAtr = sold.filter(s=>s.rawAtrAtBuy!=null && s.trimmedAtrAtBuy!=null);
  if (!withAtr.length) return '  No trades with ATR data recorded yet.';
  const avgRaw = avg(withAtr, s=>s.rawAtrAtBuy);
  const avgTrimmed = avg(withAtr, s=>s.trimmedAtrAtBuy);
  const reductionPct = avgRaw > 0 ? ((avgRaw - avgTrimmed) / avgRaw * 100) : 0;
  return `  Avg raw ATR across all trades:     ${avgRaw.toFixed(3)}
  Avg trimmed ATR across all trades: ${avgTrimmed.toFixed(3)}
  Avg reduction from trimming:       ${reductionPct.toFixed(1)}% smaller`;
})()}

=== MACRO CONDITION AT TIME OF PURCHASE ===

Trades by market condition:
${macroCondStats('RISK_OFF',          'RISK_OFF:            ')}
${macroCondStats('GEOPOLITICAL',      'GEOPOLITICAL:        ')}
${macroCondStats('TECH_ROTATION_OUT', 'TECH_ROTATION_OUT:   ')}
${macroCondStats('BROAD_RALLY',       'BROAD_RALLY:         ')}
${macroCondStats('MOMENTUM_DAY',      'MOMENTUM_DAY:        ')}
${macroSectorWeaknessStats(          'SECTOR_WEAKNESS_*:   ')}
${macroCondStats('CHOPPY',            'CHOPPY:              ')}

Threshold at time of purchase:
${thresholdBucket(s => (s.thresholdAtBuy ?? BASE_SCORE_THRESHOLD) >= ELEVATED_SCORE_THRESHOLD, 'Trades bought under elevated threshold (73+):')}
${thresholdBucket(s => (s.thresholdAtBuy ?? BASE_SCORE_THRESHOLD) < ELEVATED_SCORE_THRESHOLD, 'Trades bought under normal threshold (29+):  ')}

${(()=>{
  // Change 4 (Data & Reporting) — entry timing, sub-$10 adjustment, Groq
  // pre-buy accuracy, and exit timing. All read fields that only exist on
  // trades recorded after this update; pre-update trades are simply excluded
  // from the relevant buckets (buySession/buyDayOfWeek/etc. are undefined
  // for them, so they never match a filter predicate) rather than crashing.

  const sessionStats = (session, label) => {
    const t = sold.filter(s => s.buySession === session);
    const tw = t.filter(s => s.pnlPct > 0);
    return `  ${(label+':').padEnd(25)}${t.length} trades | ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}% win rate | avg ${t.length?avg(t,s=>s.pnlPct).toFixed(1):'—'}%`;
  };
  const dayOfWeekStats = (day) => {
    const t = sold.filter(s => s.buyDayOfWeek === day);
    const tw = t.filter(s => s.pnlPct > 0);
    return `  ${(day+':').padEnd(11)}${t.length} trades | ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}% win rate | avg outcome ${t.length?avg(t,s=>s.pnlPct).toFixed(1):'—'}%`;
  };

  const entryTiming = `=== ENTRY TIMING ANALYSIS ===

Performance by time of day at purchase:
${sessionStats('PRE_MARKET', 'Pre-market entries')}
${sessionStats('REGULAR', 'Regular session entries')}

Performance by day of week at purchase:
${dayOfWeekStats('Monday')}
${dayOfWeekStats('Tuesday')}
${dayOfWeekStats('Wednesday')}
${dayOfWeekStats('Thursday')}
${dayOfWeekStats('Friday')}`;

  const withSubTen   = sold.filter(s => s.subTenEntryAdjustment != null);
  const subTenBonus  = withSubTen.filter(s => s.subTenEntryAdjustment > 0);
  const subTenPenalty= withSubTen.filter(s => s.subTenEntryAdjustment < 0);
  const subTenNone   = withSubTen.filter(s => s.subTenEntryAdjustment === 0);
  const subTenBucketStats = (arr) => {
    const w = arr.filter(s => s.pnlPct > 0);
    return `  Total: ${arr.length} | win rate ${arr.length?((w.length/arr.length*100).toFixed(0)):'—'}% | avg outcome ${arr.length?avg(arr,s=>s.pnlPct).toFixed(1):'—'}%`;
  };
  const avgSubTenBonus   = subTenBonus.length   ? avg(subTenBonus, s=>s.subTenEntryAdjustment).toFixed(1) : null;
  const avgSubTenPenalty = subTenPenalty.length ? Math.abs(avg(subTenPenalty, s=>s.subTenEntryAdjustment)).toFixed(1) : null;

  const subTenSection = `=== SUB-$10 ENTRY ADJUSTMENT ANALYSIS ===

Trades where sub-$10 bonus applied (positive adjustment):
${subTenBucketStats(subTenBonus)}
  Avg adjustment applied: ${avgSubTenBonus!=null?`+${avgSubTenBonus}`:'—'} pts

Trades where sub-$10 penalty applied (negative adjustment):
${subTenBucketStats(subTenPenalty)}
  Avg adjustment applied: ${avgSubTenPenalty!=null?`-${avgSubTenPenalty}`:'—'} pts

Trades where no sub-$10 adjustment ($10+ stocks):
${subTenBucketStats(subTenNone)}`;

  // groqProbabilityAtBuy is a string like "REACH TARGET: 65% likely" (or null
  // if Groq wasn't run before buying). Only the unowned-prompt labels
  // (REACH TARGET / DROP FROM HERE) are meaningful pre-buy reads.
  const parseGroqAtBuy = (s) => {
    const m = (s.groqProbabilityAtBuy || '').match(/^(.+?):\s*(\d+)%\s*likely/i);
    return m ? { label: m[1].trim().toUpperCase(), pct: parseInt(m[2], 10) } : null;
  };
  const groqRunTrades = sold.filter(s => s.groqProbabilityAtBuy);
  const groqNotRunTrades = sold.filter(s => !s.groqProbabilityAtBuy);
  const groqBucketStats = (arr) => {
    const w = arr.filter(s => s.pnlPct > 0);
    return `Win rate: ${arr.length?((w.length/arr.length*100).toFixed(0)):'—'}% | avg outcome ${arr.length?avg(arr,s=>s.pnlPct).toFixed(1):'—'}%`;
  };

  let groqSection;
  if (groqRunTrades.length < 5) {
    groqSection = `=== GROQ PRE-BUY ANALYSIS ACCURACY ===

Insufficient data — run Groq analysis before buying to build this dataset`;
  } else {
    const parsed = sold.map(s => ({ s, p: parseGroqAtBuy(s) })).filter(x => x.p);
    const groqReachHigh = parsed.filter(x => x.p.label.includes('REACH TARGET') && x.p.pct > 50).map(x => x.s);
    const groqDropHigh  = parsed.filter(x => x.p.label.includes('DROP FROM HERE') && x.p.pct > 50).map(x => x.s);
    groqSection = `=== GROQ PRE-BUY ANALYSIS ACCURACY ===

Trades where Groq was run before buying:          ${groqRunTrades.length}
  Groq said REACH TARGET likely (>50%):
    ${groqBucketStats(groqReachHigh)}
  Groq said DROP FROM HERE likely (>50%):
    ${groqBucketStats(groqDropHigh)}
  Trades where Groq was NOT run before buying:    ${groqNotRunTrades.length}
    ${groqBucketStats(groqNotRunTrades)}`;
  }

  const distBucket = (predicate, label) => {
    const t = sold.filter(s => s.distanceFromTargetAtSale != null && predicate(s.distanceFromTargetAtSale));
    return `  ${label.padEnd(35)}${t.length} trades | avg outcome ${t.length?avg(t,s=>s.pnlPct).toFixed(1):'—'}%`;
  };
  const withDist = sold.filter(s => s.distanceFromTargetAtSale != null);
  const avgDist = withDist.length ? avg(withDist, s=>s.distanceFromTargetAtSale).toFixed(1) : null;

  const exitTiming = `=== EXIT TIMING ANALYSIS ===

Distance from target at time of sale:
${distBucket(d => d > 10, 'Sold more than 10% below target:')}
${distBucket(d => d >= 5 && d <= 10, 'Sold 5-10% below target:')}
${distBucket(d => d > 0 && d < 5, 'Sold within 5% of target:')}
${distBucket(d => d <= 0, 'Sold at or above target:')}

Average distance from target at sale across all trades: ${avgDist!=null?`${avgDist}%`:'N/A'}`;

  return [entryTiming, subTenSection, groqSection, exitTiming].join('\n\n');
})()}

=== MOMENTUM PROTECTION ===

Trades where Momentum Protection activated:     ${momentumActivatedTrades.length}
Avg outcome on those trades:                    ${momentumActivatedTrades.length ? avg(momentumActivatedTrades, s=>s.pnlPct).toFixed(1) : '—'}%
Trades where trailing stop triggered exit:      ${momentumTrailingTrades.length} | avg outcome ${momentumTrailingTrades.length ? avg(momentumTrailingTrades, s=>s.pnlPct).toFixed(1) : '—'}%
Trades where RSI would have triggered early:    ${momentumRsiEarlyTrades.length} | avg gain at that
  point ${momentumRsiEarlyTrades.length ? avg(momentumRsiEarlyTrades, s=>s.rsiSuspendedAtGainPct).toFixed(1) : '—'}% (shows how much would have been left on the table)

=== CATALYST SETUP ANALYSIS ===

Trades where CATALYST_SETUP flag was active at purchase:
${(()=>{
  const flagged = sold.filter(s => s.catalystSetup);
  const nonFlagged = sold.filter(s => !s.catalystSetup);
  if (!flagged.length) return `  Total flagged trades: 0
  No completed trades with the CATALYST_SETUP flag yet.`;
  const flaggedW = flagged.filter(s => s.pnlPct > 0);
  const best = flagged.reduce((a,b) => b.pnlPct > a.pnlPct ? b : a);
  const worst = flagged.reduce((a,b) => b.pnlPct < a.pnlPct ? b : a);
  return `  Total flagged trades: ${flagged.length}
  Win rate on flagged trades: ${(flaggedW.length/flagged.length*100).toFixed(0)}%
  Avg outcome on flagged trades: ${avg(flagged, s=>s.pnlPct).toFixed(1)}%
  Avg outcome on non-flagged trades: ${nonFlagged.length ? avg(nonFlagged, s=>s.pnlPct).toFixed(1) : '—'}%
  Best flagged trade: ${best.ticker} ${best.pnlPct >= 0 ? '+' : ''}${best.pnlPct.toFixed(1)}%
  Worst flagged trade: ${worst.ticker} ${worst.pnlPct >= 0 ? '+' : ''}${worst.pnlPct.toFixed(1)}%`;
})()}

=== UNIFIED RECOMMENDATION AT TIME OF SALE ===
${(()=>{
  // unifiedRecommendationAtSale is null on trades sold before this feature
  // existed (or during its beta-toggle period) — those simply don't match
  // any bucket below rather than being force-fit into one.
  const withUnified = sold.filter(s => s.unifiedRecommendationAtSale);
  if (!withUnified.length) return '  No completed trades with a unified recommendation on record yet.';

  const bucket = (label, predicate) => {
    const t = withUnified.filter(predicate);
    return `  ${label.padEnd(20)}${t.length} trades | avg outcome ${t.length ? avg(t, s=>s.pnlPct).toFixed(1) : '—'}%`;
  };
  const distribution = `Distribution of recommendations at time of sale:
${bucket('SELL NOW:', s => s.unifiedRecommendationAtSale.startsWith('SELL NOW'))}
${bucket('SELL SOON:', s => s.unifiedRecommendationAtSale === 'SELL SOON')}
${bucket('CONSIDER SELLING:', s => s.unifiedRecommendationAtSale === 'CONSIDER SELLING')}
${bucket('HOLD:', s => s.unifiedRecommendationAtSale === 'HOLD' || s.unifiedRecommendationAtSale === 'HOLD — Mixed signals')}
${bucket('HOLD STRONG:', s => s.unifiedRecommendationAtSale === 'HOLD STRONG')}
${bucket('HIGH CONVICTION:', s => s.unifiedRecommendationAtSale === 'HIGH CONVICTION HOLD')}`;

  const topFactorsFor = (predicate, field, caseSuffix) => {
    const counts = {};
    withUnified.filter(predicate).forEach(s => (s[field] || []).forEach(name => { counts[name] = (counts[name] || 0) + 1; }));
    const ranked = Object.entries(counts).sort((a,b) => b[1] - a[1]).slice(0, 3);
    return ranked.length
      ? ranked.map(([name, n], i) => `  ${i+1}. ${name}: appeared in ${n} ${caseSuffix}${n===1?'':'s'}`).join('\n')
      : '  Not enough trades in this category yet.';
  };

  return `${distribution}

Top factors that appeared most in SELL NOW recommendations:
${topFactorsFor(s => s.unifiedRecommendationAtSale.startsWith('SELL NOW'), 'topExitFactorsAtSale', 'SELL NOW case')}

Top factors that appeared most in HIGH CONVICTION HOLD:
${topFactorsFor(s => s.unifiedRecommendationAtSale === 'HIGH CONVICTION HOLD', 'topHoldFactorsAtSale', 'case')}`;
})()}

${winnerExitTimingSection}

${sellTimingAnalysisSection}

${ratingSnapshotSection}

${individualSignalPerformanceSection}

${ureFactorAccuracySection}

=== FULL TRADE HISTORY ===

`;

  // Bucket-label lookups for the two annotations that only have derived
  // points captured, not the underlying raw percentage (todayChange/
  // rsVsSPY were never persisted — see Step 7 clarification).
  const fmtPts = (v) => v == null ? 'N/A' : `${v >= 0 ? '+' : ''}${v} pts`;
  const momentumBucketLabel = (pts) => ({20:' (up 4%+)', 10:' (up 2-4%)', 0:' (under 2%)'}[pts] ?? '');
  const relStrengthBucketLabel = (pts) => ({15:' (outperform 2%+)', 10:' (outperform 1%+)', 5:' (outperform >0%)', 0:' (underperform)'}[pts] ?? '');

  sold.forEach((s, i) => {
    // Change 4 (Data & Reporting): pre-update trades won't have these fields —
    // fall back to explicit 'N/A' rather than letting undefined leak into the report.
    const subTenLine = s.subTenEntryAdjustment == null
      ? 'N/A'
      : s.priceRange === '$10–$20'
        ? 'N/A'
        : `${s.subTenEntryAdjustment >= 0 ? '+' : ''}${s.subTenEntryAdjustment} pts`;
    const distLine = s.distanceFromTargetAtSale == null
      ? 'N/A'
      : s.distanceFromTargetAtSale >= 0
        ? `${s.distanceFromTargetAtSale.toFixed(1)}% below target`
        : `${Math.abs(s.distanceFromTargetAtSale).toFixed(1)}% above target`;

    report += `Trade #${i+1}
  Ticker: ${s.ticker} — ${s.company}
  Bought: $${s.buyPrice.toFixed(2)} on ${s.buyDate}
  Sold: $${s.sellPrice.toFixed(2)} on ${s.sellDate}
  Shares: ${s.shares} | Days held: ${s.daysHeld}
  Result: ${s.pnlDollar>=0?'WIN':'LOSS'} $${s.pnlDollar.toFixed(2)} (${s.pnlPct.toFixed(1)}%)
  Source: ${s.source}
  Signal score at purchase: ${s.scoreAtBuy}/100
  Signals fired at purchase: ${(s.signalsFiredAtBuy||[]).length ? s.signalsFiredAtBuy.join(', ') : 'none'}
  RSI at purchase: ${s.rsiAtBuy?.toFixed(1)||'N/A'}
  Volume ratio at purchase: ${s.volRatioAtBuy?.toFixed(2)||'N/A'}x
  Risk score at purchase: ${s.riskAtBuy||'N/A'}/10
  Duration classification: ${s.duration}
  Price tier: ${s.priceRange}
  News at purchase: ${s.newsAtBuy||'none'}
  Sell warning at time of sale: ${(s.sellWarningAtSale||'HOLDING').replace('_',' ')}
  Buy time: ${s.buyTime ? `${s.buyTime} Pacific (${s.buyDayOfWeek}, ${s.buySession})` : 'N/A'}
  Sell time: ${s.sellTime ? `${s.sellTime} Pacific (${s.sellDayOfWeek})` : 'N/A'}
  Sub-$10 entry adjustment: ${subTenLine}
  Groq at purchase: ${s.groqProbabilityAtBuy || 'Not run'}
  Distance from target at sale: ${distLine}
  Score breakdown at purchase:
    Volume spike:      ${fmtPts(s.volSpikePts)} (${s.volRatioAtBuy!=null?s.volRatioAtBuy.toFixed(2):'N/A'}x avg)
    Price momentum:    ${fmtPts(s.priceMomentumPts)}${momentumBucketLabel(s.priceMomentumPts)}
    RSI position:      ${fmtPts(s.rsiPts)} (RSI ${s.rsiAtBuy!=null?s.rsiAtBuy.toFixed(1):'N/A'})
    Above 20-day MA:   ${fmtPts(s.maPts)}
    Volume build:      ${fmtPts(s.volBuildPts)}
    Mean reversion:    ${fmtPts(s.meanReversionPts)}
    Consecutive days:  ${fmtPts(s.consUpPts)} (${s.consUpDays!=null?s.consUpDays:'N/A'} days)
    Relative strength: ${fmtPts(s.relStrengthPts)}${relStrengthBucketLabel(s.relStrengthPts)}
    Catalyst setup:    ${fmtPts(s.catalystSetup ? 10 : 0)}
    Sub-$10 timing:    ${fmtPts(s.subTenEntryAdjustment)}
    Raw total:         ${s.rawScoreAtBuy!=null?`${s.rawScoreAtBuy}/${RAW_SCORE_MAX} (approximate)`:'N/A'}
    Macro adjustment:  ${fmtPts(s.macroAdjustmentPts)} (${s.macroConditionAtBuy||'none'})
    Final score:       ${s.scoreAtBuy}/100

`;
  });

  report += `=== CURRENT SCORING FORMULA (for Claude's reference) ===

Scoring System — Scoring Formula v2 (raw signal points, summed directly — no
longer normalized to a 0-100 scale. Floored at 0 after the Macro Market
Overlay adjustment below is applied; uncapped above):
  Volume spike:        −10 to +20 pts (<0.5x=0, 0.5-1x=15, 1-2x=20 best zone, 2-3x=10, 3x+=−10)
  Volume build:        0–15 pts (2 consecutive days rising + today >=1.3x avg)
  Price momentum:      0–20 pts (2-4%=10, 4%+=20)
  RSI position:        −10 to +20 pts (<35=10, 35-55=15, 55-65=20 best zone, 65-75=0, 75+=−10)
  Above 20-day MA:     10 pts
  Relative strength:   0–15 pts (outperform SPY by >0%=5, >1%=10, >2%=15)
  Consecutive up days: 0–15 pts (2 days=5, 3 days=10, 4+ days=15)
  Mean reversion:      0–20 pts (price 8-15% below MA, RSI<45, RSI turning up)

RAW_SCORE_MAX (${RAW_SCORE_MAX}) is the sum of max POSITIVE points only. The
displayed score IS this raw sum plus the macro adjustment below — it can
exceed ${RAW_SCORE_MAX} when that adjustment is positive, and floors at 0
when negative signals and a negative macro adjustment combine.

Labels: 116+=STRONG BUY | 73–115=SOFT BUY | 29–72=WATCH | <29=excluded

Note for Claude: scores were normalized to a 0-100 scale in earlier app
versions. Trades from before this version show a 0-100 scoreAtBuy; trades
from this version forward show the raw, unnormalized score instead (so
rawScoreAtBuy and scoreAtBuy are identical going forward). Keep this in mind
when comparing scoreAtBuy across trades that span the transition — a
scoreAtBuy of 65 means something very different depending on which side of
that line the trade falls on.

Risk Score (1–10):
  Base by price tier: $1–$3=6, $4–$9=4, $10–$20=3
  ATR >10% of price: +2, >6%: +1
  RSI >75 or <30: +2
  Negative news: +2
  Cap: 1–10

Trade Duration:
  DAY:   RSI>68 OR vol>3x
  WEEK:  RSI 48-60 trending up AND vol 1.2-1.8x
  3-DAY: Default (RSI 52-68 AND vol 1.5-3x)
`;

  const blob = new Blob([report], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `edge-report-${new Date().toISOString().split('T')[0]}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  if (btn) { btn.disabled = false; btn.textContent = '📋 Generate Claude Report'; }
}

// ── 19. SETTINGS TAB ──────────────────────────────────────────────

function renderSettingsTab() {
  const s = state.settings;
  document.getElementById('tab-content').innerHTML = `
    <div class="tab-header"><h1 class="tab-title">SETTINGS</h1></div>

    <div class="settings-section">
      <div class="settings-section-title">API Keys</div>
      <div class="settings-row" style="flex-direction:column;align-items:stretch;">
        <div class="settings-label">Alpaca API Key ID</div>
        <input id="set-alpaca-key" class="settings-input mt4" type="text"
          placeholder="PKXXXXXXXXXX" value="${s.alpacaKey||''}">
      </div>
      <div class="settings-row" style="flex-direction:column;align-items:stretch;">
        <div class="settings-label">Alpaca Secret Key</div>
        <div class="pw-wrap mt4">
          <input id="set-alpaca-secret" class="settings-input" type="password"
            placeholder="••••••••" value="${s.alpacaSecret||''}">
          <button class="pw-toggle" onclick="togglePw('set-alpaca-secret')">👁</button>
        </div>
      </div>
      <div class="settings-row" style="flex-direction:column;align-items:stretch;">
        <div class="settings-label">Groq API Key</div>
        <div class="pw-wrap mt4">
          <input id="set-groq-key" class="settings-input" type="password"
            placeholder="gsk_••••••••" value="${s.groqKey||''}">
          <button class="pw-toggle" onclick="togglePw('set-groq-key')">👁</button>
        </div>
      </div>
      <div class="settings-row">
        <button class="btn btn-primary btn-sm" onclick="saveApiKeys()">Save Keys</button>
        <button class="btn btn-ghost btn-sm" onclick="testConnections()">Test Connections</button>
      </div>
      <div id="test-results"></div>
    </div>

    <div class="settings-section mt12">
      <div class="settings-section-title">Budget</div>
      <div class="settings-row">
        <div>
          <div class="settings-label">My Trading Budget</div>
          <div class="settings-hint">Total capital allocated for trading</div>
        </div>
        <input id="set-budget" class="settings-number" type="number"
          min="0" step="10" value="${s.budget||500}">
      </div>
      <div class="settings-row">
        <button class="btn btn-primary btn-sm" onclick="saveBudget()">Save Budget</button>
      </div>
    </div>

    <div class="settings-section mt12">
      <div class="settings-section-title">Screener Preferences</div>
      <div class="settings-row">
        <div>
          <div class="settings-label">Include stocks under $2</div>
          <div class="settings-hint">Default OFF — higher risk</div>
        </div>
        <label class="toggle-wrap">
          <input type="checkbox" id="set-under2" ${s.includeUnder2?'checked':''} onchange="savePref('includeUnder2',this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-label">Disable macro overlay</div>
          <div class="settings-hint">Show pure technical signals only — ignores market condition adjustments</div>
        </div>
        <label class="toggle-wrap">
          <input type="checkbox" id="set-disable-macro" ${s.disableMacroOverlay?'checked':''} onchange="savePref('disableMacroOverlay',this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="settings-row" style="flex-direction:column;align-items:stretch;">
        <div class="settings-label">Minimum Volume Threshold</div>
        <div class="segmented mt4">
          ${[100000,250000,500000].map(v =>
            `<div class="seg-btn ${(s.minVolume||100000)===v?'active':''}"
              onclick="setMinVol(${v})">${v===100000?'100K':v===250000?'250K':'500K+'}</div>`
          ).join('')}
        </div>
      </div>
    </div>

    <div class="settings-section mt12">
      <div class="settings-section-title">Scoring Formula</div>
      <div class="score-table">
        <div class="score-row"><span>Volume spike (1.5–3×+)</span><span>0–30 pts</span></div>
        <div class="score-row"><span>Volume build (3-day rise)</span><span>+15 pts</span></div>
        <div class="score-row"><span>Price momentum (2–4%+)</span><span>0–20 pts</span></div>
        <div class="score-row"><span>RSI position</span><span>0–20 pts</span></div>
        <div class="score-row"><span>Above 20-day MA</span><span>+10 pts</span></div>
        <div class="score-row"><span>Relative strength vs market</span><span>0–15 pts</span></div>
        <div class="score-row"><span>Consecutive up days</span><span>0–15 pts</span></div>
        <div class="score-row"><span>Mean reversion setup</span><span>+20 pts</span></div>
        <div class="score-row score-row-total"><span>Total (capped)</span><span>100 pts</span></div>
        <div class="score-row"><span class="score-label-strong">STRONG BUY</span><span>80–100</span></div>
        <div class="score-row"><span class="score-label-soft">SOFT BUY</span><span>50–79</span></div>
        <div class="score-row"><span class="score-label-watch">WATCH</span><span>20–49</span></div>
      </div>
    </div>

    <div class="settings-section mt12">
      <div class="settings-section-title">Screener Health</div>
      <div class="settings-row">
        <div>
          <div class="settings-label">Active Universe</div>
          <div class="settings-hint">${state.selectedUniverse} — ${STOCK_UNIVERSES[state.selectedUniverse]?.length || 0} tickers</div>
        </div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-label">Universe Sizes</div>
          <div class="settings-hint">HEALTHCARE ${STOCK_UNIVERSES.HEALTHCARE.length} · ENERGY ${STOCK_UNIVERSES.ENERGY.length} · TECH ${STOCK_UNIVERSES.TECH.length} · RETAIL ${STOCK_UNIVERSES.RETAIL.length} · FINANCIAL ${STOCK_UNIVERSES.FINANCIAL.length} · INDUSTRIAL ${STOCK_UNIVERSES.INDUSTRIAL.length} · REAL_ESTATE ${STOCK_UNIVERSES.REAL_ESTATE.length} · CONSUMER ${STOCK_UNIVERSES.CONSUMER.length} · OTHER ${STOCK_UNIVERSES.OTHER.length}</div>
        </div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-label">Last Scan Candidates</div>
          <div class="settings-hint">${state.lastPassedCount ? `${state.lastPassedCount} stocks passed price &amp; volume filters` : 'No scan run yet'}</div>
        </div>
      </div>
    </div>

    ${(function() {
      const notif = state.notifications;
      const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
      const isActive = perm === 'granted' && notif.enabled;
      const activeMark = isActive ? ' <span style="color:#22c55e;font-size:14px;vertical-align:middle;">✓</span>' : '';

      let lastCheckText = 'Never';
      if (notif.lastPriceCheck) {
        const mins = Math.round((Date.now() - new Date(notif.lastPriceCheck).getTime()) / 60000);
        lastCheckText = mins < 1 ? 'Just now' : `${mins} minute${mins === 1 ? '' : 's'} ago`;
      }
      let nextCheckText = 'Pending';
      if (_notifNextCheckTime) {
        const minsLeft = Math.max(0, Math.round((_notifNextCheckTime - Date.now()) / 60000));
        nextCheckText = minsLeft < 1 ? 'Imminent' : `in ${minsLeft} minute${minsLeft === 1 ? '' : 's'}`;
      }

      let body = '';
      if (perm === 'granted') {
        body = `
          <div class="settings-row">
            <div>
              <div class="settings-label">Enable All Notifications</div>
              <div class="settings-hint">Status: ${notif.enabled ? 'Active' : 'Disabled'}</div>
            </div>
            <label class="toggle-wrap">
              <input type="checkbox" ${notif.enabled ? 'checked' : ''} onchange="toggleNotifications(this.checked)">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row">
            <div>
              <div class="settings-label">Last price check</div>
              <div class="settings-hint">${lastCheckText}</div>
            </div>
          </div>
          <div class="settings-row">
            <div>
              <div class="settings-label">Next check</div>
              <div class="settings-hint">${nextCheckText}</div>
            </div>
          </div>`;
      } else if (perm === 'denied') {
        body = `<div class="settings-hint" style="color:#f87171;line-height:1.5;">
          To enable notifications, go to your browser settings and allow notifications for this site.</div>`;
      } else if (perm === 'default') {
        body = `<div class="settings-row">
          <button class="btn btn-primary btn-sm" onclick="requestNotificationPermission().then(()=>renderSettingsTab())">Enable Notifications</button>
        </div>`;
      } else {
        body = `<div class="settings-hint muted">Push notifications are not supported in this browser.</div>`;
      }

      return `<div class="settings-section mt12">
        <div class="settings-section-title">Push Notifications${activeMark}</div>
        ${body}
      </div>`;
    })()}

    <div class="settings-section mt12">
      <div class="settings-section-title">Testing</div>
      <div class="settings-row">
        <div>
          <div class="settings-label">Force pre-market mode (testing)</div>
          <div class="settings-hint" style="color:var(--yellow)">⚠ Testing feature — makes the app treat any time as pre-market hours so you can test the pre-market movers section (tap/expand/Groq) without waiting for 5am. Turn off when done.</div>
        </div>
        <label class="toggle-wrap">
          <input type="checkbox" id="set-force-premarket" ${s.forcePreMarketMode?'checked':''} onchange="toggleForcePreMarketMode(this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <div class="settings-section mt12">
      <div class="settings-section-title">Database</div>
      <div id="db-usage"><div class="test-result"><span class="spinner"></span> Loading…</div></div>
      <div class="settings-row" style="flex-direction:column;align-items:stretch;">
        <button class="btn btn-ghost btn-sm mt8" onclick="exportAndArchiveDatabase()">📦 Export &amp; Archive Database</button>
        <div class="settings-hint mt4">Downloads all Supabase trade data as a report, then offers to purge rating snapshots older than 90 days</div>
      </div>
    </div>

    <div class="settings-section mt12">
      <div class="settings-section-title">App Info</div>
      <div class="settings-row">
        <span class="settings-label">Version</span>
        <span class="mono muted">${VERSION}</span>
      </div>
      <div class="settings-row">
        <button class="btn btn-ghost btn-sm" onclick="exportAllData(this)">Export All Data</button>
        <button class="btn btn-danger btn-sm" onclick="clearAllData()">Clear All Data</button>
      </div>
    </div>

    <div class="settings-section mt12">
      <div class="settings-section-title">App Maintenance</div>
      <div class="settings-row" style="flex-direction:column;align-items:stretch;">
        <button class="btn btn-ghost btn-sm" onclick="confirmForceUpdate()">🔄 Force Update App</button>
        <div class="settings-hint mt4">Use if app feels outdated after an update</div>
      </div>
      <div class="settings-row" style="flex-direction:column;align-items:stretch;">
        <button class="btn btn-ghost btn-sm" onclick="lockApp()">🔒 Lock App</button>
        <div class="settings-hint mt4">Require PIN entry again immediately</div>
      </div>
    </div>

    <div class="app-version">EDGE Trade Signals ${VERSION}<br>
      <a href="https://alpaca.markets" target="_blank">Get Alpaca Keys</a> ·
      <a href="https://console.groq.com/keys" target="_blank">Get Groq Key</a>
    </div>
  `;
  loadDatabaseUsage();
}

const DB_ROW_LIMIT = 50000;

async function loadDatabaseUsage() {
  const el = document.getElementById('db-usage');
  if (!el) return;
  try {
    const [snapRes, tradeRes] = await Promise.all([
      supabaseClient.from('rating_snapshots').select('*', { count: 'exact', head: true }),
      supabaseClient.from('trades').select('*', { count: 'exact', head: true }),
    ]);
    if (snapRes.error) throw snapRes.error;
    if (tradeRes.error) throw tradeRes.error;

    const snapN = snapRes.count || 0;
    const tradeN = tradeRes.count || 0;
    const total = snapN + tradeN;
    const pct = Math.min(100, (total / DB_ROW_LIMIT) * 100);
    const barClass = pct > 80 ? 'db-bar-red' : pct >= 60 ? 'db-bar-yellow' : 'db-bar-green';
    const warning = pct > 80
      ? `<div class="db-usage-warn">⚠ Consider archiving soon</div>`
      : '';

    el.innerHTML = `
      <div class="settings-row">
        <span class="settings-label">Rating snapshots</span>
        <span class="mono">${snapN.toLocaleString()} rows</span>
      </div>
      <div class="settings-row">
        <span class="settings-label">Trade records</span>
        <span class="mono">${tradeN.toLocaleString()} rows</span>
      </div>
      <div class="settings-row">
        <span class="settings-label">Total</span>
        <span class="mono">${total.toLocaleString()} / ${DB_ROW_LIMIT.toLocaleString()} rows (free tier limit)</span>
      </div>
      <div class="db-usage-bar-track">
        <div class="db-usage-bar-fill ${barClass}" style="width:${pct.toFixed(1)}%"></div>
      </div>
      ${warning}
    `;
  } catch(e) {
    el.innerHTML = `<div class="settings-hint" style="color:var(--red)">Could not load database usage.</div>`;
  }
}

// Builds a Claude-analysis-style report from Supabase data (trades + a rating
// snapshot summary), mirroring generateClaudeReport()'s structure but limited
// to the columns actually persisted in the trades/rating_snapshots tables —
// per-sale diagnostics that only ever lived in localStorage (near-miss data,
// sell-warning-at-sale, target drift/capping, ATR trimming, signals-fired list)
// aren't in the Supabase schema and are intentionally omitted rather than faked.
function buildSupabaseArchiveReport(trades, snapshotRows) {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });

  const wins   = trades.filter(t => t.pnl_pct > 0);
  const losses = trades.filter(t => t.pnl_pct <= 0);
  const apps   = trades.filter(t => t.source === 'App Signal');
  const owns   = trades.filter(t => t.source === 'Own Decision');
  const appWins = apps.filter(t => t.pnl_pct > 0);
  const ownWins = owns.filter(t => t.pnl_pct > 0);

  const avg = (arr, fn) => arr.length ? (arr.reduce((s,x) => s + fn(x), 0) / arr.length) : 0;
  const avgWinPnL  = avg(wins, t => t.pnl_dollars).toFixed(2);
  const avgLossPnL = avg(losses, t => t.pnl_dollars).toFixed(2);
  const best  = trades.reduce((a,b) => b.pnl_pct > a.pnl_pct ? b : a, trades[0]);
  const worst = trades.reduce((a,b) => b.pnl_pct < a.pnl_pct ? b : a, trades[0]);

  const tierStats = (min, max, label) => {
    const t = trades.filter(x => x.sell_price >= min && x.sell_price <= max);
    const tw = t.filter(x => x.pnl_pct > 0);
    return `${label}: ${t.length} trades | ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}% win rate | avg ${t.length?avg(t,x=>x.pnl_pct).toFixed(1):'—'}%`;
  };
  const durStats = (dur, label) => {
    const t = trades.filter(x => x.duration_classification === dur);
    const tw = t.filter(x => x.pnl_pct > 0);
    return `${label}: ${t.length} trades | ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}% win rate | avg ${t.length?avg(t,x=>x.pnl_pct).toFixed(1):'—'}%`;
  };
  const scoreStats = (lo, hi) => {
    const t = trades.filter(x => (x.signal_score??0) >= lo && (x.signal_score??0) <= hi);
    const tw = t.filter(x => x.pnl_pct > 0);
    return `Score ${lo}–${hi}: ${t.length} trades | ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}% win rate`;
  };
  const rsiBucket = (lo, hi, label) => {
    const t = trades.filter(x => (x.rsi_at_buy||0) >= lo && (x.rsi_at_buy||0) < hi);
    const tw = t.filter(x => x.pnl_pct > 0);
    return `  ${label}: ${t.length} trades | ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}% win rate | avg outcome ${t.length?avg(t,x=>x.pnl_pct).toFixed(1):'—'}%`;
  };
  const volBucket = (lo, hi, label) => {
    const t = trades.filter(x => (x.volume_ratio_at_buy||0) >= lo && (x.volume_ratio_at_buy||0) < hi);
    const tw = t.filter(x => x.pnl_pct > 0);
    return `  ${label}: ${t.length} trades | ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}% win rate | avg outcome ${t.length?avg(t,x=>x.pnl_pct).toFixed(1):'—'}%`;
  };
  const macroCondStats = (condition, label) => {
    const t = trades.filter(x => x.macro_condition === condition);
    const tw = t.filter(x => x.pnl_pct > 0);
    return `  ${label}: ${t.length} trades | ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}% win rate | avg outcome ${t.length?avg(t,x=>x.pnl_pct).toFixed(1):'—'}%`;
  };
  const macroSectorWeaknessStats = (label) => {
    const t = trades.filter(x => (x.macro_condition||'').startsWith('SECTOR_WEAKNESS'));
    const tw = t.filter(x => x.pnl_pct > 0);
    return `  ${label}: ${t.length} trades | ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}% win rate | avg outcome ${t.length?avg(t,x=>x.pnl_pct).toFixed(1):'—'}%`;
  };
  const sessionStats = (session, label) => {
    const t = trades.filter(x => x.buy_session === session);
    const tw = t.filter(x => x.pnl_pct > 0);
    return `  ${(label+':').padEnd(25)}${t.length} trades | ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}% win rate | avg ${t.length?avg(t,x=>x.pnl_pct).toFixed(1):'—'}%`;
  };
  const dayOfWeekStats = (day) => {
    const t = trades.filter(x => x.buy_day_of_week === day);
    const tw = t.filter(x => x.pnl_pct > 0);
    return `  ${(day+':').padEnd(11)}${t.length} trades | ${t.length?((tw.length/t.length*100).toFixed(0)):'—'}% win rate | avg outcome ${t.length?avg(t,x=>x.pnl_pct).toFixed(1):'—'}%`;
  };

  const withSubTen    = trades.filter(x => x.sub10_adjustment != null);
  const subTenBonus   = withSubTen.filter(x => x.sub10_adjustment > 0);
  const subTenPenalty = withSubTen.filter(x => x.sub10_adjustment < 0);
  const subTenNone    = withSubTen.filter(x => x.sub10_adjustment === 0);
  const subTenBucketStats = (arr) => {
    const w = arr.filter(x => x.pnl_pct > 0);
    return `  Total: ${arr.length} | win rate ${arr.length?((w.length/arr.length*100).toFixed(0)):'—'}% | avg outcome ${arr.length?avg(arr,x=>x.pnl_pct).toFixed(1):'—'}%`;
  };

  const parseGroqAtBuy = (x) => {
    const m = (x.groq_at_purchase || '').match(/^(.+?):\s*(\d+)%\s*likely/i);
    return m ? { label: m[1].trim().toUpperCase(), pct: parseInt(m[2], 10) } : null;
  };
  const groqRunTrades    = trades.filter(x => x.groq_at_purchase);
  const groqNotRunTrades = trades.filter(x => !x.groq_at_purchase);
  const groqBucketStats = (arr) => {
    const w = arr.filter(x => x.pnl_pct > 0);
    return `Win rate: ${arr.length?((w.length/arr.length*100).toFixed(0)):'—'}% | avg outcome ${arr.length?avg(arr,x=>x.pnl_pct).toFixed(1):'—'}%`;
  };
  let groqSection;
  if (groqRunTrades.length < 5) {
    groqSection = 'Insufficient data — run Groq analysis before buying to build this dataset';
  } else {
    const parsed = trades.map(x => ({ x, p: parseGroqAtBuy(x) })).filter(o => o.p);
    const reachHigh = parsed.filter(o => o.p.label.includes('REACH TARGET') && o.p.pct > 50).map(o => o.x);
    const dropHigh  = parsed.filter(o => o.p.label.includes('DROP FROM HERE') && o.p.pct > 50).map(o => o.x);
    groqSection = `Trades where Groq was run before buying:          ${groqRunTrades.length}
  Groq said REACH TARGET likely (>50%):
    ${groqBucketStats(reachHigh)}
  Groq said DROP FROM HERE likely (>50%):
    ${groqBucketStats(dropHigh)}
  Trades where Groq was NOT run before buying:    ${groqNotRunTrades.length}
    ${groqBucketStats(groqNotRunTrades)}`;
  }

  const distBucket = (predicate, label) => {
    const t = trades.filter(x => x.distance_from_target != null && predicate(x.distance_from_target));
    return `  ${label.padEnd(35)}${t.length} trades | avg outcome ${t.length?avg(t,x=>x.pnl_pct).toFixed(1):'—'}%`;
  };
  const withDist = trades.filter(x => x.distance_from_target != null);
  const avgDist  = withDist.length ? avg(withDist, x => x.distance_from_target).toFixed(1) : null;

  const momentumTrades = trades.filter(x => x.momentum_protection);

  // Rating snapshot summary: per-ticker counts + overall date range
  const snapByTicker = {};
  let minDate = null, maxDate = null;
  (snapshotRows || []).forEach(r => {
    snapByTicker[r.ticker] = (snapByTicker[r.ticker] || 0) + 1;
    if (!minDate || r.captured_at < minDate) minDate = r.captured_at;
    if (!maxDate || r.captured_at > maxDate) maxDate = r.captured_at;
  });
  const snapTickers = Object.keys(snapByTicker).sort();

  let report = `EDGE2 — SUPABASE DATABASE ARCHIVE
Generated: ${dateStr}
App Version: ${VERSION}

=== ARCHIVE SUMMARY ===
Total trades archived: ${trades.length}
Rating snapshot tickers tracked: ${snapTickers.length}
Rating snapshot total rows: ${(snapshotRows||[]).length}
Rating snapshot date range: ${minDate ? `${minDate.split('T')[0]} to ${maxDate.split('T')[0]}` : 'N/A'}

=== SUMMARY STATISTICS ===
Total completed trades: ${trades.length}
  - App signal trades: ${apps.length} (${trades.length?(apps.length/trades.length*100).toFixed(0):0}% of total)
  - Own decision trades: ${owns.length} (${trades.length?(owns.length/trades.length*100).toFixed(0):0}% of total)

Overall win rate: ${trades.length?((wins.length/trades.length*100).toFixed(0)):0}%
  - App signal win rate: ${apps.length?((appWins.length/apps.length*100).toFixed(0)):0}%
  - Own decision win rate: ${owns.length?((ownWins.length/owns.length*100).toFixed(0)):0}%

Average profit on wins: +$${avgWinPnL} (${avg(wins,t=>t.pnl_pct).toFixed(1)}%)
Average loss on losses: $${avgLossPnL} (${avg(losses,t=>t.pnl_pct).toFixed(1)}%)
Best trade: ${best ? `${best.ticker} +$${(best.pnl_dollars??0).toFixed(2)} (+${(best.pnl_pct??0).toFixed(1)}%)` : 'N/A'}
Worst trade: ${worst ? `${worst.ticker} $${(worst.pnl_dollars??0).toFixed(2)} (${(worst.pnl_pct??0).toFixed(1)}%)` : 'N/A'}

Signal data at purchase — wins vs losses:
  Avg RSI:          wins ${avg(wins,t=>t.rsi_at_buy||0).toFixed(1)}  | losses ${avg(losses,t=>t.rsi_at_buy||0).toFixed(1)}
  Avg volume ratio: wins ${avg(wins,t=>t.volume_ratio_at_buy||0).toFixed(2)}x | losses ${avg(losses,t=>t.volume_ratio_at_buy||0).toFixed(2)}x
  Avg risk score:   wins ${avg(wins,t=>t.risk_score||0).toFixed(1)}  | losses ${avg(losses,t=>t.risk_score||0).toFixed(1)}
  Avg signal score: wins ${avg(wins,t=>t.signal_score||0).toFixed(1)}  | losses ${avg(losses,t=>t.signal_score||0).toFixed(1)}

RSI at purchase — win rate by bucket:
${rsiBucket(0,45,'<45    ')}
${rsiBucket(45,55,'45–55  ')}
${rsiBucket(55,65,'55–65  ')}
${rsiBucket(65,999,'65+    ')}

Volume ratio at purchase — win rate by bucket:
${volBucket(0,1.0,'<1.0x  ')}
${volBucket(1.0,2.0,'1.0–2x ')}
${volBucket(2.0,3.0,'2–3x   ')}
${volBucket(3.0,999,'3x+    ')}

Performance by price tier:
  ${tierStats(1,3,'$1–$3')}
  ${tierStats(4,9,'$4–$9')}
  ${tierStats(10,20,'$10–$20')}

Performance by duration classification:
  ${durStats('DAY','Exit Today')}
  ${durStats('3-DAY','Est. 2-4 Days')}
  ${durStats('WEEK','Est. 5-7 Days')}

Performance by signal score at purchase:
  ${scoreStats(29,72)}
  ${scoreStats(73,115)}
  ${scoreStats(116,Infinity)}

=== MACRO CONDITION AT TIME OF PURCHASE ===
${macroCondStats('RISK_OFF',          'RISK_OFF:            ')}
${macroCondStats('GEOPOLITICAL',      'GEOPOLITICAL:        ')}
${macroCondStats('TECH_ROTATION_OUT', 'TECH_ROTATION_OUT:   ')}
${macroCondStats('BROAD_RALLY',       'BROAD_RALLY:         ')}
${macroCondStats('MOMENTUM_DAY',      'MOMENTUM_DAY:        ')}
${macroSectorWeaknessStats(          'SECTOR_WEAKNESS_*:   ')}
${macroCondStats('CHOPPY',            'CHOPPY:              ')}

=== ENTRY TIMING ANALYSIS ===

Performance by time of day at purchase:
${sessionStats('PRE_MARKET', 'Pre-market entries')}
${sessionStats('REGULAR', 'Regular session entries')}

Performance by day of week at purchase:
${dayOfWeekStats('Monday')}
${dayOfWeekStats('Tuesday')}
${dayOfWeekStats('Wednesday')}
${dayOfWeekStats('Thursday')}
${dayOfWeekStats('Friday')}

=== SUB-$10 ENTRY ADJUSTMENT ANALYSIS ===

Trades where sub-$10 bonus applied (positive adjustment):
${subTenBucketStats(subTenBonus)}

Trades where sub-$10 penalty applied (negative adjustment):
${subTenBucketStats(subTenPenalty)}

Trades where no sub-$10 adjustment ($10+ stocks):
${subTenBucketStats(subTenNone)}

=== GROQ PRE-BUY ANALYSIS ACCURACY ===

${groqSection}

=== EXIT TIMING ANALYSIS ===

Distance from target at time of sale:
${distBucket(d => d > 10, 'Sold more than 10% below target:')}
${distBucket(d => d >= 5 && d <= 10, 'Sold 5-10% below target:')}
${distBucket(d => d > 0 && d < 5, 'Sold within 5% of target:')}
${distBucket(d => d <= 0, 'Sold at or above target:')}

Average distance from target at sale across all trades: ${avgDist!=null?`${avgDist}%`:'N/A'}

=== MOMENTUM PROTECTION ===

Trades where Momentum Protection activated: ${momentumTrades.length}
Avg outcome on those trades: ${momentumTrades.length ? avg(momentumTrades, x=>x.pnl_pct).toFixed(1) : '—'}%

=== CATALYST SETUP ANALYSIS ===

${(() => {
    const flagged = trades.filter(x => x.catalyst_setup);
    const nonFlagged = trades.filter(x => !x.catalyst_setup);
    if (!flagged.length) return `  Total flagged trades: 0\n  No archived trades with the catalyst_setup flag yet.`;
    const flaggedW = flagged.filter(x => x.pnl_pct > 0);
    const bestF = flagged.reduce((a,b) => b.pnl_pct > a.pnl_pct ? b : a);
    const worstF = flagged.reduce((a,b) => b.pnl_pct < a.pnl_pct ? b : a);
    return `  Total flagged trades: ${flagged.length}
  Win rate on flagged trades: ${(flaggedW.length/flagged.length*100).toFixed(0)}%
  Avg outcome on flagged trades: ${avg(flagged,x=>x.pnl_pct).toFixed(1)}%
  Avg outcome on non-flagged trades: ${nonFlagged.length?avg(nonFlagged,x=>x.pnl_pct).toFixed(1):'—'}%
  Best flagged trade: ${bestF.ticker} ${bestF.pnl_pct>=0?'+':''}${bestF.pnl_pct.toFixed(1)}%
  Worst flagged trade: ${worstF.ticker} ${worstF.pnl_pct>=0?'+':''}${worstF.pnl_pct.toFixed(1)}%`;
  })()}

=== RATING SNAPSHOTS BY TICKER ===

${snapTickers.length ? snapTickers.map(t => `  ${t.padEnd(8)} ${snapByTicker[t]} snapshot${snapByTicker[t]===1?'':'s'}`).join('\n') : '  No rating snapshots recorded yet.'}

=== FULL TRADE HISTORY ===

`;

  trades.forEach((t, i) => {
    const subTenLine = t.sub10_adjustment == null ? 'N/A' : `${t.sub10_adjustment >= 0 ? '+' : ''}${t.sub10_adjustment} pts`;
    const distLine = t.distance_from_target == null
      ? 'N/A'
      : t.distance_from_target >= 0
        ? `${t.distance_from_target.toFixed(1)}% below target`
        : `${Math.abs(t.distance_from_target).toFixed(1)}% above target`;
    const daysHeld = (t.buy_date && t.sell_date)
      ? Math.round((new Date(t.sell_date) - new Date(t.buy_date)) / 86400000)
      : null;

    report += `Trade #${i+1}
  Ticker: ${t.ticker} — ${t.company || t.ticker}
  Bought: $${(t.buy_price??0).toFixed(2)} on ${t.buy_date}
  Sold: $${(t.sell_price??0).toFixed(2)} on ${t.sell_date}
  Shares: ${t.shares} | Days held: ${daysHeld ?? 'N/A'}
  Result: ${(t.pnl_dollars??0)>=0?'WIN':'LOSS'} $${(t.pnl_dollars??0).toFixed(2)} (${(t.pnl_pct??0).toFixed(1)}%)
  Source: ${t.source || 'N/A'}
  Signal score at purchase: ${t.signal_score ?? 'N/A'}/100 (${t.signal_label || 'N/A'})
  RSI at purchase: ${t.rsi_at_buy!=null?t.rsi_at_buy.toFixed(1):'N/A'}
  Volume ratio at purchase: ${t.volume_ratio_at_buy!=null?t.volume_ratio_at_buy.toFixed(2):'N/A'}x
  Risk score at purchase: ${t.risk_score ?? 'N/A'}/10
  Duration classification: ${t.duration_classification || 'N/A'}
  Price tier: ${t.price_tier || 'N/A'}
  Macro condition at purchase: ${t.macro_condition || 'N/A'}
  Catalyst setup at purchase: ${t.catalyst_setup ? 'Yes' : 'No'}
  Buy time: ${t.buy_time ? `${t.buy_time} Pacific (${t.buy_day_of_week}, ${t.buy_session})` : 'N/A'}
  Sell time: ${t.sell_time ? `${t.sell_time} Pacific (${t.sell_day_of_week})` : 'N/A'}
  Sub-$10 entry adjustment: ${subTenLine}
  Groq at purchase: ${t.groq_at_purchase || 'Not run'}
  Distance from target at sale: ${distLine}
  Momentum protection activated: ${t.momentum_protection ? 'Yes' : 'No'}

`;
  });

  return report;
}

async function exportAndArchiveDatabase() {
  try {
    const { data: trades, error: tradesErr } = await supabaseClient
      .from('trades').select('*').order('buy_date', { ascending: true });
    if (tradesErr) throw tradesErr;
    if (!trades || !trades.length) { alert('No trades in Supabase to archive yet.'); return; }

    let snapshotRows = [];
    try {
      const { data, error } = await supabaseClient.from('rating_snapshots').select('ticker, captured_at');
      if (!error && data) snapshotRows = data;
    } catch(e) {}

    const report = buildSupabaseArchiveReport(trades, snapshotRows);
    const blob = new Blob([report], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `edge2-archive-${new Date().toISOString().split('T')[0]}.txt`;
    a.click();
    URL.revokeObjectURL(url);

    showConfirm(
      'Archive downloaded. Delete rating snapshots older than 90 days to free up space?',
      deleteOldRatingSnapshots,
      'Delete'
    );
  } catch(e) {
    alert('Could not export archive: ' + e.message);
  }
}

async function deleteOldRatingSnapshots() {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const { error, count } = await supabaseClient
      .from('rating_snapshots')
      .delete({ count: 'exact' })
      .lt('captured_at', cutoff);
    if (error) { alert('Could not delete old snapshots: ' + error.message); return; }
    alert(`Done. ${count ?? 0} old snapshots removed.`);
    loadDatabaseUsage();
  } catch(e) {
    alert('Could not delete old snapshots: ' + e.message);
  }
}

function togglePw(id) {
  const el = document.getElementById(id);
  if (el) el.type = el.type === 'password' ? 'text' : 'password';
}

function saveApiKeys() {
  state.settings.alpacaKey    = document.getElementById('set-alpaca-key')?.value.trim() || '';
  state.settings.alpacaSecret = document.getElementById('set-alpaca-secret')?.value.trim() || '';
  state.settings.groqKey      = document.getElementById('set-groq-key')?.value.trim() || '';
  persistApiKeys();
  alert('API keys saved.');
}

async function saveBudget() {
  const prev = state.settings.budget;
  state.settings.budget = parseFloat(document.getElementById('set-budget')?.value) || 500;
  try {
    await saveSettingsToSupabase(state.settings);
  } catch(e) {
    state.settings.budget = prev;
    alert('Could not save budget to Supabase: ' + e.message);
    return;
  }
  updateBudgetBar();
  alert('Budget saved.');
}

async function savePref(key, val) {
  const prev = state.settings[key];
  state.settings[key] = val;
  try {
    await saveSettingsToSupabase(state.settings);
  } catch(e) {
    state.settings[key] = prev;
    alert('Could not save setting to Supabase: ' + e.message);
    renderSettingsTab();
  }
}

// TESTING ONLY — see getMarketStatus()/isPreMarketHours() overrides above.
async function toggleForcePreMarketMode(checked) {
  state.settings.forcePreMarketMode = checked;
  try {
    await saveSettingsToSupabase(state.settings);
  } catch(e) {
    state.settings.forcePreMarketMode = !checked;
    alert('Could not save setting to Supabase: ' + e.message);
    renderSettingsTab();
    return;
  }
  updateMarketBanner();
}

async function setMinVol(val) {
  const prev = state.settings.minVolume;
  state.settings.minVolume = val;
  try {
    await saveSettingsToSupabase(state.settings);
  } catch(e) {
    state.settings.minVolume = prev;
    alert('Could not save setting to Supabase: ' + e.message);
  }
  renderSettingsTab();
}

async function testConnections() {
  const el = document.getElementById('test-results');
  if (!el) return;
  el.innerHTML = `<div class="test-result"><span class="spinner"></span> Testing…</div>`;

  // Save keys first
  state.settings.alpacaKey    = document.getElementById('set-alpaca-key')?.value.trim() || state.settings.alpacaKey;
  state.settings.alpacaSecret = document.getElementById('set-alpaca-secret')?.value.trim() || state.settings.alpacaSecret;
  state.settings.groqKey      = document.getElementById('set-groq-key')?.value.trim() || state.settings.groqKey;
  persistApiKeys();

  const [alpOk, groqOk, supaOk] = await Promise.all([testAlpacaConnection(), testGroqConnection(), testSupabaseConnection()]);
  el.innerHTML = `<div class="test-result">
    <span class="${alpOk?'test-ok':'test-err'}">${alpOk?'✓':'✗'} Alpaca ${alpOk?'connected':'failed'}</span>
    <span class="${groqOk?'test-ok':'test-err'}">${groqOk?'✓':'✗'} Groq ${groqOk?'connected':'failed'}</span>
    <span class="${supaOk?'test-ok':'test-err'}">${supaOk?'✓':'✗'} Supabase ${supaOk?'connected':'failed'}</span>
  </div>`;
}

// Sources fresh from Supabase rather than in-memory state (Data Migration
// project, Step 7) — portfolio/settings via the same functions app init
// uses, trades via the same query/mapper generateClaudeReport() uses for its
// localStorage fallback. Never touches localStorage, so this still works
// after Step 6's cleanup has wiped the old local copies. Output JSON shape
// (version/exported/settings/portfolio/sold keys, redacted key placeholders)
// is unchanged from before — only the data source moved.
async function exportAllData(btn) {
  if (btn) btn.disabled = true;
  try {
    const [portfolio, settings, tradesRes] = await Promise.all([
      loadPortfolioFromSupabase(),
      loadSettingsFromSupabase(),
      supabaseClient.from('trades').select('*').order('buy_date', { ascending: true }),
    ]);
    if (tradesRes.error) throw tradesRes.error;

    const data = {
      version: VERSION,
      exported: new Date().toISOString(),
      settings: { ...(settings || {}), alpacaKey:'[REDACTED]', alpacaSecret:'[REDACTED]', groqKey:'[REDACTED]' },
      portfolio,
      sold: (tradesRes.data || []).map(mapSupabaseTradeToSoldShape),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `edge-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch(e) {
    alert('Could not export data from Supabase: ' + e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function clearAllData() {
  showConfirm('Are you sure? This will delete your portfolio and trade history. This cannot be undone.', () => {
    ['settings','portfolio','sold','signals','lastScanTime','news','lastPassedCount'].forEach(k => {
      localStorage.removeItem('edge_' + k);
    });
    TICKERS = MASTER_TICKERS;
    loadState();
    renderSettingsTab();
    updateNavBadges();
    alert('All data cleared.');
  });
}

function confirmForceUpdate() {
  showConfirm('This will reload the app to get the latest version. Your portfolio and trade data will not be affected.', forceUpdateApp);
}

// Clears the PWA's Cache Storage and unregisters the service worker so a stale
// cached app.js can't keep getting served (Android Chrome/PWA installs can
// hold onto an old build well past the normal HTTP cache window). Deliberately
// never touches localStorage — that's where settings/portfolio/trade
// history/API keys live, and this is a cache fix, not a data reset.
async function forceUpdateApp() {
  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch(e) { console.warn('Force update cleanup error', e.message); }
  window.location.reload(true);
}

// ── 21. PUSH NOTIFICATIONS ───────────────────────────────────────

let _swRegistration = null;
let _notifPriceInterval = null;
let _notifDailyInterval = null;
let _notifNextCheckTime = null;
const NOTIF_PRICE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    _swRegistration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch(e) {
    console.warn('SW registration failed:', e.message);
  }
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  state.notifications.permission = Notification.permission;
  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    state.notifications.permission = result;
    persist('notifications');
  }
}

function isMarketHoursNow() {
  const pt = getPT();
  const tMin = pt.getHours() * 60 + pt.getMinutes();
  return isTradingDay(pt) && tMin >= 390 && tMin < 780; // 6:30am–1:00pm PT
}

function businessDaysBetween(startDateStr, endDateStr) {
  const start = new Date(startDateStr + 'T12:00:00');
  const end   = new Date(endDateStr   + 'T12:00:00');
  let count = 0;
  const cur = new Date(start);
  while (cur < end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

function isDuplicateAlert(ticker, condition) {
  const last = (state.notifications.alertHistory || {})[ticker + '_' + condition];
  return last && (Date.now() - last) < 60 * 60 * 1000;
}

function recordAlert(ticker, condition) {
  if (!state.notifications.alertHistory) state.notifications.alertHistory = {};
  state.notifications.alertHistory[ticker + '_' + condition] = Date.now();
  persist('notifications');
}

async function sendNotification(title, body, tag) {
  if (Notification.permission !== 'granted') return;
  const opts = { body, tag, icon: './icon.svg', badge: './icon.svg', requireInteraction: false };
  if (_swRegistration) {
    try { await _swRegistration.showNotification(title, opts); return; } catch(e) {}
  }
  try { new Notification(title, opts); } catch(e) {}
}

async function checkPriceAlerts() {
  if (!state.notifications.enabled) return;
  if (Notification.permission !== 'granted') return;
  if (!isMarketHoursNow()) return;
  if (!state.settings.alpacaKey || !state.settings.alpacaSecret) return;
  if (!state.portfolio.length) return;

  state.notifications.lastPriceCheck = new Date().toISOString();
  persist('notifications');

  try {
    const tickers = [...new Set(state.portfolio.map(p => p.ticker))];
    const snaps = await fetchSnapshots(tickers);

    for (const pos of state.portfolio) {
      const snap = snaps[pos.ticker];
      if (!snap) continue;
      const price = getLivePrice(snap);
      if (!price) continue;

      const { ticker, target, stop } = pos;

      if (price >= target) {
        if (!isDuplicateAlert(ticker, 'TARGET_HIT')) {
          await sendNotification('EDGE Alert',
            `🎯 ${ticker} hit your target of $${target.toFixed(2)}! SELL NOW to lock in profits.`,
            `${ticker}_TARGET_HIT`);
          recordAlert(ticker, 'TARGET_HIT');
        }
      } else if (price >= target * 0.95) {
        const pct = ((target - price) / target * 100).toFixed(1);
        if (!isDuplicateAlert(ticker, 'TARGET_NEAR')) {
          await sendNotification('EDGE Alert',
            `⚠ ${ticker} is ${pct}% from your target of $${target.toFixed(2)}. Consider taking profits soon.`,
            `${ticker}_TARGET_NEAR`);
          recordAlert(ticker, 'TARGET_NEAR');
        }
      }

      if (price <= stop) {
        if (!isDuplicateAlert(ticker, 'STOP_HIT')) {
          await sendNotification('EDGE Alert',
            `🔴 ${ticker} hit your stop loss of $${stop.toFixed(2)}! SELL NOW to limit losses.`,
            `${ticker}_STOP_HIT`);
          recordAlert(ticker, 'STOP_HIT');
        }
      } else if (price <= stop * 1.05) {
        const pct = ((price - stop) / stop * 100).toFixed(1);
        if (!isDuplicateAlert(ticker, 'STOP_NEAR')) {
          await sendNotification('EDGE Alert',
            `⚠ ${ticker} is ${pct}% from your stop loss of $${stop.toFixed(2)}. Watch closely.`,
            `${ticker}_STOP_NEAR`);
          recordAlert(ticker, 'STOP_NEAR');
        }
      }
    }
  } catch(e) {
    console.warn('Price alert check failed:', e.message);
  }
}

async function checkTimeLimitAlerts() {
  if (!state.notifications.enabled) return;
  if (Notification.permission !== 'granted') return;
  if (!state.portfolio.length) return;

  const todayStr = ptDateStr(getPT());

  for (const pos of state.portfolio) {
    const { ticker, duration, buyDate } = pos;
    let threshold = null, durationLabel = '';
    if (duration === '3-DAY')     { threshold = 4; durationLabel = 'Est. 2-4 Days'; }
    else if (duration === 'WEEK') { threshold = 7; durationLabel = 'Est. 5-7 Days'; }
    else continue; // 'DAY' — no time limit alert

    const daysHeld = businessDaysBetween(buyDate, todayStr);
    if (daysHeld > threshold && !isDuplicateAlert(ticker, 'TIME_LIMIT')) {
      await sendNotification('EDGE Alert',
        `📅 ${ticker} has been held ${daysHeld} days. Your estimated duration was ${durationLabel}. Consider selling today before market open.`,
        `${ticker}_TIME_LIMIT`);
      recordAlert(ticker, 'TIME_LIMIT');
    }
  }
}

function toggleNotifications(enabled) {
  state.notifications.enabled = enabled;
  persist('notifications');
}

function startNotificationChecks() {
  _notifNextCheckTime = Date.now() + 3000;
  setTimeout(() => {
    checkPriceAlerts();
    _notifNextCheckTime = Date.now() + NOTIF_PRICE_INTERVAL_MS;
  }, 3000);

  _notifPriceInterval = setInterval(() => {
    checkPriceAlerts();
    _notifNextCheckTime = Date.now() + NOTIF_PRICE_INTERVAL_MS;
  }, NOTIF_PRICE_INTERVAL_MS);

  _notifDailyInterval = setInterval(() => {
    const pt = getPT();
    if (pt.getHours() === 0 && pt.getMinutes() === 1) {
      const todayStr = ptDateStr(pt);
      if (state.notifications.lastDailyCheck !== todayStr) {
        state.notifications.lastDailyCheck = todayStr;
        persist('notifications');
        checkTimeLimitAlerts();
      }
    }
  }, 60000);
}

// ── 22. NAVIGATION ────────────────────────────────────────────────

function switchTab(name) {
  state.activeTab = name;

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });

  const showBudget = ['signals','portfolio'].includes(name);
  document.getElementById('budget-bar')?.classList.toggle('hidden', !showBudget);

  switch (name) {
    case 'signals':   renderSignalsTab();   break;
    case 'portfolio': renderPortfolioTab(); break;
    case 'sold':      renderSoldTab();      break;
    case 'settings':  renderSettingsTab();  break;
  }

  updateBudgetBar();
}

function updateNavBadges() {
  // Portfolio: count active sell warnings
  const pfBadge = document.getElementById('badge-portfolio');
  if (pfBadge) {
    let warnCount = 0;
    if (isAfternoonMode()) {
      state.portfolio.forEach(p => {
        const price = state.portfolioPrices[p.ticker] || p.buyPrice;
        const currentSignal = state.signals.find(s => s.ticker === p.ticker) || state.ownedScores[p.ticker] || null;
        const result = calcUnifiedRecommendation({ ...p, currentPrice: price, rsi: p.rsiAtBuy }, currentSignal, state.macroContext);
        if (result.hardFloor || ['SELL NOW', 'SELL SOON', 'CONSIDER SELLING', 'LOCK IN PROFITS'].includes(result.label)) warnCount++;
      });
    }
    pfBadge.textContent = warnCount;
    pfBadge.classList.toggle('hidden', warnCount === 0);
  }
}

// ── 23. CLOCK / REFRESH ───────────────────────────────────────────

function startClock() {
  updateMarketBanner();
  updateNavBadges();
  setInterval(() => {
    updateMarketBanner();
    updateNavBadges();
  }, 30000); // every 30 seconds
}

// ── 24. INIT ─────────────────────────────────────────────────────

// Fetches Portfolio and Settings from Supabase and populates state with
// them (Data Migration project, Step 4). A missing settings row or an empty
// portfolio table is a normal "nothing migrated yet" state, not a failure —
// state.settings keeps the defaults loadState() already filled in, and
// state.portfolio just stays []. A real Supabase error propagates up to the
// caller, which is what drives the error-with-retry screen rather than a
// silent localStorage fallback.
async function loadPortfolioAndSettingsFromSupabase() {
  const [portfolio, settings] = await Promise.all([
    loadPortfolioFromSupabase(),
    loadSettingsFromSupabase(),
  ]);
  state.portfolio = portfolio;
  if (settings) Object.assign(state.settings, settings);
}

function renderDataLoadingScreen() {
  document.body.innerHTML = `
    <div class="pin-screen">
      <div class="pin-title">EDGE2</div>
      <div class="pin-subtitle">Loading your data…</div>
      <div style="margin-top:24px"><span class="spinner"></span></div>
    </div>`;
}

function renderDataLoadErrorScreen(message) {
  document.body.innerHTML = `
    <div class="pin-screen">
      <div class="pin-title">EDGE2</div>
      <div class="pin-subtitle" style="color:var(--red)">Couldn't load your data</div>
      <div class="pin-error" style="display:block;margin-top:8px">${message}</div>
      <button class="pin-submit" style="margin-top:24px" onclick="retryDataLoad()">Retry</button>
    </div>`;
}

async function retryDataLoad() {
  await runDataLoadAndInit();
}

// Permanently removes the old localStorage portfolio/settings entries.
// Only ever called after a successful Supabase fetch (never on failure —
// a failed fetch means Supabase couldn't be confirmed as having the data,
// so the old copy stays put rather than being destroyed for nothing). By
// this point loadState()'s one-time self-heal has already migrated any
// legacy embedded API keys into edge_apiKeys, so this can safely wipe
// edge_settings in full without touching the keys.
function clearLegacyPortfolioSettingsStorage() {
  localStorage.removeItem('edge_portfolio');
  localStorage.removeItem('edge_settings');
}

async function runDataLoadAndInit() {
  renderDataLoadingScreen();
  try {
    await loadPortfolioAndSettingsFromSupabase();
  } catch(e) {
    renderDataLoadErrorScreen(e.message || 'Unknown error — check your connection and try again.');
    return;
  }
  clearLegacyPortfolioSettingsStorage();
  document.body.innerHTML = APP_SHELL_HTML;
  await registerServiceWorker();
  await requestNotificationPermission();
  startClock();
  startNotificationChecks();
  renderSignalsTab();
  updateNavBadges();
}

async function init() {
  loadState();
  await runDataLoadAndInit();
}

if (isPinVerified()) {
  init();
} else {
  renderPinScreen();
}

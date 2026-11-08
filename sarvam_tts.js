#!/usr/bin/env node
/**
 * sarvam_tts.js  —  Pre-generate Telugu audio for Twolingo using Sarvam AI (Bulbul v3).
 *
 * WHY PRE-GENERATE (instead of calling the API from the browser):
 *   * Your API key never ships in the HTML (calling Sarvam client-side would expose it).
 *   * The phrase set is finite (~180 short clips), so you pay once, then playback is
 *     instant and works offline.
 *   * No CORS, no per-tap latency.
 *
 * WHAT IT DOES:
 *   1. Parses index.html and collects every Telugu string the app speaks
 *      (phrase cards, scenario lines, and the sentence-builder combinations).
 *   2. Calls Sarvam TTS once per unique string, saving WAV clips into ./audio/.
 *   3. Writes audio-manifest.js  ->  window.TWOLINGO_AUDIO = { "<telugu>": "<src>", ... }.
 *      The app already includes this file and will prefer these clips, falling back to
 *      the device voice for anything missing.
 *
 * USAGE:
 *   npm install            # optional: only needed if you want node-fetch on older Node.
 *   export SARVAM_API_KEY="your_key_here"        # get one free at dashboard.sarvam.ai
 *   node sarvam_tts.js                            # writes ./audio/*.wav + audio-manifest.js
 *   node sarvam_tts.js --inline                   # embed audio as base64 data-URIs in the
 *                                                 #   manifest (bigger file, but fully
 *                                                 #   self-contained + works over file://)
 *
 * DEPLOY:
 *   Ship index.html, audio-manifest.js, and (unless --inline) the ./audio/ folder
 *   together. Re-run this script whenever you add or change phrases; it skips clips that
 *   already exist, so it's cheap to re-run.
 *
 * Requires Node 18+ (global fetch). On older Node, `npm install node-fetch` and uncomment
 * the import below.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// For Node < 18, uncomment:
// const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ---- config -------------------------------------------------------------------
const HTML_FILE   = 'index.html';
const AUDIO_DIR   = 'audio';
const MANIFEST_JS = 'audio-manifest.js';
const API_URL     = 'https://api.sarvam.ai/text-to-speech';
const LANG        = 'te-IN';
const MODEL       = 'bulbul:v3';
const SPEAKER     = 'priya';    // <-- must be a bulbul:v3 voice. Valid options:
                                //     female: priya, neha, kavya, pooja, ritu, simran
                                //     male:   aditya, rahul, rohan, amit, dev, ashutosh
const PACE        = 0.9;        // slightly slowed for learners (0.5-2.0)
const INLINE      = process.argv.includes('--inline');
// -------------------------------------------------------------------------------

const KEY = '' + (process.env.SARVAM_API_KEY || '').trim();
if (!KEY) {
  console.error('Set SARVAM_API_KEY in your environment (get one at dashboard.sarvam.ai).');
  process.exit(1);
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function hasTelugu(t) {
  for (const ch of t) {
    if (ch >= '\u0c00' && ch <= '\u0c7f') return true;
  }
  return false;
}

// Grab the substring between two markers (Python's html[a:b] with .index()).
function slice(html, startMarker, endMarker) {
  const a = html.indexOf(startMarker);
  if (a === -1) throw new Error(`marker not found: ${startMarker}`);
  const b = html.indexOf(endMarker, a);
  if (b === -1) throw new Error(`marker not found: ${endMarker}`);
  return html.slice(a, b);
}

function matchAll(re, str) {
  const out = [];
  let m;
  // ensure global flag
  const rx = re.global ? re : new RegExp(re.source, re.flags + 'g');
  while ((m = rx.exec(str)) !== null) {
    out.push(m[1]);
    if (m.index === rx.lastIndex) rx.lastIndex++;
  }
  return out;
}

function collectStrings(html) {
  // Every Telugu string the app actually sends to speak().
  let out = [];

  // 1) phrase cards: 3rd field of each ["cat","eng","<TE>","<ro>", ...] tuple
  const pblock = slice(html, 'const P = [', '].map((r,i)');
  out = out.concat(matchAll(/\["[^"]*","[^"]*","([^"]*)","[^"]*"/g, pblock));
  // 1b) "hear back" replies: every te:"..." inside the P block (the optional 6th element)
  out = out.concat(matchAll(/te:"([^"]*)"/g, pblock));

  // 1c) Hyderabad dialect forms: te:"..." inside DIALECT
  const dia = slice(html, 'const DIALECT={', '\n};');
  out = out.concat(matchAll(/te:"([^"]*)"/g, dia));

  // 2) scenario lines: te:"..." inside SCEN
  const scen = slice(html, 'const SCEN=[', 'const scenRoot');
  out = out.concat(matchAll(/te:"([^"]*)"/g, scen));

  // 3) sentence-builder combos: every noun.te + " " + frame.te
  const bn = slice(html, 'const BNOUNS=[', 'const BFRAMES=');
  const bf = slice(html, 'const BFRAMES=[', 'const buildRoot');
  const nouns  = matchAll(/te:"([^"]*)"/g, bn);
  const frames = matchAll(/te:"([^"]*)"/g, bf);
  for (const n of nouns) for (const f of frames) out.push(`${n} ${f}`);

  // dedupe, keep only strings that contain Telugu (skip pure-English like "ATM" alone —
  // though combos like "ATM ఎంత?" DO contain Telugu and are kept, which is what we want)
  const seen = new Set();
  const uniq = [];
  for (let t of out) {
    t = t.trim();
    if (t && hasTelugu(t) && !seen.has(t)) {
      seen.add(t);
      uniq.push(t);
    }
  }
  return uniq;
}

async function synth(text) {
  // Return WAV bytes (Buffer) for one string, or null on soft failure.
  const body = {
    text,
    target_language_code: LANG,
    model: MODEL,
    speaker: SPEAKER,
    pace: PACE,
    enable_preprocessing: true,
  };

  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'api-subscription-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });

  if (r.status === 429) {
    console.log('   rate-limited, waiting 5s...');
    await sleep(5000);
    return synth(text);
  }
  if (r.status !== 200) {
    const txt = await r.text();
    console.log(`   ! ${r.status}: ${txt.slice(0, 200)}`);
    if (r.status === 401 || r.status === 403) {
      console.error('Auth failed — check SARVAM_API_KEY.');
      process.exit(1);
    }
    if ((r.status === 400 || r.status === 422) && txt.toLowerCase().includes('speaker')) {
      console.error(`Speaker '${SPEAKER}' rejected — set a valid voice at the top of this script.`);
      process.exit(1);
    }
    return null;
  }

  const json = await r.json();
  const audios = json.audios || [];
  return audios.length ? Buffer.from(audios.join(''), 'base64') : null;
}

async function main() {
  const html = fs.readFileSync(HTML_FILE, 'utf-8');
  const strings = collectStrings(html);
  const totalChars = strings.reduce((s, t) => s + t.length, 0);
  console.log(
    `${strings.length} unique clips, ${totalChars} characters ` +
    `(~Rs.${(totalChars / 10000 * 30).toFixed(2)} one-time at Rs.30/10K).`
  );
  if (!INLINE && !fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

  const manifest = {};
  let made = 0, skipped = 0, failed = 0;

  for (let i = 0; i < strings.length; i++) {
    const t = strings[i];
    const h = crypto.createHash('md5').update(t, 'utf-8').digest('hex').slice(0, 12);

    if (INLINE) {
      // (re-synthesise every run in inline mode; no on-disk cache)
      const data = await synth(t);
      if (data === null) { failed++; continue; }
      manifest[t] = 'data:audio/wav;base64,' + data.toString('base64');
      made++;
    } else {
      const filePath = `${AUDIO_DIR}/${h}.wav`;
      manifest[t] = filePath;
      if (fs.existsSync(filePath)) {
        skipped++;
      } else {
        const data = await synth(t);
        if (data === null) { failed++; delete manifest[t]; continue; }
        fs.writeFileSync(filePath, data);
        made++;
        await sleep(250);  // gentle on rate limits
      }
    }

    if ((i + 1) % 20 === 0) console.log(`   ${i + 1}/${strings.length}...`);
  }

  fs.writeFileSync(
    MANIFEST_JS,
    'window.TWOLINGO_AUDIO = ' + JSON.stringify(manifest) + ';\n',
    'utf-8'
  );

  console.log(`\nDone. made=${made} skipped=${skipped} failed=${failed}`);
  console.log(`Wrote ${MANIFEST_JS}` + (INLINE ? '' : ` + ${AUDIO_DIR}/*.wav`));
  console.log('Open index.html — the Hear buttons now use Sarvam Telugu.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

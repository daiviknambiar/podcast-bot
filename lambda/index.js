/* eslint-disable no-use-before-define */
'use strict';

const Alexa = require('ask-sdk-core');
const { S3PersistenceAdapter } = require('ask-sdk-s3-persistence-adapter');
const { DynamoDbPersistenceAdapter } = require('ask-sdk-dynamodb-persistence-adapter');
const AWS = require('aws-sdk');
const https = require('https');
const {
  FEED_URL,
  LOOKBACK_SECONDS,
  GEMINI_MODEL,
  ENABLE_GOOGLE_GROUNDING,
  GEMINI_FALLBACK_MODELS,
  OPENAI_MODEL,
  OPENAI_FALLBACK_MODELS,
  RESUME_WITH_DIRECTIVE
} = require('./config');

let GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
let OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
let PODBOT_WEBHOOK_URL = process.env.PODBOT_WEBHOOK_URL || null;
let PODBOT_WEBHOOK_KEY = process.env.PODBOT_WEBHOOK_KEY || null;
let PODBOT_AUTH_HEADER = process.env.PODBOT_AUTH_HEADER || 'Authorization';
// Soft-cache flags for quota/feature availability in this container
let GROUNDING_BLOCKED_UNTIL_TS = 0; // ms epoch
let OPENAI_BLOCKED_UNTIL_TS = 0; // ms epoch
try {
  // Loaded at deploy-time by the workflow; never committed
  // module.exports = { GEMINI_API_KEY: '...' }
  const localKey = require('./gemini-key.js');
  if (localKey && localKey.GEMINI_API_KEY) { GEMINI_API_KEY = localKey.GEMINI_API_KEY; }
  if (localKey && localKey.OPENAI_API_KEY) { OPENAI_API_KEY = localKey.OPENAI_API_KEY; }
  if (localKey && localKey.PODBOT_WEBHOOK_URL) { PODBOT_WEBHOOK_URL = localKey.PODBOT_WEBHOOK_URL; }
  if (localKey && localKey.PODBOT_WEBHOOK_KEY) { PODBOT_WEBHOOK_KEY = localKey.PODBOT_WEBHOOK_KEY; }
  if (localKey && localKey.PODBOT_AUTH_HEADER) { PODBOT_AUTH_HEADER = localKey.PODBOT_AUTH_HEADER; }
} catch (e) {
  // ignored - file does not exist in repo
}

// ---------- Utilities (HTTPS only) ----------
function httpRequest(options, bodyBuffer, { timeoutMs = 6000, maxRedirects = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const visited = [];
    function doReq(opts, redirectsLeft) {
      const req = https.request(opts, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          const nextUrl = new URL(res.headers.location, `${opts.protocol}//${opts.hostname}`).toString();
          visited.push(nextUrl);
          const next = new URL(nextUrl);
          const nextOpts = {
            protocol: next.protocol,
            hostname: next.hostname,
            port: next.port || (next.protocol === 'https:' ? 443 : 80),
            path: next.pathname + (next.search || ''),
            method: opts.method,
            headers: opts.headers || {}
          };
          // Ensure current response is drained to avoid socket hangups
          try { res.resume(); } catch {}
          doReq(nextOpts, redirectsLeft - 1);
          return;
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ statusCode: res.statusCode, headers: res.headers, body: buf, redirects: visited });
        });
        res.on('error', (e) => reject(e));
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('Request timed out'));
      });
      if (bodyBuffer) req.write(bodyBuffer);
      req.end();
    }
    doReq(options, maxRedirects);
  });
}

async function httpGet(url, headers = {}, timeoutMs = 6000, maxRedirects = 10) {
  const u = new URL(url);
  const options = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + (u.search || ''),
    method: 'GET',
    headers
  };
  return httpRequest(options, null, { timeoutMs, maxRedirects });
}

async function httpHead(url, headers = {}, timeoutMs = 6000, maxRedirects = 10) {
  const u = new URL(url);
  const options = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + (u.search || ''),
    method: 'HEAD',
    headers
  };
  return httpRequest(options, null, { timeoutMs, maxRedirects });
}

function parseRssFirstItem(xml) {
  // Very light-weight parse: only first <item> block
  const itemMatch = xml.match(/<item[\s\S]*?<\/item>/i);
  if (!itemMatch) return null;
  const itemXml = itemMatch[0];
  function getTag(tag) {
    const m = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? decodeHtml(m[1].trim()) : null;
  }
  function getEnclosureUrl() {
    const m = itemXml.match(/<enclosure[^>]*url="([^"]+)"/i);
    return m ? m[1] : null;
  }
  const title = getTag('title');
  const guid = getTag('guid') || title;
  const description = getTag('description') || getTag('itunes:summary') || '';
  const enclosureUrl = getEnclosureUrl();
  return { title, guid, description, enclosureUrl, itemXml };
}

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchFeedFirstItem(feedUrl) {
  // Stream until first </item> to keep memory low
  const u = new URL(feedUrl);
  const options = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + (u.search || ''),
    method: 'GET',
    headers: { 'User-Agent': 'PodcastBot/1.0' }
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Feed HTTP ${res.statusCode}`));
        return;
      }
      let xml = '';
      let done = false;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        xml += chunk;
        if (xml.toLowerCase().includes('</item>')) {
          // Resolve immediately with the first item parsed to avoid waiting for 'end'
          if (!done) {
            done = true;
            try {
              const item = parseRssFirstItem(xml);
              if (!item) {
                reject(new Error('No item found in RSS'));
              } else {
                resolve(item);
              }
            } catch (e) {
              reject(e);
            }
          }
          try { res.destroy(); } catch {}
        }
      });
      res.on('end', () => {
        if (done) return;
        const item = parseRssFirstItem(xml);
        if (!item) {
          reject(new Error('No item found in RSS'));
        } else {
          resolve(item);
        }
      });
      res.on('error', (e) => { if (!done) reject(e); });
    });
    req.on('error', reject);
    req.setTimeout(6000, () => req.destroy(new Error('Feed request timed out')));
    req.end();
  });
}

async function resolveFinalMp3Url(initialUrl) {
  // Follow redirects to final HTTPS MP3
  const head = await httpHead(initialUrl, { 'User-Agent': 'PodcastBot/1.0' }, 6000, 5);
  let finalUrl = initialUrl;
  if (head.redirects && head.redirects.length) {
    finalUrl = head.redirects[head.redirects.length - 1];
  }
  const contentType = head.headers['content-type'] || '';
  if (!/audio\/mpeg/i.test(contentType) && !finalUrl.endsWith('.mp3')) {
    // do a GET to confirm
    const get = await httpGet(initialUrl, { 'User-Agent': 'PodcastBot/1.0', Range: 'bytes=0-0' }, 6000, 5);
    if (get.redirects && get.redirects.length) {
      finalUrl = get.redirects[get.redirects.length - 1];
    }
  }
  const urlObj = new URL(finalUrl);
  if (urlObj.protocol !== 'https:') {
    urlObj.protocol = 'https:';
    finalUrl = urlObj.toString();
  }
  // Try to get content length
  let contentLength = null;
  const headFinal = await httpHead(finalUrl, { 'User-Agent': 'PodcastBot/1.0' }).catch(() => null);
  if (headFinal && headFinal.headers && headFinal.headers['content-length']) {
    contentLength = parseInt(headFinal.headers['content-length'], 10);
  }
  return { finalUrl, contentLength };
}

function synchsafeToInt(b3, b2, b1, b0) {
  return ((b3 & 0x7f) << 21) | ((b2 & 0x7f) << 14) | ((b1 & 0x7f) << 7) | (b0 & 0x7f);
}

function parseId3v2HeaderSize(buf) {
  if (buf.length < 10) return 0;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size = synchsafeToInt(buf[6], buf[7], buf[8], buf[9]);
    return 10 + size;
  }
  return 0;
}

const BITRATE_TABLE = {
  // layer III, version 1 (most podcasts)
  0b11: { // version 1
    0b01: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] // kbps, index 1..14
  },
  // version 2/2.5 with layer III
  0b10: { 0b01: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] },
  0b00: { 0b01: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] }
};

async function probeMp3Metadata(url) {
  // Read first 128KB to parse ID3 + first MPEG frame for CBR bitrate
  const rangeEnd = 128 * 1024 - 1;
  const res = await httpGet(url, { 'User-Agent': 'PodcastBot/1.0', Range: `bytes=0-${rangeEnd}` }, 6000, 5);
  if (res.statusCode !== 206 && res.statusCode !== 200) throw new Error(`Probe HTTP ${res.statusCode}`);
  const buf = res.body;
  const id3Size = parseId3v2HeaderSize(buf);
  // Find first frame sync 0xFFE within next 4KB
  let pos = id3Size;
  const maxSearch = Math.min(buf.length - 4, id3Size + 4096);
  let bitrateKbps = null;
  for (; pos < maxSearch; pos++) {
    if (buf[pos] === 0xff && (buf[pos + 1] & 0xe0) === 0xe0) {
      const versionBits = (buf[pos + 1] >> 3) & 0b11;
      const layerBits = (buf[pos + 1] >> 1) & 0b11;
      const bitrateIndex = (buf[pos + 2] >> 4) & 0b1111;
      const versionTable = BITRATE_TABLE[versionBits];
      if (versionTable && versionTable[layerBits] && bitrateIndex > 0 && bitrateIndex < 15) {
        bitrateKbps = versionTable[layerBits][bitrateIndex];
        break;
      }
    }
  }
  if (!bitrateKbps) {
    // Fallback to common podcast bitrate
    bitrateKbps = 128;
  }
  const bytesPerSecond = Math.round((bitrateKbps * 1000) / 8);
  return { id3Size, bitrateKbps, bytesPerSecond, firstFrameOffset: pos };
}

// Injectable indirections for testing
let fetchFeedFirstItemImpl = fetchFeedFirstItem;
let resolveFinalMp3UrlImpl = resolveFinalMp3Url;
let probeMp3MetadataImpl = probeMp3Metadata;

async function fetchMp3Range(url, startByte, endByteInclusive) {
  const headers = {
    'User-Agent': 'PodcastBot/1.0',
    Range: `bytes=${startByte}-${endByteInclusive}`
  };
  const res = await httpGet(url, headers, 6500, 10);
  if (res.statusCode !== 206 && res.statusCode !== 200) throw new Error(`Range HTTP ${res.statusCode}`);
  return res.body;
}

function trimToFrameSync(buf) {
  for (let i = 0; i < Math.max(0, buf.length - 4); i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      return buf.slice(i);
    }
  }
  return buf;
}

function normalizeModelName(name) {
  if (!name) return '';
  return name.startsWith('models/') ? name.slice('models/'.length) : name;
}

async function callOpenAIAnswer({ question, notes, model = OPENAI_MODEL, totalBudgetMs = 1200 }) {
  if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY (env or lambda/gemini-key.js)');
  if (Date.now() < OPENAI_BLOCKED_UNTIL_TS) {
    throw new Error('OpenAI blocked');
  }
  const host = 'api.openai.com';
  const path = '/v1/chat/completions';
  const systemPrompt =
    'You are PodBot. Answer clearly in 2–4 short spoken sentences. ' +
    'Use general knowledge first, then any provided episode notes as extra context. ' +
    'No markdown, no code blocks, no links.';
  const userText =
    (question ? `Question: ${question}\n` : '') +
    (notes ? `Episode notes (may be incomplete): ${notes.slice(0, 1200)}` : '');
  async function doCall({ useModel = model, timeoutMs = 1400 }) {
    const body = JSON.stringify({
      model: useModel,
      max_tokens: 200,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText || 'Answer briefly.' }
      ]
    });
    const options = {
      protocol: 'https:',
      hostname: host,
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${OPENAI_API_KEY}`
      }
    };
    return httpRequest(options, Buffer.from(body), { timeoutMs, maxRedirects: 0 });
  }
  const TOTAL_BUDGET_MS = Math.max(400, Number(totalBudgetMs) || 1200);
  const startTs = Date.now();
  const chain = [model].concat(Array.isArray(OPENAI_FALLBACK_MODELS) ? OPENAI_FALLBACK_MODELS : []);
  for (const useModel of chain) {
    const elapsed = Date.now() - startTs;
    const remaining = Math.max(0, TOTAL_BUDGET_MS - elapsed);
    if (remaining < 400) break;
    const timeoutMs = Math.max(600, Math.min(1100, remaining - 100));
    let res;
    try {
      res = await doCall({ useModel, timeoutMs });
    } catch (err) {
      console.error('OpenAI attempt error', { model: useModel, error: (err && err.message) || String(err) });
      continue;
    }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try {
        const data = JSON.parse(res.body.toString('utf8'));
        const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
        if (text.trim()) {
          console.log('OpenAI used model', useModel);
          return text.trim();
        }
      } catch (e) {
        console.error('OpenAI parse error', { model: useModel, error: (e && e.message) || String(e) });
      }
    } else {
      const bodyTxt = (res.body || Buffer.from('')).toString('utf8').slice(0, 300);
      console.error('OpenAI non-2xx', { model: useModel, status: res.statusCode, body: bodyTxt });
      if (res.statusCode === 429) {
        OPENAI_BLOCKED_UNTIL_TS = Date.now() + 60 * 60 * 1000; // 1 hour soft block
        break;
      }
      if (res.statusCode === 404) continue;
    }
  }
  throw new Error('OpenAI HTTP 503');
}

async function callGeminiAnswer({ question, hint, audioBase64, notes, model = GEMINI_MODEL, totalBudgetMs = 6000, preferGrounding = false }) {
  if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY (env or lambda/gemini-key.js)');
  }
  const host = 'generativelanguage.googleapis.com';
  const pathFor = (m) => `/v1beta/models/${encodeURIComponent(normalizeModelName(m))}:generateContent`;
  function buildGeminiParts({ q, hint, episodeNotes, audio }) {
    const guidance =
      'You are PodBot. Answer concisely in 1–2 spoken sentences. No markdown, no links.\n' +
      '- If the user\'s question is about this specific episode, the podcast, or the hosts, or uses pronouns like "they", "this", "that", or "it", then use the episode audio snippets and notes below as context.\n' +
      '- Otherwise, treat it as a general-knowledge question and answer directly without recapping the episode unless it is directly relevant. If the information is time-sensitive and you are not certain, briefly say you may not have the latest.\n';
    const asked =
      (q ? `The user asked (wh-word may be missing): ${q}\n` : '') +
      (hint && hint !== q ? `Utterance hint: ${hint}\n` : '');
    const notesText = episodeNotes ? `Episode notes (may be incomplete): ${episodeNotes.slice(0, 1200)}\n` : '';
    const parts = [{ text: guidance + asked + notesText }];
    if (audio && typeof audio === 'object' && (audio.recent || audio.upcoming)) {
      if (audio.recent) {
        parts.push({ text: 'Recent audio snippet (~last 75 seconds):' });
        parts.push({ inlineData: { mimeType: 'audio/mpeg', data: audio.recent } });
      }
      if (audio.upcoming) {
        parts.push({ text: 'Upcoming audio snippet (~next 90 seconds):' });
        parts.push({ inlineData: { mimeType: 'audio/mpeg', data: audio.upcoming } });
      }
    } else if (audio) {
      parts.push({ inlineData: { mimeType: 'audio/mpeg', data: audio } });
    }
    return parts;
  }
  const parts = buildGeminiParts({ q: question, hint, episodeNotes: notes, audio: audioBase64 });
  if (audioBase64 && typeof audioBase64 === 'object' && (audioBase64.recent || audioBase64.upcoming)) {
    if (audioBase64.recent) {
      parts.push({ text: 'Recent audio snippet (~last 75 seconds):' });
      parts.push({ inlineData: { mimeType: 'audio/mpeg', data: audioBase64.recent } });
    }
    if (audioBase64.upcoming) {
      parts.push({ text: 'Upcoming audio snippet (~next 90 seconds):' });
      parts.push({ inlineData: { mimeType: 'audio/mpeg', data: audioBase64.upcoming } });
    }
  } else if (audioBase64) {
    parts.push({ inlineData: { mimeType: 'audio/mpeg', data: audioBase64 } });
  }
  async function doCall({ withGrounding, useModel = model, timeoutMs = 2200 }) {
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 120
      }
    };
    if (withGrounding) {
      // Attempt Google Search grounding; some models may ignore or reject
      body.tools = [{ googleSearchRetrieval: {} }];
    }
    const payload = JSON.stringify(body);
    const options = {
      protocol: 'https:',
      hostname: host,
      port: 443,
      path: pathFor(useModel),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-goog-api-key': GEMINI_API_KEY
      }
    };
    const res = await httpRequest(options, Buffer.from(payload), { timeoutMs, maxRedirects: 0 });
    return res;
  }
  // Attempt chain with front-loaded timeout for first attempt
  const TOTAL_BUDGET_MS = Math.max(1200, Number(totalBudgetMs) || 6000);
  const startTs = Date.now();
  const chain = [model].concat(Array.isArray(GEMINI_FALLBACK_MODELS) ? GEMINI_FALLBACK_MODELS : []);
  for (let idx = 0; idx < chain.length; idx++) {
    const useModel = chain[idx];
    const tryGroundingFirst = (preferGrounding || !!ENABLE_GOOGLE_GROUNDING) && (Date.now() >= GROUNDING_BLOCKED_UNTIL_TS);
    const attemptGrounding = tryGroundingFirst ? [true, false] : [false];
    for (const withGrounding of attemptGrounding) {
      const elapsed = Date.now() - startTs;
      const remaining = Math.max(0, TOTAL_BUDGET_MS - elapsed);
      if (remaining < 400) break; // not enough time left
      // Ensure at least ~1.5s remains for a subsequent attempt
      if (idx >= 1 && remaining < 1500) break;
      // First attempt up to ~5s (subject to remaining), subsequent ~1.8s
      const desired = idx === 0 ? 5000 : 1800;
      const timeoutMs = Math.max(700, Math.min(desired, remaining - 200));
      let res;
      try {
        res = await doCall({ withGrounding, useModel, timeoutMs });
      } catch (err) {
        console.error('Gemini attempt error', { model: useModel, grounding: withGrounding, error: (err && err.message) || String(err) });
        // try next attempt or next model
        continue;
      }
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const data = JSON.parse(res.body.toString('utf8'));
        const outParts = (((data || {}).candidates || [])[0] || {}).content?.parts || [];
        const text = outParts.map((p) => p.text).filter(Boolean).join(' ').trim();
        return text || 'Sorry, I could not determine that.';
      }
      const bodyTxt = (res.body || Buffer.from('')).toString('utf8').slice(0, 600);
      console.error('Gemini attempt non-2xx', { model: useModel, grounding: withGrounding, status: res.statusCode, body: bodyTxt });
      if (res.statusCode === 404) break; // skip to next model
      if (res.statusCode === 429 || res.statusCode === 403 || res.statusCode === 400) {
        if (withGrounding) {
          // Cache that grounding is unavailable and try ungrounded immediately
          GROUNDING_BLOCKED_UNTIL_TS = Date.now() + 60 * 60 * 1000; // 1 hour soft block
          continue; // move to ungrounded attempt
        } else {
          break; // move to next model
        }
      }
      // otherwise, try without grounding (if not already), then continue/fallback
    }
  }
  // All attempts failed
  throw new Error('Gemini HTTP 503');
}

async function getAnswer({ question, audioBase64, notes, hint, budgetMs = 6000, preferGrounding = false }) {
  // Prefer Gemini (grounding off) when key is present
  const start = Date.now();
  if (GEMINI_API_KEY) {
    try {
      return await callGeminiAnswer({ question, hint, audioBase64, notes, model: GEMINI_MODEL, totalBudgetMs: budgetMs, preferGrounding });
    } catch (e) {
      console.error('Gemini chain failed', (e && e.message) || String(e));
    }
  }
  // Fallback to OpenAI when key present and enough budget remains
  const remaining = Math.max(0, budgetMs - (Date.now() - start));
  if (OPENAI_API_KEY && remaining >= 1500) {
    try {
      return await callOpenAIAnswer({ question: hint || question, notes, model: OPENAI_MODEL, totalBudgetMs: Math.min(1200, remaining) });
    } catch (e) {
      console.error('OpenAI chain failed', (e && e.message) || String(e));
    }
  } else if (OPENAI_API_KEY) {
    console.log('Skipping OpenAI due to low remaining budget:', remaining, 'ms');
  }
  // All providers failed or timed out
  console.error('All providers exhausted or timed out');
  return 'Sorry, that took too long. Try asking again.';
}

async function sendProgressiveResponse(handlerInput, speech) {
  try {
    const requestId = Alexa.getRequestId(handlerInput.requestEnvelope);
    const apiEndpoint = handlerInput.requestEnvelope.context?.System?.apiEndpoint || 'https://api.amazonalexa.com';
    const apiAccessToken = handlerInput.requestEnvelope.context?.System?.apiAccessToken;
    if (!apiAccessToken) return;
    const payload = JSON.stringify({
      header: { requestId },
      directive: {
        type: 'VoicePlayer.Speak',
        speech
      }
    });
    const u = new URL(apiEndpoint);
    const options = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: '/v1/directives',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiAccessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    await httpRequest(options, Buffer.from(payload), { timeoutMs: 1000, maxRedirects: 0 });
  } catch {
    // ignore progressive response errors
  }
}

// ---------- Persistence ----------
function getPersistenceAdapter() {
  const tableName = process.env.DYNAMODB_PERSISTENCE_TABLE_NAME;
  const region = process.env.DYNAMODB_PERSISTENCE_REGION;
  if (tableName && region) {
    const dynamoDBClient = new AWS.DynamoDB({ region });
    return new DynamoDbPersistenceAdapter({
      tableName,
      createTable: false,
      dynamoDBClient
    });
  }
  const bucketName = process.env.S3_PERSISTENCE_BUCKET;
  if (bucketName) {
    return new S3PersistenceAdapter({ bucketName });
  }
  return {
    async getPersistentAttributes() { return {}; },
    setPersistentAttributes() {},
    async savePersistentAttributes() {}
  };
}

// ---------- Helpers for state ----------
async function getState(attributesManager) {
  const attrs = await attributesManager.getPersistentAttributes() || {};
  return attrs;
}

async function saveState(attributesManager, state) {
  attributesManager.setPersistentAttributes(state || {});
  await attributesManager.savePersistentAttributes();
}

function buildPlayDirective(url, token, offsetMs) {
  return {
    type: 'AudioPlayer.Play',
    playBehavior: 'REPLACE_ALL',
    audioItem: {
      stream: {
        token,
        url,
        offsetInMilliseconds: Math.max(0, Math.floor(offsetMs || 0)),
        expectedPreviousToken: null
      },
      metadata: {}
    }
  };
}

function getLatestOffsetMs(requestEnvelope, state) {
  try {
    const ctx = requestEnvelope?.context?.AudioPlayer || {};
    const playerActivity = ctx.playerActivity;
    const ctxOffset = typeof ctx.offsetInMilliseconds === 'number' ? ctx.offsetInMilliseconds : null;
    // Prefer context offset when available
    if (ctxOffset != null) {
      console.log('Offset (context):', ctxOffset, 'activity:', playerActivity || '<none>');
      return ctxOffset;
    }
  } catch (e) {
    // ignore
  }
  const saved = state && typeof state.lastOffsetMs === 'number' ? state.lastOffsetMs : 0;
  console.log('Offset (saved state):', saved);
  return saved || 0;
}

// ---------- Intent Handlers ----------
const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  async handle(handlerInput) {
    const speakOutput =
      'Welcome to PodBot. Say, play Morning Brew, or ask what did I just miss.';
    return handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt('Say, play Morning Brew.')
      .getResponse();
  }
};

const PlayPodcastIntentHandler = {
  canHandle(handlerInput) {
    const { requestEnvelope } = handlerInput;
    const type = Alexa.getRequestType(requestEnvelope);
    if (type !== 'IntentRequest') return false;
    const intentName = Alexa.getIntentName(requestEnvelope) || '';
    return intentName === 'PlayPodcastIntent';
  },
  async handle(handlerInput) {
    // Optional slot 'podcast' (defaults to Morning Brew)
    try {
      const p = Alexa.getSlotValue(handlerInput.requestEnvelope, 'podcast') || '';
      if (!p) { console.log('PlayPodcastIntent: empty podcast slot, defaulting to Morning Brew'); }
      else { console.log('PlayPodcastIntent: podcast slot received:', String(p).slice(0, 80)); }
    } catch {}
    const attributesManager = handlerInput.attributesManager;
    console.log('PlayPodcast: before getState');
    const state = await getState(attributesManager);
    console.log('PlayPodcast: after getState');
    try {
      console.log('PlayPodcast: before fetchFeedFirstItem', FEED_URL);
      const item = await fetchFeedFirstItemImpl(FEED_URL);
      console.log('PlayPodcast: after fetchFeedFirstItem — title:', (item && item.title || '').slice(0, 120));
      if (!item || !item.enclosureUrl) {
        throw new Error('Feed item missing enclosure');
      }
      // Low-latency path: use the enclosure URL directly; Alexa will follow redirects.
      // Defer expensive resolve/probe until needed by Q&A.
      const finalUrl = item.enclosureUrl;
      const meta = { id3Size: 0, bitrateKbps: 128, bytesPerSecond: Math.round((128 * 1000) / 8) };
      const token = item.guid || item.title || finalUrl;

      // Flush pending batch if switching episodes
      if (state.lastUrl && state.lastUrl !== finalUrl && Array.isArray(state.questionsPending) && state.questionsPending.length > 0) {
        console.log('PlayPodcast: flushing pending questions on episode change');
        await tryPostAndMaybeClear(state, 'episodeChange');
        await saveState(attributesManager, state);
      }

      const sameEpisode =
        !!state.lastUrl && state.lastUrl === finalUrl;
      // Choose safest resume offset when same episode
      let resumeOffset = 0;
      if (sameEpisode) {
        const ctx = handlerInput.requestEnvelope?.context?.AudioPlayer || {};
        const ctxOffset = typeof ctx.offsetInMilliseconds === 'number' ? ctx.offsetInMilliseconds : null;
        const saved = typeof state.lastOffsetMs === 'number' ? state.lastOffsetMs : 0;
        // Guard: do not overwrite a non-zero saved offset with a zero context offset
        resumeOffset = (ctxOffset && ctxOffset > 0) ? ctxOffset : (saved > 0 ? saved : 0);
        console.log('PlayPodcast resume decision:', { ctxOffset, saved, resumeOffset });
      }

      // Save current episode metadata for resume and Q&A
      const newState = {
        lastToken: token,
        lastUrl: finalUrl,
        lastTitle: item.title || 'Morning Brew Daily',
        lastNotes: item.description || '',
        id3Size: meta.id3Size,
        bitrateKbps: meta.bitrateKbps,
        bytesPerSecond: meta.bytesPerSecond,
        lastOffsetMs: resumeOffset
      };
      console.log('PlayPodcast: before saveState');
      await saveState(attributesManager, newState);
      console.log('PlayPodcast: after saveState');

      try {
        const host = new URL(finalUrl).host;
        console.log('PlayPodcast resolved:', (item.title || '').slice(0, 120), 'host:', host);
      } catch {}

      const directive = buildPlayDirective(finalUrl, token, resumeOffset);
      const response = handlerInput.responseBuilder
        .speak(resumeOffset > 0 ? 'Resuming Morning Brew Daily.' : 'Playing the latest Morning Brew Daily.')
        .addDirective(directive)
        .withShouldEndSession(true)
        .getResponse();
      // Log outgoing response envelope (truncate and redact query strings)
      try {
        const clone = JSON.parse(JSON.stringify(response));
        if (Array.isArray(clone.directives)) {
          for (const d of clone.directives) {
            if (d && d.type === 'AudioPlayer.Play' && d.audioItem && d.audioItem.stream && typeof d.audioItem.stream.url === 'string') {
              const u = new URL(d.audioItem.stream.url);
              d.audioItem.stream.url = `${u.protocol}//${u.host}${u.pathname}`;
            }
          }
        }
        const out = JSON.stringify(clone).slice(0, 500);
        console.log('PlayPodcast response (truncated):', out);
      } catch (e) {
        console.log('PlayPodcast response log error:', (e && e.message) || String(e));
      }
      return response;
    } catch (err) {
      console.error('PlayPodcast error:', err);
      return handlerInput.responseBuilder
        .speak('Sorry, I could not start the podcast right now.')
        .reprompt('You can say, play Morning Brew.')
        .getResponse();
    }
  }
};

async function handleOpenQuestion(handlerInput, questionFromUser, carrierWord) {
  const { requestEnvelope } = handlerInput;
  const attributesManager = handlerInput.attributesManager;
  const playerActivity = requestEnvelope.context?.AudioPlayer?.playerActivity || 'IDLE';
  const wasPlaying = ['PLAYING', 'PAUSED', 'STOPPED'].includes(playerActivity);
  const state = await getState(attributesManager);
  const url = state.lastUrl;
  const offsetMs = getLatestOffsetMs(requestEnvelope, state);

  try { console.log('OpenQuestion text:', String(questionFromUser || '').slice(0, 100)); } catch {}
  await sendProgressiveResponse(handlerInput, 'One sec.');

  let answer = 'Sorry, I could not get that.';
  try {
    const qText = (questionFromUser || '').toString().trim();
    if (!qText) {
      return handlerInput.responseBuilder
        .speak('What would you like to know?')
        .reprompt('What would you like to know?')
        .getResponse();
    }
    const qaStart = Date.now();
    // Helper: time-bound any async step
    const withTimeout = (p, ms, label) => {
      let t;
      return Promise.race([
        new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out`)), ms); }),
        p.finally(() => { if (t) clearTimeout(t); })
      ]);
    };
    let audioBase64 = null;
    // Only fetch episode snippet when question likely refers to episode/podcast/hosts
    const isEpisodeQuestion = /\b(they|this|that|it|episode|podcast|host|hosts)\b/i.test(`${carrierWord || ''} ${qText}`);
    if (url && isEpisodeQuestion) {
      try {
        const id3Size = state.id3Size ?? 0;
        const bytesPerSecond = state.bytesPerSecond ?? 16000; // assume ~128kbps if unknown
        const lookbackMs = Math.min(60000, (LOOKBACK_SECONDS || 75) * 1000); // cap ~60s
        const startMs = Math.max(0, (offsetMs || 0) - lookbackMs);
        const startByte = id3Size + Math.max(0, Math.floor((startMs / 1000) * bytesPerSecond));
        const endByte = startByte + Math.max(2048, Math.floor((lookbackMs / 1000) * bytesPerSecond)) - 1;
        const rangeBuf = await withTimeout(fetchMp3Range(url, startByte, endByte), 900, 'fetchMp3Range');
        const trimmed = trimToFrameSync(rangeBuf);
        const recentB64 = trimmed.toString('base64');
        audioBase64 = { recent: recentB64 };
      } catch (e) {
        console.log('Q&A: audio snippet skipped:', (e && e.message) || String(e));
      }
    }
    const answerCaller = (typeof global.__overrideGetAnswer === 'function') ? global.__overrideGetAnswer : getAnswer;
    const QA_TOTAL_MS = 6600;
    const elapsed = Date.now() - qaStart;
    const remainingForLLM = Math.max(800, QA_TOTAL_MS - elapsed);
    const hint = carrierWord ? `${carrierWord} ${qText}` : qText;
    // Bound the entire answer generation to remainingForLLM
    answer = await withTimeout(
      answerCaller({
        question: qText,
        hint,
        audioBase64,
        notes: state.lastNotes || '',
        budgetMs: remainingForLLM,
        preferGrounding: !isEpisodeQuestion
      }),
      Math.max(700, remainingForLLM - 100),
      'getAnswer'
    );
  } catch (err) {
    console.error('OpenQuestion error:', err);
    if ((err && String(err).includes('getAnswer')) || (err && String(err).includes('timed out'))) {
      answer = 'Sorry, that took too long. Try asking again.';
    } else {
      answer = 'Sorry, I could not analyze that just now.';
    }
  }

  // Log question and confirm once
  try {
    const persisted = await getState(attributesManager);
    const list = Array.isArray(persisted.questionsPending) ? persisted.questionsPending : [];
    const mmss = formatMmSs(offsetMs || 0);
    list.push({
      question: (questionFromUser || '').toString(),
      timestamp: mmss,
      alexaAnswer: answer,
      episodeTitle: persisted.lastTitle || '',
      episodeUrl: persisted.lastUrl || ''
    });
    persisted.questionsPending = list;
    try {
      console.log('Q&A final answer (truncated):', String(answer || '').slice(0, 300));
    } catch {}
    if (!persisted.questionConfirmSpoken) {
      answer = `${answer} I'll send a deeper recap of your questions when the episode's done.`;
      persisted.questionConfirmSpoken = true;
    }
    await saveState(attributesManager, persisted);
  } catch (e) {
    console.error('Question log error:', e);
  }

  const rb = handlerInput.responseBuilder.speak(answer);
  if (wasPlaying && state.lastUrl && state.lastToken != null) {
    const resumeOffset = getLatestOffsetMs(handlerInput.requestEnvelope, state);
    console.log('Q&A resume candidate: url=', state.lastUrl, 'token=', state.lastToken, 'offsetMs=', resumeOffset);
    // Persist the offset seen
    try {
      state.lastOffsetMs = resumeOffset;
      await saveState(attributesManager, state);
      console.log('Saved offset after Q&A:', resumeOffset);
    } catch (e) {
      console.log('Save offset after Q&A failed:', e && e.message);
    }
    if (RESUME_WITH_DIRECTIVE) {
      // Use a fresh token to avoid device ignoring a replay
      const freshToken = `${state.lastToken}|resume|${Date.now()}`;
      state.lastToken = freshToken;
      await saveState(attributesManager, state);
      const directive = buildPlayDirective(state.lastUrl, freshToken, resumeOffset);
      return rb.addDirective(directive).withShouldEndSession(true).getResponse();
    }
    // Let Alexa auto-resume without directive
    return rb.withShouldEndSession(true).getResponse();
  }
  return rb.reprompt('You can say, play Morning Brew.').getResponse();
}

const AskAboutIntentHandler = {
  canHandle(handlerInput) {
    const { requestEnvelope } = handlerInput;
    const type = Alexa.getRequestType(requestEnvelope);
    if (type !== 'IntentRequest') return false;
    const intentName = Alexa.getIntentName(requestEnvelope) || '';
    return intentName === 'AskAboutIntent';
  },
  async handle(handlerInput) {
    const topic = Alexa.getSlotValue(handlerInput.requestEnvelope, 'topic') || '';
    return handleOpenQuestion(handlerInput, topic);
  }
};

const OpenQuestionIntentHandler = {
  canHandle(handlerInput) {
    const { requestEnvelope } = handlerInput;
    const type = Alexa.getRequestType(requestEnvelope);
    if (type !== 'IntentRequest') return false;
    const intentName = Alexa.getIntentName(requestEnvelope) || '';
    return intentName === 'OpenQuestionIntent';
  },
  async handle(handlerInput) {
    const slots = handlerInput.requestEnvelope?.request?.intent?.slots || {};
    const qRaw = Alexa.getSlotValue(handlerInput.requestEnvelope, 'q') || (slots && slots.q && slots.q.value) || '';
    try { console.log('Slot q received:', String(qRaw || '').slice(0, 100)); } catch {}
    return handleOpenQuestion(handlerInput, qRaw, null);
  }
};

// Proxy handlers to capture the carrier/wh-word and delegate
function makeCarrierHandler(intentName, carrierWord) {
  return {
    canHandle(handlerInput) {
      const type = Alexa.getRequestType(handlerInput.requestEnvelope);
      if (type !== 'IntentRequest') return false;
      const name = Alexa.getIntentName(handlerInput.requestEnvelope) || '';
      return name === intentName;
    },
    async handle(handlerInput) {
      const slots = handlerInput.requestEnvelope?.request?.intent?.slots || {};
      const qRaw = Alexa.getSlotValue(handlerInput.requestEnvelope, 'q') || (slots && slots.q && slots.q.value) || '';
      try { console.log(`${intentName} slot q:`, String(qRaw || '').slice(0, 100)); } catch {}
      return handleOpenQuestion(handlerInput, qRaw, carrierWord);
    }
  };
}
const WhoIntentHandler = makeCarrierHandler('WhoIntent', 'who is');
const WhatIntentHandler = makeCarrierHandler('WhatIntent', 'what is');
const WhyIntentHandler = makeCarrierHandler('WhyIntent', 'why is');
const HowIntentHandler = makeCarrierHandler('HowIntent', 'how');
const ExplainIntentHandler = makeCarrierHandler('ExplainIntent', 'explain');
const DefineIntentHandler = makeCarrierHandler('DefineIntent', 'define');
const GeneralQueryIntentHandler = makeCarrierHandler('GeneralQueryIntent', null);

const PauseIntentHandler = {
  canHandle(handlerInput) {
    const type = Alexa.getRequestType(handlerInput.requestEnvelope);
    if (type !== 'IntentRequest') return false;
    const name = Alexa.getIntentName(handlerInput.requestEnvelope) || '';
    return (name === 'AMAZON.PauseIntent' || name === 'AMAZON.StopIntent' || name === 'AMAZON.CancelIntent');
  },
  async handle(handlerInput) {
    try {
      const state = await getState(handlerInput.attributesManager);
      const off = getLatestOffsetMs(handlerInput.requestEnvelope, state);
      state.lastOffsetMs = off;
      await saveState(handlerInput.attributesManager, state);
      console.log('PauseIntent: saved offset', off);
      if (Array.isArray(state.questionsPending) && state.questionsPending.length > 0) {
        await tryPostAndMaybeClear(state, 'stop');
        await saveState(handlerInput.attributesManager, state);
      }
    } catch (e) {
      console.error('Flush on stop error:', e);
    }
    return handlerInput.responseBuilder
      .addAudioPlayerStopDirective()
      .withShouldEndSession(true)
      .getResponse();
  }
};

const ResumeIntentHandler = {
  canHandle(handlerInput) {
    const type = Alexa.getRequestType(handlerInput.requestEnvelope);
    if (type !== 'IntentRequest') return false;
    const name = Alexa.getIntentName(handlerInput.requestEnvelope) || '';
    return (name === 'AMAZON.ResumeIntent' || name === 'ResumeAliasIntent');
  },
  async handle(handlerInput) {
    const state = await getState(handlerInput.attributesManager);
    if (state.lastUrl && state.lastToken != null) {
      const directive = buildPlayDirective(state.lastUrl, state.lastToken, state.lastOffsetMs || 0);
      return handlerInput.responseBuilder
        .speak('Resuming.')
        .addDirective(directive)
        .withShouldEndSession(true)
        .getResponse();
    }
    return handlerInput.responseBuilder
      .speak('There is nothing to resume. Say, play Morning Brew.')
      .reprompt('Say, play Morning Brew.')
      .getResponse();
  }
};

const SimpleResponseIntentHandler = {
  canHandle(handlerInput) {
    const type = Alexa.getRequestType(handlerInput.requestEnvelope);
    if (type !== 'IntentRequest') return false;
    const name = Alexa.getIntentName(handlerInput.requestEnvelope) || '';
    const simpleIntents = new Set([
      'AMAZON.HelpIntent',
      'AMAZON.FallbackIntent',
      'AMAZON.NavigateHomeIntent',
      'AMAZON.StartOverIntent',
      'AMAZON.NextIntent',
      'AMAZON.PreviousIntent',
      'AMAZON.RepeatIntent',
      'AMAZON.LoopOnIntent',
      'AMAZON.LoopOffIntent',
      'AMAZON.ShuffleOnIntent',
      'AMAZON.ShuffleOffIntent'
    ]);
    return type === 'IntentRequest' && simpleIntents.has(name);
  },
  async handle(handlerInput) {
    const name = Alexa.getIntentName(handlerInput.requestEnvelope) || '';
    let speakOutput = '';
    const rb = handlerInput.responseBuilder;
    const withReprompt = () => rb.reprompt('You can say, play Morning Brew.').getResponse();
    switch (name) {
      case 'AMAZON.HelpIntent':
        speakOutput = 'Say, play Morning Brew, or ask me a question like, what is compute.';
        return rb.speak(speakOutput).reprompt('You can say, play Morning Brew.').getResponse();
      case 'AMAZON.FallbackIntent':
        // Log and ask for the question explicitly rather than calling Gemini with empty
        try {
          const type = Alexa.getRequestType(handlerInput.requestEnvelope);
          const intentName = Alexa.getIntentName(handlerInput.requestEnvelope);
          console.log('Fallback invoked:', 'type=', type, 'intent=', intentName);
        } catch {}
        return handlerInput.responseBuilder
          .speak("Sorry, I didn't catch that. Try saying, what is a webhook, or who is Ada Lovelace.")
          .reprompt('For example, say: what is a webhook.')
          .getResponse();
      case 'AMAZON.StartOverIntent':
        return (async () => {
          const state = await getState(handlerInput.attributesManager);
          if (state.lastUrl && state.lastToken != null) {
            const directive = buildPlayDirective(state.lastUrl, state.lastToken, 0);
            return rb.speak('Playing from the start.').addDirective(directive).withShouldEndSession(true).getResponse();
          }
          return rb.speak('Nothing to restart yet. Say, play Morning Brew.').reprompt('Say, play Morning Brew.').getResponse();
        })();
      default:
        speakOutput = 'Only the latest episode is supported.';
        return rb.speak(speakOutput).reprompt('You can say, play Morning Brew.').getResponse();
    }
  }
};

// AudioPlayer event handlers
const PlaybackStartedHandler = {
  canHandle(handlerInput) {
    const type = Alexa.getRequestType(handlerInput.requestEnvelope);
    return type === 'AudioPlayer.PlaybackStarted';
  },
  async handle(handlerInput) {
    // No speech; update last offset to what Alexa reports
    const token = handlerInput.requestEnvelope.request?.token;
    const offset = handlerInput.requestEnvelope.request?.offsetInMilliseconds || 0;
    const state = await getState(handlerInput.attributesManager);
    state.lastToken = token || state.lastToken;
    state.lastOffsetMs = offset;
    await saveState(handlerInput.attributesManager, state);
    return handlerInput.responseBuilder.getResponse();
  }
};

const PlaybackStoppedHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'AudioPlayer.PlaybackStopped';
  },
  async handle(handlerInput) {
    const token = handlerInput.requestEnvelope.request?.token;
    const offset = handlerInput.requestEnvelope.request?.offsetInMilliseconds || 0;
    const state = await getState(handlerInput.attributesManager);
    state.lastToken = token || state.lastToken;
    state.lastOffsetMs = offset;
    console.log('PlaybackStopped: saved offset', offset);
    await saveState(handlerInput.attributesManager, state);
    return handlerInput.responseBuilder.getResponse();
  }
};

const PlaybackNearlyFinishedHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'AudioPlayer.PlaybackNearlyFinished';
  },
  async handle(handlerInput) {
    try {
      const state = await getState(handlerInput.attributesManager);
      const ctx = handlerInput.requestEnvelope?.request;
      const off = typeof ctx?.offsetInMilliseconds === 'number' ? ctx.offsetInMilliseconds : null;
      if (off != null) {
        state.lastOffsetMs = off;
        await saveState(handlerInput.attributesManager, state);
        console.log('PlaybackNearlyFinished: saved offset', off);
      }
    } catch (e) {
      console.log('NearlyFinished save error:', e && e.message);
    }
    return handlerInput.responseBuilder.getResponse();
  }
};

const PlaybackFinishedHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'AudioPlayer.PlaybackFinished';
  },
  async handle(handlerInput) {
    const state = await getState(handlerInput.attributesManager);
    // Clear offset on finish
    state.lastOffsetMs = 0;
    // Flush pending questions
    try {
      if (Array.isArray(state.questionsPending) && state.questionsPending.length > 0) {
        await tryPostAndMaybeClear(state, 'finished');
      }
    } catch (e) {
      console.error('Flush on finish error:', e);
    }
    await saveState(handlerInput.attributesManager, state);
    console.log('PlaybackFinished: cleared offset to 0');
    return handlerInput.responseBuilder.getResponse();
  }
};

const PlaybackFailedHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'AudioPlayer.PlaybackFailed';
  },
  handle(handlerInput) {
    // Log and move on
    const req = handlerInput.requestEnvelope.request || {};
    console.error('PlaybackFailed:', {
      token: req.token,
      error: req.error || {},
      currentPlaybackState: req.currentPlaybackState || {}
    });
    return handlerInput.responseBuilder.getResponse();
  }
};

const SystemExceptionEncounteredHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'System.ExceptionEncountered';
  },
  handle(handlerInput) {
    try {
      const r = handlerInput.requestEnvelope.request || {};
      console.error('System.ExceptionEncountered:', {
        error: r.error || {},
        cause: r.cause || {}
      });
    } catch (e) {
      console.error('System.ExceptionEncountered log error:', e && e.message);
    }
    return handlerInput.responseBuilder.getResponse();
  }
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },
  handle(handlerInput) {
    try {
      const req = handlerInput.requestEnvelope?.request || {};
      const reason = req.reason || '<none>';
      const err = req.error || {};
      const errType = err.type || '<none>';
      const errMsg = err.message || '<none>';
      console.log('SessionEndedRequest:', 'reason=', reason, 'error.type=', errType, 'error.message=', errMsg);
    } catch (e) {
      console.log('SessionEnded log error:', (e && e.message) || String(e));
    }
    return handlerInput.responseBuilder.getResponse();
  }
};

// PlaybackController (hardware / app transport controls)
const PlaybackControllerHandler = {
  canHandle(handlerInput) {
    const type = Alexa.getRequestType(handlerInput.requestEnvelope);
    return typeof type === 'string' && type.startsWith('PlaybackController.');
  },
  async handle(handlerInput) {
    const type = Alexa.getRequestType(handlerInput.requestEnvelope);
    if (type === 'PlaybackController.PauseCommandIssued') {
      return handlerInput.responseBuilder.addAudioPlayerStopDirective().withShouldEndSession(true).getResponse();
    }
    if (type === 'PlaybackController.PlayCommandIssued') {
      // Resume
      const state = await getState(handlerInput.attributesManager);
      if (state.lastUrl && state.lastToken != null) {
        const directive = buildPlayDirective(state.lastUrl, state.lastToken, state.lastOffsetMs || 0);
        return handlerInput.responseBuilder.addDirective(directive).withShouldEndSession(true).getResponse();
      }
      return handlerInput.responseBuilder.speak('Nothing to play yet. Say, play Morning Brew.').getResponse();
    }
    // Next/Previous etc.
    return handlerInput.responseBuilder
      .speak('Only the latest episode is supported.')
      .reprompt('You can say, play Morning Brew.')
      .getResponse();
  }
};

const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    console.error('Error handled:', error);
    return handlerInput.responseBuilder
      .speak('Sorry, something went wrong in PodBot. Please try again.')
      .reprompt('You can say, play Morning Brew.')
      .getResponse();
  }
};

// ---------- Skill Builder ----------
const skillBuilder = Alexa.SkillBuilders.custom();

const LoggingRequestInterceptor = {
  async process(handlerInput) {
    try {
      const type = Alexa.getRequestType(handlerInput.requestEnvelope);
      if (type === 'IntentRequest') {
        const name = Alexa.getIntentName(handlerInput.requestEnvelope);
        const slots = handlerInput.requestEnvelope?.request?.intent?.slots || {};
        const snippet = JSON.stringify(slots).slice(0, 300);
        console.log('IntentRequest:', name, 'slots:', snippet);
        // Persist context offset opportunistically when audio is paused or stopped
        try {
          const ctx = handlerInput.requestEnvelope?.context?.AudioPlayer || {};
          const activity = ctx.playerActivity;
          const off = typeof ctx.offsetInMilliseconds === 'number' ? ctx.offsetInMilliseconds : null;
          const state = await getState(handlerInput.attributesManager);
          const saved = typeof state.lastOffsetMs === 'number' ? state.lastOffsetMs : 0;
          if ((activity === 'PAUSED' || activity === 'STOPPED') && off != null) {
            // Guard: avoid overwriting a non-zero saved offset with zero from context
            if (off === 0 && saved > 0) {
              console.log('Skip saving offset 0 over saved non-zero during IntentRequest; saved remains', saved);
            } else {
              state.lastOffsetMs = off;
              await saveState(handlerInput.attributesManager, state);
              console.log('Saved offset from IntentRequest context:', off, 'activity:', activity);
            }
          } else if (activity === 'PLAYING' && off != null && off > saved) {
            // Opportunistic upgrade when playing
            const state = await getState(handlerInput.attributesManager);
            state.lastOffsetMs = off;
            await saveState(handlerInput.attributesManager, state);
            console.log('Upgraded saved offset from PLAYING context:', off);
          }
        } catch (e) {
          console.log('Save offset from IntentRequest failed:', e && e.message);
        }
      } else {
        console.log('Request type:', type);
      }
    } catch (e) {
      console.log('Interceptor log error:', (e && e.message) || String(e));
    }
  }
};

// Seek forward/back intents
function parseDeltaMillis(handlerInput, defaultSeconds, forward) {
  const amountStr = Alexa.getSlotValue(handlerInput.requestEnvelope, 'amount') || '';
  let n = parseInt(String(amountStr), 10);
  if (!Number.isFinite(n) || n <= 0) n = defaultSeconds;
  const unitRaw = Alexa.getSlotValue(handlerInput.requestEnvelope, 'unit') || '';
  const unit = String(unitRaw || '').toLowerCase();
  const seconds = unit.startsWith('min') ? n * 60 : n;
  const delta = seconds * 1000;
  return forward ? delta : -delta;
}

const SkipForwardIntentHandler = {
  canHandle(handlerInput) {
    const type = Alexa.getRequestType(handlerInput.requestEnvelope);
    if (type !== 'IntentRequest') return false;
    const name = Alexa.getIntentName(handlerInput.requestEnvelope) || '';
    return name === 'SkipForwardIntent';
  },
  async handle(handlerInput) {
    const state = await getState(handlerInput.attributesManager);
    if (!state.lastUrl || state.lastToken == null) {
      return handlerInput.responseBuilder
        .speak('Nothing is playing. Say, play Morning Brew.')
        .reprompt('Say, play Morning Brew.')
        .getResponse();
    }
    const base = getLatestOffsetMs(handlerInput.requestEnvelope, state);
    const delta = parseDeltaMillis(handlerInput, 30, true);
    const next = Math.max(0, base + delta);
    console.log('Seek forward:', { base, delta, next });
    state.lastOffsetMs = next;
    await saveState(handlerInput.attributesManager, state);
    const directive = buildPlayDirective(state.lastUrl, state.lastToken, next);
    return handlerInput.responseBuilder
      .addDirective(directive)
      .withShouldEndSession(true)
      .getResponse();
  }
};

const SkipBackIntentHandler = {
  canHandle(handlerInput) {
    const type = Alexa.getRequestType(handlerInput.requestEnvelope);
    if (type !== 'IntentRequest') return false;
    const name = Alexa.getIntentName(handlerInput.requestEnvelope) || '';
    return name === 'SkipBackIntent';
  },
  async handle(handlerInput) {
    const state = await getState(handlerInput.attributesManager);
    if (!state.lastUrl || state.lastToken == null) {
      return handlerInput.responseBuilder
        .speak('Nothing is playing. Say, play Morning Brew.')
        .reprompt('Say, play Morning Brew.')
        .getResponse();
    }
    const base = getLatestOffsetMs(handlerInput.requestEnvelope, state);
    const delta = parseDeltaMillis(handlerInput, 30, false);
    const next = Math.max(0, base + delta);
    console.log('Seek back:', { base, delta, next });
    state.lastOffsetMs = next;
    await saveState(handlerInput.attributesManager, state);
    const directive = buildPlayDirective(state.lastUrl, state.lastToken, next);
    return handlerInput.responseBuilder
      .addDirective(directive)
      .withShouldEndSession(true)
      .getResponse();
  }
};

exports.handler = skillBuilder
  .withPersistenceAdapter(getPersistenceAdapter())
  .addRequestInterceptors(LoggingRequestInterceptor)
  .addRequestHandlers(
    LaunchRequestHandler,
    PlayPodcastIntentHandler,
    SkipForwardIntentHandler,
    SkipBackIntentHandler,
    SystemExceptionEncounteredHandler,
    WhoIntentHandler,
    WhatIntentHandler,
    WhyIntentHandler,
    HowIntentHandler,
    ExplainIntentHandler,
    DefineIntentHandler,
    GeneralQueryIntentHandler,
    AskAboutIntentHandler,
    OpenQuestionIntentHandler,
    PauseIntentHandler,
    ResumeIntentHandler,
    SimpleResponseIntentHandler,
    PlaybackStartedHandler,
    PlaybackStoppedHandler,
    PlaybackNearlyFinishedHandler,
    PlaybackFinishedHandler,
    PlaybackFailedHandler,
    PlaybackControllerHandler,
    SessionEndedRequestHandler
  )
  .addErrorHandlers(ErrorHandler)
  .lambda();

// ---------- Webhook + utilities ----------
function formatMmSs(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function tryPostAndMaybeClear(state, reason) {
  if (!PODBOT_WEBHOOK_URL || !PODBOT_WEBHOOK_KEY) return;
  const batch = {
    episodeTitle: state.lastTitle || '',
    episodeUrl: state.lastUrl || '',
    finishedAt: new Date().toISOString(),
    reason,
    questions: Array.isArray(state.questionsPending) ? state.questionsPending : []
  };
  if (!batch.questions || batch.questions.length === 0) return;
  const body = Buffer.from(JSON.stringify(batch));
  const u = new URL(PODBOT_WEBHOOK_URL);
  // Process webhook key: if it contains an "Authorization:" prefix, strip it and use the remainder
  let authValue = String(PODBOT_WEBHOOK_KEY || '').trim();
  try { authValue = authValue.replace(/^\s*Authorization\s*:\s*/i, '').trim(); } catch {}
  if (!/^Bearer\s+/i.test(authValue)) {
    authValue = `Bearer ${authValue}`;
  }
  // Safe debug facts only (no secrets)
  try {
    const authLen = authValue.length;
    const authBearerCrsr = /^Bearer\s+crsr_/i.test(authValue);
    const urlStr = PODBOT_WEBHOOK_URL || '';
    const urlLen = urlStr.length;
    const urlHttps = /^https:\/\//i.test(urlStr);
    console.log('Webhook debug:', { authLen, authBearerCrsr, urlLen, urlHttps });
  } catch {}
  const options = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + (u.search || ''),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authValue,
      'Content-Length': body.length
    }
  };
  try {
    const res = await httpRequest(options, body, { timeoutMs: 2500, maxRedirects: 0 });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      state.questionsPending = [];
    } else {
      console.error('Webhook HTTP error:', res.statusCode);
    }
  } catch (e) {
    console.error('Webhook post failed:', e.message || e);
  }
}

// ---------- Test helpers (only enabled under NODE_ENV=test) ----------
if (process.env.NODE_ENV === 'test') {
  module.exports._handlers = { PlayPodcastIntentHandler, OpenQuestionIntentHandler };
  module.exports._setPlayImpls = (impls = {}) => {
    if (impls.fetchFeedFirstItem) fetchFeedFirstItemImpl = impls.fetchFeedFirstItem;
    if (impls.resolveFinalMp3Url) resolveFinalMp3UrlImpl = impls.resolveFinalMp3Url;
    if (impls.probeMp3Metadata) probeMp3MetadataImpl = impls.probeMp3Metadata;
  };
  module.exports._setQAImpls = (impls = {}) => {
    if (typeof impls.getAnswer === 'function') {
      try { global.__overrideGetAnswer = impls.getAnswer; } catch {}
    }
  };
}
// CI helper: ungrounded quick answer call (no secrets printed)
module.exports._answerForSmoke = async (q) => {
  const txt = await getAnswer({ question: q, audioBase64: null, notes: '', hint: q, budgetMs: 3500, preferGrounding: false });
  return String(txt || '').slice(0, 200);
};

// Ensure Lambda returns promptly and doesn't wait for open timers/sockets
const _skillLambda = exports.handler;
exports.handler = (event, context, callback) => {
  try { context.callbackWaitsForEmptyEventLoop = false; } catch {}
  return _skillLambda(event, context, callback);
};


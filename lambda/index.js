/* eslint-disable no-use-before-define */
'use strict';

const Alexa = require('ask-sdk-core');
const { S3PersistenceAdapter } = require('ask-sdk-s3-persistence-adapter');
const https = require('https');
const { FEED_URL, LOOKBACK_SECONDS, GEMINI_MODEL } = require('./config');

let GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
try {
  // Loaded at deploy-time by the workflow; never committed
  // module.exports = { GEMINI_API_KEY: '...' }
  const localKey = require('./gemini-key.js');
  if (localKey && localKey.GEMINI_API_KEY) {
    GEMINI_API_KEY = localKey.GEMINI_API_KEY;
  }
} catch (e) {
  // ignored - file does not exist in repo
}

// ---------- Utilities (HTTPS only) ----------
function httpRequest(options, bodyBuffer, { timeoutMs = 6000, maxRedirects = 5 } = {}) {
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
          doReq(nextOpts, redirectsLeft - 1);
          return;
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ statusCode: res.statusCode, headers: res.headers, body: buf, redirects: visited });
        });
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

async function httpGet(url, headers = {}, timeoutMs = 6000, maxRedirects = 5) {
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

async function httpHead(url, headers = {}, timeoutMs = 6000, maxRedirects = 5) {
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
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        xml += chunk;
        if (xml.toLowerCase().includes('</item>')) {
          res.destroy(); // stop reading further
        }
      });
      res.on('end', () => {
        const item = parseRssFirstItem(xml);
        if (!item) {
          reject(new Error('No item found in RSS'));
        } else {
          resolve(item);
        }
      });
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

async function fetchMp3Range(url, startByte, endByteInclusive) {
  const headers = {
    'User-Agent': 'PodcastBot/1.0',
    Range: `bytes=${startByte}-${endByteInclusive}`
  };
  const res = await httpGet(url, headers, 6500, 5);
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

async function callGeminiSummarize({ audioBase64, topic, notes, model = GEMINI_MODEL }) {
  if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY (env or lambda/gemini-key.js)');
  }
  const host = 'generativelanguage.googleapis.com';
  const path = `/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const promptText =
    `You are an assistant helping summarize what was just said in a podcast. ` +
    `Answer the user's question in 2–3 concise spoken sentences. ` +
    (topic ? `Focus on the topic: "${topic}". ` : '') +
    (notes ? `Episode notes (context, may be incomplete): ${notes.slice(0, 1200)} ` : '') +
    `If the audio is too short or unclear, say that briefly.`;
  const payload = JSON.stringify({
    contents: [
      {
        role: 'user',
        parts: [
          { text: promptText },
          {
            inlineData: {
              mimeType: 'audio/mpeg',
              data: audioBase64
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 180
    }
  });
  const options = {
    protocol: 'https:',
    hostname: host,
    port: 443,
    path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'x-goog-api-key': GEMINI_API_KEY
    }
  };
  const res = await httpRequest(options, Buffer.from(payload), { timeoutMs: 6000, maxRedirects: 0 });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Gemini HTTP ${res.statusCode}`);
  }
  const data = JSON.parse(res.body.toString('utf8'));
  const parts = (((data || {}).candidates || [])[0] || {}).content?.parts || [];
  const text = parts.map((p) => p.text).filter(Boolean).join(' ').trim();
  return text || 'Sorry, I could not determine that.';
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
  const bucketName = process.env.S3_PERSISTENCE_BUCKET;
  if (!bucketName) {
    // The adapter will throw later; we keep going to support local lambda testing
  }
  return new S3PersistenceAdapter({
    bucketName
  });
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

// ---------- Intent Handlers ----------
const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  async handle(handlerInput) {
    const speakOutput =
      'Welcome to Podcast Bot. Say, play Morning Brew, or ask what did I just miss.';
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
    const intentName = Alexa.getIntentName(requestEnvelope) || '';
    return type === 'IntentRequest' && intentName === 'PlayPodcastIntent';
  },
  async handle(handlerInput) {
    const attributesManager = handlerInput.attributesManager;
    const state = await getState(attributesManager);
    try {
      const item = await fetchFeedFirstItem(FEED_URL);
      if (!item || !item.enclosureUrl) {
        throw new Error('Feed item missing enclosure');
      }
      const { finalUrl } = await resolveFinalMp3Url(item.enclosureUrl);
      const meta = await probeMp3Metadata(finalUrl);
      const token = item.guid || item.title || finalUrl;

      const sameEpisode =
        state.lastToken && state.lastToken === token && state.lastUrl === finalUrl;
      const resumeOffset = sameEpisode ? (state.lastOffsetMs || 0) : 0;

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
      await saveState(attributesManager, newState);

      const directive = buildPlayDirective(finalUrl, token, resumeOffset);
      return handlerInput.responseBuilder
        .speak(resumeOffset > 0 ? 'Resuming Morning Brew Daily.' : 'Playing the latest Morning Brew Daily.')
        .addDirective(directive)
        .withShouldEndSession(true)
        .getResponse();
    } catch (err) {
      console.error('PlayPodcast error:', err);
      return handlerInput.responseBuilder
        .speak('Sorry, I could not start the podcast right now.')
        .reprompt('You can say, play Morning Brew.')
        .getResponse();
    }
  }
};

const AskAboutIntentHandler = {
  canHandle(handlerInput) {
    const { requestEnvelope } = handlerInput;
    const type = Alexa.getRequestType(requestEnvelope);
    const intentName = Alexa.getIntentName(requestEnvelope) || '';
    return type === 'IntentRequest' && intentName === 'AskAboutIntent';
  },
  async handle(handlerInput) {
    const { requestEnvelope } = handlerInput;
    const attributesManager = handlerInput.attributesManager;
    const topic = Alexa.getSlotValue(requestEnvelope, 'topic') || '';
    const playerActivity = requestEnvelope.context?.AudioPlayer?.playerActivity || 'IDLE';
    const wasPlaying = playerActivity === 'PLAYING';
    const ctxOffset = requestEnvelope.context?.AudioPlayer?.offsetInMilliseconds;

    const state = await getState(attributesManager);
    const url = state.lastUrl;
    const offsetMs = typeof ctxOffset === 'number' ? ctxOffset : (state.lastOffsetMs || 0);
    if (!url) {
      return handlerInput.responseBuilder
        .speak('Nothing is playing yet. Say, play Morning Brew.')
        .reprompt('Say, play Morning Brew.')
        .getResponse();
    }
    // Send progressive response
    await sendProgressiveResponse(handlerInput, 'One sec.');

    let answer = 'Sorry, I could not get that.';
    try {
      // Ensure we have metadata
      const id3Size = state.id3Size ?? 0;
      const bytesPerSecond = state.bytesPerSecond ?? (await probeMp3Metadata(url)).bytesPerSecond;
      const lookbackMs = (LOOKBACK_SECONDS || 75) * 1000;
      const startMs = Math.max(0, (offsetMs || 0) - lookbackMs);
      const startByte = id3Size + Math.max(0, Math.floor((startMs / 1000) * bytesPerSecond));
      const endByte = startByte + Math.max(2048, Math.floor((lookbackMs / 1000) * bytesPerSecond)) - 1;
      const rangeBuf = await fetchMp3Range(url, startByte, endByte);
      const trimmed = trimToFrameSync(rangeBuf);
      const audioBase64 = trimmed.toString('base64');
      answer = await callGeminiSummarize({
        audioBase64,
        topic,
        notes: state.lastNotes || ''
      });
    } catch (err) {
      console.error('AskAbout error:', err);
      answer = 'Sorry, I could not analyze that just now.';
    }

    const rb = handlerInput.responseBuilder.speak(answer);
    // Resume if we were playing
    if (wasPlaying && state.lastUrl && state.lastToken != null) {
      const directive = buildPlayDirective(state.lastUrl, state.lastToken, offsetMs || 0);
      rb.addDirective(directive).withShouldEndSession(true);
    } else {
      rb.reprompt('You can say, play Morning Brew.');
    }
    return rb.getResponse();
  }
};

const PauseIntentHandler = {
  canHandle(handlerInput) {
    const type = Alexa.getRequestType(handlerInput.requestEnvelope);
    const name = Alexa.getIntentName(handlerInput.requestEnvelope) || '';
    return type === 'IntentRequest' && (name === 'AMAZON.PauseIntent' || name === 'AMAZON.StopIntent' || name === 'AMAZON.CancelIntent');
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .addAudioPlayerStopDirective()
      .withShouldEndSession(true)
      .getResponse();
  }
};

const ResumeIntentHandler = {
  canHandle(handlerInput) {
    const type = Alexa.getRequestType(handlerInput.requestEnvelope);
    const name = Alexa.getIntentName(handlerInput.requestEnvelope) || '';
    return type === 'IntentRequest' && (name === 'AMAZON.ResumeIntent');
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
  handle(handlerInput) {
    const name = Alexa.getIntentName(handlerInput.requestEnvelope) || '';
    let speakOutput = '';
    const rb = handlerInput.responseBuilder;
    const withReprompt = () => rb.reprompt('You can say, play Morning Brew.').getResponse();
    switch (name) {
      case 'AMAZON.HelpIntent':
        speakOutput = 'Say, play Morning Brew, or ask, what did I just miss.';
        return rb.speak(speakOutput).reprompt('You can say, play Morning Brew.').getResponse();
      case 'AMAZON.FallbackIntent':
        speakOutput = 'Sorry, I did not get that. You can say, play Morning Brew.';
        return rb.speak(speakOutput).reprompt('You can say, play Morning Brew.').getResponse();
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
    await saveState(handlerInput.attributesManager, state);
    return handlerInput.responseBuilder.getResponse();
  }
};

const PlaybackNearlyFinishedHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'AudioPlayer.PlaybackNearlyFinished';
  },
  handle(handlerInput) {
    // No enqueueing for latest-only stream
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
    await saveState(handlerInput.attributesManager, state);
    return handlerInput.responseBuilder.getResponse();
  }
};

const PlaybackFailedHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'AudioPlayer.PlaybackFailed';
  },
  handle(handlerInput) {
    // Log and move on
    console.error('PlaybackFailed:', JSON.stringify(handlerInput.requestEnvelope.request, null, 2));
    return handlerInput.responseBuilder.getResponse();
  }
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder.getResponse();
  }
};

const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    console.error('Error handled:', error);
    return handlerInput.responseBuilder
      .speak('Sorry, something went wrong.')
      .reprompt('You can say, play Morning Brew.')
      .getResponse();
  }
};

// ---------- Skill Builder ----------
const skillBuilder = Alexa.SkillBuilders.custom();

exports.handler = skillBuilder
  .withPersistenceAdapter(getPersistenceAdapter())
  .addRequestHandlers(
    LaunchRequestHandler,
    PlayPodcastIntentHandler,
    AskAboutIntentHandler,
    PauseIntentHandler,
    ResumeIntentHandler,
    SimpleResponseIntentHandler,
    PlaybackStartedHandler,
    PlaybackStoppedHandler,
    PlaybackNearlyFinishedHandler,
    PlaybackFinishedHandler,
    PlaybackFailedHandler,
    SessionEndedRequestHandler
  )
  .addErrorHandlers(ErrorHandler)
  .lambda();


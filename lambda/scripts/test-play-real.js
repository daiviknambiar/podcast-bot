#!/usr/bin/env node
'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const Alexa = require('ask-sdk-core');
const mod = require('../index.js');

// Use real implementations; do NOT inject mocks
const handler = mod._handlers.PlayPodcastIntentHandler;

function makeHandlerInputEmptySlot() {
  const requestEnvelope = {
    version: '1.0',
    context: { System: {} },
    request: {
      type: 'IntentRequest',
      intent: {
        name: 'PlayPodcastIntent',
        slots: {
          podcast: { name: 'podcast', confirmationStatus: 'NONE' }
        }
      }
    }
  };
  const attributes = {};
  const attributesManager = {
    async getPersistentAttributes() { return attributes; },
    setPersistentAttributes(obj) { Object.assign(attributes, obj); },
    async savePersistentAttributes() {}
  };
  const responseBuilder = Alexa.ResponseFactory.init();
  return { requestEnvelope, attributesManager, responseBuilder };
}

(async () => {
  try {
    const hi = makeHandlerInputEmptySlot();
    const t0 = Date.now();
    const res = await handler.handle(hi);
    const dt = Date.now() - t0;
    if (!res) throw new Error('Response is null');
    const directives = Array.isArray(res.directives) ? res.directives : [];
    const play = directives.find(d => d && d.type === 'AudioPlayer.Play' && d.audioItem && d.audioItem.stream);
    if (!play) {
      console.log(JSON.stringify(res, null, 2));
      throw new Error('No AudioPlayer.Play directive found');
    }
    const url = String(play.audioItem.stream.url || '');
    if (!/^https:/.test(url)) {
      throw new Error(`Stream URL is not https: ${url}`);
    }
    console.log('TEST PASS (real): PlayPodcastIntent returned AudioPlayer.Play in', dt, 'ms');
    console.log('Title/token:', (play.audioItem.stream.token || '').slice(0, 80));
    console.log('URL host:', (new URL(url)).host);
    process.exit(0);
  } catch (e) {
    console.error('TEST FAIL (real):', e.message || e);
    process.exit(1);
  }
})();


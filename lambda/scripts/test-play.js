#!/usr/bin/env node
'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const Alexa = require('ask-sdk-core');
const mod = require('../index.js');

// Inject mocks to avoid network
mod._setPlayImpls({
  fetchFeedFirstItem: async () => ({
    title: 'Mock Morning Brew Daily',
    guid: 'mock-guid-123',
    description: 'Mock desc',
    enclosureUrl: 'https://example.com/audio.mp3'
  }),
  resolveFinalMp3Url: async (u) => ({ finalUrl: u, contentLength: 1024 * 1024 }),
  probeMp3Metadata: async () => ({ id3Size: 0, bitrateKbps: 128, bytesPerSecond: 16000 })
});

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
    const res = await handler.handle(hi);
    if (!res) throw new Error('Response is null');
    const directives = Array.isArray(res.directives) ? res.directives : [];
    const hasPlay = directives.some(d => d && d.type === 'AudioPlayer.Play' && d.audioItem && d.audioItem.stream && typeof d.audioItem.stream.token === 'string' && d.audioItem.stream.token.length > 0 && /^https:/.test(d.audioItem.stream.url));
    if (!hasPlay) {
      console.log(JSON.stringify(res, null, 2));
      throw new Error('No AudioPlayer.Play directive found');
    }
    console.log('TEST PASS: PlayPodcastIntent returned AudioPlayer.Play with https URL and non-empty token.');
    process.exit(0);
  } catch (e) {
    console.error('TEST FAIL:', e.message || e);
    process.exit(1);
  }
})();


#!/usr/bin/env node
'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const Alexa = require('ask-sdk-core');
const mod = require('../index.js');

// Override getAnswer to avoid external LLM calls
mod._setQAImpls({
  getAnswer: async ({ question }) => `MOCK ANSWER for: ${String(question).slice(0, 40)}`
});

const Play = mod._handlers.PlayPodcastIntentHandler;
const OpenQ = mod._handlers.OpenQuestionIntentHandler;

function makeAttributesManager() {
  const attributes = {};
  return {
    async getPersistentAttributes() { return attributes; },
    setPersistentAttributes(obj) { Object.assign(attributes, obj); },
    async savePersistentAttributes() {}
  };
}

function rb() { return Alexa.ResponseFactory.init(); }

function makePlayHI(attributesManager) {
  return {
    requestEnvelope: {
      version: '1.0',
      context: { System: {} },
      request: { type: 'IntentRequest', intent: { name: 'PlayPodcastIntent', slots: { podcast: { name: 'podcast', confirmationStatus: 'NONE' } } } }
    },
    attributesManager,
    responseBuilder: rb()
  };
}

function makeOpenQHI(attributesManager) {
  return {
    requestEnvelope: {
      version: '1.0',
      context: { System: { }, AudioPlayer: { playerActivity: 'PLAYING', offsetInMilliseconds: 30000 } },
      request: {
        type: 'IntentRequest',
        intent: {
          name: 'OpenQuestionIntent',
          slots: { q: { name: 'q', value: 'what is a webhook', confirmationStatus: 'NONE' } }
        }
      }
    },
    attributesManager,
    responseBuilder: rb()
  };
}

(async () => {
  try {
    const attributesManager = makeAttributesManager();
    // Seed state by running play once
    await Play.handle(makePlayHI(attributesManager));
    // Now run OpenQuestion
    const res = await OpenQ.handle(makeOpenQHI(attributesManager));
    if (!res) throw new Error('OpenQuestion returned null');
    const speech = (res.outputSpeech && (res.outputSpeech.text || res.outputSpeech.ssml)) || '';
    if (!/MOCK ANSWER/.test(speech)) {
      console.log(JSON.stringify(res, null, 2));
      throw new Error('Mock answer not found in response');
    }
    console.log('TEST PASS (openquestion):', String(speech).slice(0, 120).replace(/<[^>]+>/g, ''));
    process.exit(0);
  } catch (e) {
    console.error('TEST FAIL (openquestion):', e.message || e);
    process.exit(1);
  }
})();


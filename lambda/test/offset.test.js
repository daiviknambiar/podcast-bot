/* Simple offset logic tests (run with `node lambda/test/offset.test.js`) */
process.env.NODE_ENV = 'test';
const assert = (cond, msg) => { if (!cond) { throw new Error(msg); } };
const skill = require('../index.js');

function fakeEnvelope(activity, offset) {
  return {
    context: { AudioPlayer: { playerActivity: activity, offsetInMilliseconds: offset } },
    request: { type: 'IntentRequest', intent: { name: 'AMAZON.PauseIntent', slots: {} } }
  };
}

(async () => {
  const { _handlers } = skill;
  // Test getLatestOffsetMs indirectly via PauseIntent saving and ResumeIntent
  const attributes = {};
  const attributesManager = {
    async getPersistentAttributes() { return attributes; },
    setPersistentAttributes(obj) { Object.assign(attributes, obj); },
    async savePersistentAttributes() {}
  };
  const rb = {
    _s: null, _d: null, _end: false,
    speak(s) { this._s = s; return this; },
    addDirective(d) { this._d = d; return this; },
    withShouldEndSession(b) { this._end = b; return this; },
    reprompt() { return this; },
    getResponse() { return { outputSpeech: this._s, directives: this._d ? [this._d] : [], shouldEndSession: this._end }; }
  };
  const handlerInput = (env) => ({ requestEnvelope: env, attributesManager, responseBuilder: Object.assign({}, rb) });

  // Save non-zero offset, ensure later zero context does not overwrite
  attributes.lastUrl = 'https://example.com/a.mp3';
  attributes.lastToken = 't1';
  attributes.lastOffsetMs = 120000;
  await skill._handlers.PlaybackStoppedHandler.handle(handlerInput({ request: { type: 'AudioPlayer.PlaybackStopped', token: 't1', offsetInMilliseconds: 125000 } }));
  assert(attributes.lastOffsetMs === 125000, 'should save stopped offset');
  // Intent with STOPPED and zero offset should not overwrite saved 125000
  const hi = handlerInput(fakeEnvelope('STOPPED', 0));
  await skill._handlers.PauseIntentHandler.handle(hi);
  assert(attributes.lastOffsetMs === 125000, 'zero offset should not overwrite non-zero saved');
  console.log('OK offset tests');
})(); 

module.exports = {
  // Accepts either 'gemini-...' or fully-qualified 'models/gemini-...'
  // Default chain prefers free-tier friendly models first; 3.8-flash last.
  GEMINI_MODEL: 'models/gemini-2.5-flash',
  GEMINI_FALLBACK_MODELS: [
    'models/gemini-flash-lite-latest',
    'models/gemini-2.5-flash-lite',
    'models/gemini-3.8-flash'
  ],
  LOOKBACK_SECONDS: 75,
  FEED_URL: 'https://feeds.megaphone.fm/MOBI8777994188',
  // Grounding disabled by default; it often has separate/zero quota
  ENABLE_GOOGLE_GROUNDING: false
};


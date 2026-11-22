module.exports = {
  // Accepts either 'gemini-...' or fully-qualified 'models/gemini-...'
  // Default chain prefers free-tier friendly models first; 3.8-flash last.
  GEMINI_MODEL: 'models/gemini-2.5-flash-lite',
  GEMINI_FALLBACK_MODELS: [
    'models/gemini-2.5-flash',
    'models/gemini-flash-lite-latest'
  ],
  // OpenAI preferred (cheapest first)
  OPENAI_MODEL: 'gpt-4.1-nano',
  OPENAI_FALLBACK_MODELS: ['gpt-4o-mini', 'gpt-5-nano', 'gpt-5-mini'],
  LOOKBACK_SECONDS: 75,
  FEED_URL: 'https://feeds.megaphone.fm/MOBI8777994188',
  // Grounding disabled by default; it often has separate/zero quota
  ENABLE_GOOGLE_GROUNDING: false
};


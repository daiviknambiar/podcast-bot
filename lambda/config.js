module.exports = {
  // Accepts either 'gemini-...' or fully-qualified 'models/gemini-...'
  // Default chain prefers free-tier friendly models first; 3.8-flash last.
  GEMINI_MODEL: 'models/gemini-flash-lite-latest',
  GEMINI_FALLBACK_MODELS: [
    'models/gemini-3.5-flash-lite'
  ],
  // OpenAI preferred (cheapest first)
  OPENAI_MODEL: 'gpt-4.1-nano',
  OPENAI_FALLBACK_MODELS: ['gpt-4o-mini', 'gpt-5-nano', 'gpt-5-mini'],
  LOOKBACK_SECONDS: 75,
  FEED_URL: 'https://feeds.megaphone.fm/MOBI8777994188',
  // Grounding disabled by default; it often has separate/zero quota
  ENABLE_GOOGLE_GROUNDING: false,
  // Q&A resume behavior: if false, let Alexa auto-resume without sending an AudioPlayer directive
  RESUME_WITH_DIRECTIVE: false
};


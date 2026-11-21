PodBot — Alexa-hosted custom skill (Node.js)

This repository contains the source for an Alexa-hosted skill named "PodBot". It plays the latest Morning Brew Daily episode and lets you ask open questions or what you just heard using Gemini.

Quick start
- Invocation name: "pod bot"
- Example phrases:
  - "Alexa, ask pod bot to play Morning Brew"
  - "Alexa, ask pod bot what did they just say about AI regulation"
  - "Alexa, ask pod bot what is compute"
  - "Alexa, ask pod bot what did I just miss"
  - "Alexa, ask pod bot what was that"

What it does
- Streams the newest Morning Brew Daily episode via the AudioPlayer interface
- Remembers playback offset and resumes the same episode
- For "what did they just say about {topic}" and open questions, fetches the last ~75 seconds of audio (when available) and sends it along with your question to Gemini for a short spoken answer; then offers to resume playback

Repository layout (ASK CLI v2)
- `skill-package/` — skill manifest and interaction model
- `lambda/` — Node.js Lambda code (Node 16+), using only built-in `https`
- `ask-resources.json` — ASK CLI v2 project descriptor
- `.github/workflows/deploy.yml` — CI that deploys to the Alexa-hosted repo on every push to `main`

Deployment via GitHub Actions (auto-deploy)
This project targets an Alexa-hosted skill. On each push to `main`, the workflow:
1) Installs `ask-cli`
2) Writes the Gemini API key to `lambda/gemini-key.js` from the `GEMINI_API_KEY` secret
3) Validates the Lambda bundle (Node parse check + `npm ci`)
4) Runs `ask deploy` to push code and the interaction model to the Alexa-hosted repo of skill ID `amzn1.ask.skill.8731ea2f-6df5-4445-a307-582ff944ab13`

Required GitHub Secrets (Settings → Secrets and variables → Actions)
- `ASK_REFRESH_TOKEN` — LWA refresh token for the ASK CLI
- `ASK_VENDOR_ID` — your Alexa developer vendor ID (looks like `Mxxxxxxxxxxxx`)
- `GEMINI_API_KEY` — Gemini API key for generateContent
- Optional: `ASK_ACCESS_TOKEN` — not required; the CLI refreshes it from `ASK_REFRESH_TOKEN`

How to get your ASK refresh token and vendor ID (once, on your laptop)
1) Install Node.js (18+ recommended), then install the ASK CLI:
   npm i -g ask-cli
2) Configure the CLI and sign in (creates `~/.ask/cli_config`):
   ask configure
   - Sign in with your Amazon developer account
   - Choose your default profile (e.g., "default")
3) Find the values:
   - Refresh token: open `~/.ask/cli_config` and copy `profiles.default.token.refresh_token`
   - Vendor ID: run `ask smapi list-vendors` and copy the `id`, or copy `profiles.default.vendor_id` from `~/.ask/cli_config`
   - Alternatively, you can generate tokens non-interactively:
     ask util generate-lwa-tokens
     (This prints access/refresh tokens to the console; keep them secret.)
4) Add the secrets to GitHub (this repo → Settings → Secrets and variables → Actions)

Getting a free Gemini API key
- Request a key at https://aistudio.google.com/apikey and add it as the `GEMINI_API_KEY` secret.

Local development
- Lambda code is under `lambda/`. Install dependencies:
  cd lambda && npm ci
- Syntax-check:
  node --check index.js

Caveats about Alexa-hosted CI deploys
- Alexa-hosted repos live on Amazon infrastructure. The `ask deploy` command handles pushing both `skill-package/` and `lambda/` to the hosted repo. It requires valid ASK tokens (refresh token + vendor ID).
- If any required secret is missing, the workflow fails early with a clear message.
- First-time deploys for a hosted skill may take longer while Amazon provisions the repo; subsequent pushes are faster and automatically trigger a deploy.

License
MIT

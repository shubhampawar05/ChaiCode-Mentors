# ChaiCode Mentors

Chat with AI personas that talk in the public teaching style of **Hitesh Choudhary** and **Piyush Garg**. Ask about code, learning or your career, and get a short, spoken-style answer in Hinglish. When it helps, the mentor also shares a real video from their own YouTube channel.

> These are AI simulations built from public content (websites, YouTube, X posts). They are not the real people, and replies can be wrong.

Built as an assignment for the ChaiCode GenAI with JavaScript cohort.

## Features

- **Two personas** with distinct voices. Hitesh is calm and story-first ("Haanji! Jaldi kis baat ki hai?"). Piyush is fast, first-principles and "let's build it 🚀".
- **Real YouTube videos.** The model calls a `searchYouTube` tool limited to each mentor's own channels. It never writes a URL itself. It uses placeholders like `{{VIDEO_1}}`, which the server swaps for real links, so links can't be made up or mis-copied.
- **Streaming replies**, which appear word by word in the web UI.
- **Web UI**: a mentor picker, a chat that changes colour per mentor, starter questions, video cards, light and dark mode, and a mobile layout.
- **Terminal version** of the same chat (`npm run cli`).
- **Rate limit** per visitor, so a public deployment can't burn through your OpenAI credits.

## Project structure

```
├── src/
│   ├── server.js          # Web server (plain node:http) + streaming chat API
│   ├── engine.js          # Personas, tool-calling loop, streaming, link handling
│   ├── personas/          # System prompts: hitesh.js, piyush.js
│   └── tools/youtube.js   # YouTube Data API search + dead-video filter
├── public/                # Web UI: index.html, styles.css, app.js
├── cli.js                 # Terminal chat
├── docs/persona-research.md  # Public sources the personas are built from
├── prompting/             # Earlier cohort exercises (zero-shot, few-shot, CoT, tools)
└── render.yaml            # One-click deploy config for Render
```

## Run locally

You need Node.js 20 or newer.

1. Install packages:
   ```bash
   npm install
   ```
2. Create your `.env`:
   ```bash
   cp .env.example .env
   ```
   Then fill in the keys:
   | Key | Required | Where to get it |
   |---|---|---|
   | `OPENAI_API_KEY` | Yes | platform.openai.com → API keys |
   | `YOUTUBE_API_KEY` | No (video links are off without it) | Google Cloud Console → enable **YouTube Data API v3** → Credentials → API key |
3. Start the web app and open http://localhost:3000:
   ```bash
   npm start
   ```
   Or chat in the terminal:
   ```bash
   npm run cli
   ```

To see the YouTube searches happening behind the scenes, run with `DEBUG=1 npm start`.

## Deploy to Render

1. Push this repo to GitHub.
2. On [render.com](https://render.com), go to **New → Blueprint** and pick the repo. Render reads `render.yaml`.
3. Enter `OPENAI_API_KEY` and `YOUTUBE_API_KEY` when asked, then deploy.

On the free plan the service sleeps after about 15 minutes without visitors, and the first visit after that takes around 50 seconds to wake it up.

**Protect your credits:** set a monthly spending limit in your OpenAI dashboard. The built-in rate limit allows 8 messages per minute and 60 per day per visitor. Change it with the `RATE_LIMIT_PER_MINUTE` and `RATE_LIMIT_PER_DAY` environment variables.

## How it works

1. The browser sends your message to `POST /api/chat`.
2. The server adds it to that chat's history, which starts with the mentor's system prompt, and calls OpenAI with streaming on and the `searchYouTube` tool available.
3. If the model asks for videos, the server searches that mentor's channels, drops deleted or private videos, and gives the model only titles and placeholder refs.
4. Text streams back to the browser as NDJSON lines. A final `done` event carries the cleaned text and the video cards.

Chat history lives in server memory, so restarting the server clears it.

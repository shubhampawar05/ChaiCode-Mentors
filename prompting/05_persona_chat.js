import 'dotenv/config';
import { OpenAI } from 'openai';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { HITESH_SYSTEM_PROMPT } from './personas/hitesh.js';
import { PIYUSH_SYSTEM_PROMPT } from './personas/piyush.js';
import { searchYouTube } from './tools/youtube.js';

// Put OPENAI_API_KEY=sk-... in a .env file at the project root (it's already git-ignored).
// The client is created in main() after we check the key exists.
let client;

const MODEL = 'gpt-4o';

const PERSONAS = {
  1: {
    name: 'Hitesh Choudhary',
    emoji: '☕',
    systemPrompt: HITESH_SYSTEM_PROMPT,
    youtubeChannels: ['@chaiaurcode', '@HiteshCodeLab'],
  },
  2: {
    name: 'Piyush Garg',
    emoji: '🚀',
    systemPrompt: PIYUSH_SYSTEM_PROMPT,
    youtubeChannels: ['@piyushgargdev'],
  },
};

// Tool definition sent to OpenAI. The model decides when to call it.
const YOUTUBE_TOOL = {
  type: 'function',
  function: {
    name: 'searchYouTube',
    description:
      "Search your own YouTube channel(s) for real videos on a topic. Use it when the user wants to learn something or asks for a video, playlist or resource. Only share links returned by this tool.",
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Short topic to search, e.g. "docker", "react hooks", "rag".',
        },
      },
      required: ['query'],
    },
  },
};

const useYouTube = () => Boolean(process.env.YOUTUBE_API_KEY);

// Only prints when you run with DEBUG=1, e.g. `DEBUG=1 node prompting/05_persona_chat.js`
const debugLog = (msg) => {
  if (process.env.DEBUG) console.log(`   ${msg}`);
};

// The terminal can't show markdown links, so turn "[title](url)" into "title: url" and drop **bold**.
const toPlainText = (text = '') =>
  text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1: $2').replace(/\*\*(.+?)\*\*/g, '$1');

// LLMs often mis-copy random IDs like "3NQ3vItetgk", which breaks links. So the model never sees
// real URLs: it gets placeholders like {{VIDEO_1}}, and we swap in the real URL before printing.
// If the model points at a video we don't have, we show the persona's channel link instead of
// leaving a blank like "dekh lijiye: ". Channel URLs are always real.
function renderReply(text = '', videoRefs, channelUrl) {
  const realUrls = new Set(videoRefs.values());

  // Safety net first: replace any YouTube link the model typed itself (not from the tool) with the channel.
  let output = text.replace(/https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/[^\s)]+/g, (url) => {
    const clean = url.replace(/[.,!?]+$/, '');
    if (realUrls.has(clean) || clean === channelUrl) return url;
    debugLog(`⚠️  model wrote its own link ${clean}, replaced with channel link`);
    return channelUrl;
  });

  output = output.replace(/\{\{\s*(VIDEO_\d+)\s*\}\}/g, (_, ref) => {
    if (videoRefs.has(ref)) return videoRefs.get(ref);
    debugLog(`⚠️  model used unknown ${ref}, replaced with channel link`);
    return channelUrl;
  });

  return toPlainText(output);
}

// Runs one tool call from the model and returns the text we send back to it.
async function runTool(toolCall, persona, videoRefs) {
  if (toolCall.function.name !== 'searchYouTube') {
    return JSON.stringify({ error: `Unknown tool ${toolCall.function.name}` });
  }

  const { query } = JSON.parse(toolCall.function.arguments || '{}');
  // Search runs silently so the chat feels natural. Run with DEBUG=1 to see it.
  debugLog(`🔎 searching YouTube for "${query}"...`);

  try {
    const videos = await searchYouTube(query, persona.youtubeChannels);
    if (!videos.length) {
      return JSON.stringify({
        videos: [],
        note: 'No matching video found. Do NOT write any {{VIDEO_n}} ref or link. Just answer, and optionally tell them to check your YouTube channel.',
      });
    }
    // Give the model a placeholder instead of the URL. The numbering keeps going across the chat.
    const forModel = videos.map((video) => {
      const ref = `VIDEO_${videoRefs.size + 1}`;
      videoRefs.set(ref, video.url);
      return { ref: `{{${ref}}}`, title: video.title, channel: video.channel, publishedAt: video.publishedAt };
    });
    return JSON.stringify({
      videos: forModel,
      note: 'To share a video, write its ref exactly, e.g. {{VIDEO_1}}. It becomes the real link automatically. Never write a URL yourself.',
    });
  } catch (error) {
    debugLog(`⚠️  YouTube search failed: ${error.message}`);
    return JSON.stringify({
      error: 'search failed',
      note: 'Answer the question without any link and do not mention any video titles. Do not talk about the search failing in detail.',
    });
  }
}

const rl = readline.createInterface({ input, output });

async function choosePersona() {
  console.log('\nWho do you want to talk to?');
  console.log('  1) Hitesh Choudhary');
  console.log('  2) Piyush Garg');

  while (true) {
    const choice = (await rl.question('Enter 1 or 2: ')).trim();
    if (PERSONAS[choice]) return PERSONAS[choice];
    console.log('Please type 1 or 2.');
  }
}

async function chatWith(persona) {
  // Same idea as MESSAGES_DB in 03/04: system prompt first, then the whole conversation.
  // If there's no YouTube key, tell the model the tool is off so it doesn't type fake tool calls.
  const toolNote = useYouTube()
    ? ''
    : `\n\nNOTE: The searchYouTube tool is NOT available in this session. Never write tool calls like searchYouTube(...) in a reply, and never mention specific video titles or links. If someone asks for a video, tell them to search your channel on YouTube (${persona.youtubeChannels.join(', ')}).`;

  const MESSAGES_DB = [{ role: 'system', content: persona.systemPrompt + toolNote }];

  // "VIDEO_1" -> real YouTube URL, for every video found in this chat.
  const videoRefs = new Map();

  console.log(
    `\n${persona.emoji} You are now chatting with an AI simulation of ${persona.name}'s public teaching style (not the real person).`,
  );
  console.log('Commands: /switch to change persona, /exit to quit.\n');

  while (true) {
    const userInput = (await rl.question('👤 You: ')).trim();
    if (!userInput) continue;

    if (userInput === '/exit') return 'exit';
    if (userInput === '/switch') return 'switch';

    const historyLength = MESSAGES_DB.length;
    MESSAGES_DB.push({ role: 'user', content: userInput });

    try {
      // Tool loop, like 04_cot_tool.js: keep calling the model until it answers with text.
      // Capped at 3 rounds so it can never loop forever.
      for (let round = 0; round < 3; round++) {
        const result = await client.chat.completions.create({
          model: MODEL,
          messages: MESSAGES_DB,
          ...(useYouTube() && { tools: [YOUTUBE_TOOL] }),
        });

        const message = result.choices[0].message;
        MESSAGES_DB.push(message);

        if (!message.tool_calls?.length) {
          const channelUrl = `https://www.youtube.com/${persona.youtubeChannels[0]}`;
          console.log(`\n${persona.emoji} ${persona.name}: ${renderReply(message.content, videoRefs, channelUrl)}\n`);
          break;
        }

        for (const toolCall of message.tool_calls) {
          const toolResult = await runTool(toolCall, persona, videoRefs);
          MESSAGES_DB.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult });
        }
      }
    } catch (error) {
      // Drop everything from this failed turn so the history stays clean, then let the user retry.
      MESSAGES_DB.length = historyLength;
      console.log(`\n⚠️  Couldn't get a reply: ${error.message}\n`);
    }
  }
}

async function main() {
  console.log('☕ Welcome to ChaiCode Persona Chat 🚀');

  if (!process.env.OPENAI_API_KEY) {
    console.log('\n⚠️  OPENAI_API_KEY is not set. Add it to a .env file in the project root and run again.');
    rl.close();
    return;
  }

  client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  if (!useYouTube()) {
    console.log('ℹ️  YOUTUBE_API_KEY not set, so video links are off. Add it to .env to enable them.');
  }

  while (true) {
    const persona = await choosePersona();
    const action = await chatWith(persona);
    if (action === 'exit') break;
  }

  console.log('\nBye! Keep building 👋');
  rl.close();
}

main();

// Shared chat logic for the web UI: personas, the YouTube tool loop, and reply rendering.
// Same flow as cli.js (the terminal version), packaged so the web server can reuse it.

import { HITESH_SYSTEM_PROMPT } from './personas/hitesh.js';
import { PIYUSH_SYSTEM_PROMPT } from './personas/piyush.js';
import { searchYouTube } from './tools/youtube.js';

export const MODEL = 'gpt-4o';

export const PERSONAS = {
  hitesh: {
    id: 'hitesh',
    name: 'Hitesh Choudhary',
    initials: 'HC',
    tagline: 'Chai aur Code. Calm, story-first, "learn it properly".',
    sample: 'Haanji! Jaldi kis baat ki hai? Ek project uthao aur khud banao.',
    starters: [
      'Sir mujhe DSA kaha se start karna chahiye?',
      'JavaScript seekhne me bahut time lag raha hai',
      'Docker sikhna hai, kaise shuru karu?',
      'Tutorial hell se kaise niklu?',
    ],
    systemPrompt: HITESH_SYSTEM_PROMPT,
    youtubeChannels: ['@chaiaurcode', '@HiteshCodeLab'],
  },
  piyush: {
    id: 'piyush',
    name: 'Piyush Garg',
    initials: 'PG',
    tagline: 'Build and ship. First principles, system design, GenAI.',
    sample: 'Toh guys, simple si baat hai. Chalo, isko build karte hain.',
    starters: [
      'Bhai Docker kyu seekhna chahiye?',
      'URL shortener ka system design samjhao',
      'GenAI me career kaise banau?',
      'Resume ke liye kaunsa project banau?',
    ],
    systemPrompt: PIYUSH_SYSTEM_PROMPT,
    youtubeChannels: ['@piyushgargdev'],
  },
};

// Public info sent to the browser (no system prompts).
export const publicPersonas = () =>
  Object.values(PERSONAS).map(({ id, name, initials, tagline, sample, starters, youtubeChannels }) => ({
    id,
    name,
    initials,
    tagline,
    sample,
    starters,
    channelUrl: `https://www.youtube.com/${youtubeChannels[0]}`,
  }));

const YOUTUBE_TOOL = {
  type: 'function',
  function: {
    name: 'searchYouTube',
    description:
      'Search your own YouTube channel(s) for real videos on a topic. Use it when the user wants to learn something or asks for a video, playlist or resource. Only share videos returned by this tool.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Short topic to search, e.g. "docker", "react hooks", "rag".' },
      },
      required: ['query'],
    },
  },
};

const useYouTube = () => Boolean(process.env.YOUTUBE_API_KEY);

const debugLog = (msg) => {
  if (process.env.DEBUG) console.log(`   ${msg}`);
};

export function createChat(personaId) {
  const persona = PERSONAS[personaId];
  if (!persona) throw new Error(`Unknown persona: ${personaId}`);

  const toolNote = useYouTube()
    ? ''
    : `\n\nNOTE: The searchYouTube tool is NOT available in this session. Never write tool calls like searchYouTube(...) in a reply, and never mention specific video titles or links. If someone asks for a video, tell them to search your channel on YouTube (${persona.youtubeChannels.join(', ')}).`;

  return {
    persona,
    messages: [{ role: 'system', content: persona.systemPrompt + toolNote }],
    videos: new Map(), // "VIDEO_1" -> { url, title, thumbnail, channel }
  };
}

async function runTool(toolCall, chat) {
  if (toolCall.function.name !== 'searchYouTube') {
    return JSON.stringify({ error: `Unknown tool ${toolCall.function.name}` });
  }
  const { query } = JSON.parse(toolCall.function.arguments || '{}');
  debugLog(`🔎 searching YouTube for "${query}"...`);

  try {
    const found = await searchYouTube(query, chat.persona.youtubeChannels);
    if (!found.length) {
      return JSON.stringify({
        videos: [],
        note: 'No matching video found. Do NOT write any {{VIDEO_n}} ref or link. Just answer, and optionally tell them to check your YouTube channel.',
      });
    }
    const forModel = found.map((video) => {
      const ref = `VIDEO_${chat.videos.size + 1}`;
      chat.videos.set(ref, video);
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
      note: 'Answer the question without any link and do not mention any video titles.',
    });
  }
}

// Turns the model's text into { text, videos } for the UI.
// {{VIDEO_n}} becomes a 👇 in the text plus a video card. Unknown refs or links the model typed
// itself become a card for the persona's channel, so the UI never shows a broken link.
function renderForWeb(raw = '', chat) {
  const persona = chat.persona;
  const channelCard = {
    url: `https://www.youtube.com/${persona.youtubeChannels[0]}`,
    title: `${persona.name} on YouTube`,
    channel: persona.youtubeChannels[0],
    thumbnail: null,
  };
  const knownUrls = new Map([...chat.videos.values()].map((v) => [v.url, v]));
  const cards = [];
  const addCard = (card) => {
    if (!cards.some((c) => c.url === card.url)) cards.push(card);
  };

  let text = raw.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 $2'); // markdown links -> plain

  text = text.replace(/https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/[^\s)]+/g, (url) => {
    const clean = url.replace(/[.,!?]+$/, '');
    addCard(knownUrls.get(clean) ?? channelCard);
    return '👇';
  });

  text = text.replace(/\{\{\s*(VIDEO_\d+)\s*\}\}/g, (_, ref) => {
    addCard(chat.videos.get(ref) ?? channelCard);
    return '👇';
  });

  return { text: text.replace(/\*\*(.+?)\*\*/g, '$1').trim(), videos: cards };
}

// Streaming version: calls onDelta(text) as tokens arrive, then returns the final { text, videos }.
// While streaming, a {{VIDEO_n}} ref can arrive split across tokens ("{{VID" + "EO_1}}"), so we hold
// back anything after an unclosed "{{" and swap complete refs for 👇. The final rendered text
// (returned at the end) is the source of truth; the browser replaces the streamed text with it.
export async function streamMessage(client, chat, userText, onDelta) {
  const historyLength = chat.messages.length;
  chat.messages.push({ role: 'user', content: userText });

  try {
    for (let round = 0; round < 3; round++) {
      const stream = await client.chat.completions.create({
        model: MODEL,
        messages: chat.messages,
        stream: true,
        ...(useYouTube() && { tools: [YOUTUBE_TOOL] }),
      });

      let content = '';
      let pending = ''; // streamed text not yet sent to the browser
      const toolCalls = []; // rebuilt from streamed pieces, by index

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        for (const piece of delta.tool_calls ?? []) {
          const call = (toolCalls[piece.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (piece.id) call.id = piece.id;
          if (piece.function?.name) call.function.name += piece.function.name;
          if (piece.function?.arguments) call.function.arguments += piece.function.arguments;
        }

        if (delta.content) {
          content += delta.content;
          pending += delta.content;

          const open = pending.lastIndexOf('{{');
          const holdFrom = open !== -1 && !pending.includes('}}', open) ? open : pending.endsWith('{') ? pending.length - 1 : -1;
          const ready = holdFrom === -1 ? pending : pending.slice(0, holdFrom);
          pending = holdFrom === -1 ? '' : pending.slice(holdFrom);

          if (ready) onDelta(ready.replace(/\{\{\s*VIDEO_\d+\s*\}\}/g, '👇'));
        }
      }
      if (pending) onDelta(pending.replace(/\{\{\s*VIDEO_\d+\s*\}\}/g, '👇'));

      if (!toolCalls.length) {
        chat.messages.push({ role: 'assistant', content });
        return renderForWeb(content, chat);
      }

      chat.messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
      for (const toolCall of toolCalls) {
        const toolResult = await runTool(toolCall, chat);
        chat.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult });
      }
    }
    throw new Error('The model kept calling tools without answering.');
  } catch (error) {
    chat.messages.length = historyLength;
    throw error;
  }
}

// Sends one user message and returns { text, videos }. Rolls back history if anything fails.
export async function sendMessage(client, chat, userText) {
  const historyLength = chat.messages.length;
  chat.messages.push({ role: 'user', content: userText });

  try {
    for (let round = 0; round < 3; round++) {
      const result = await client.chat.completions.create({
        model: MODEL,
        messages: chat.messages,
        ...(useYouTube() && { tools: [YOUTUBE_TOOL] }),
      });

      const message = result.choices[0].message;
      chat.messages.push(message);

      if (!message.tool_calls?.length) return renderForWeb(message.content, chat);

      for (const toolCall of message.tool_calls) {
        const toolResult = await runTool(toolCall, chat);
        chat.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult });
      }
    }
    throw new Error('The model kept calling tools without answering.');
  } catch (error) {
    chat.messages.length = historyLength;
    throw error;
  }
}

#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const GRAPH_API_BASE = 'https://graph.instagram.com/v21.0';

// Load accounts dynamically from env vars.
// INSTAGRAM_ACCOUNTS=koda,emrah
// INSTAGRAM_KODA_TOKEN=... INSTAGRAM_KODA_USER_ID=...
function loadAccounts() {
  const keys = (process.env.INSTAGRAM_ACCOUNTS || '').split(',').map(k => k.trim()).filter(Boolean);
  if (!keys.length) throw new Error('INSTAGRAM_ACCOUNTS env var is not set.');
  const accounts = {};
  for (const key of keys) {
    const upper = key.toUpperCase();
    accounts[key] = {
      label: key,
      accessToken: process.env[`INSTAGRAM_${upper}_TOKEN`],
      userId: process.env[`INSTAGRAM_${upper}_USER_ID`],
    };
  }
  return accounts;
}

const ACCOUNTS = loadAccounts();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getAccount(key) {
  const account = ACCOUNTS[key];
  if (!account) throw new Error(`Unknown account "${key}". Configured accounts: ${Object.keys(ACCOUNTS).join(', ')}.`);
  if (!account.accessToken || !account.userId)
    throw new Error(`Missing credentials for "${key}". Set INSTAGRAM_${key.toUpperCase()}_TOKEN and INSTAGRAM_${key.toUpperCase()}_USER_ID.`);
  return account;
}

async function graph(endpoint, method = 'GET', params = {}) {
  const url = new URL(`${GRAPH_API_BASE}${endpoint}`);
  const options = { method };

  if (method === 'GET') {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  } else {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(params);
  }

  const res = await fetch(url.toString(), options);
  const data = await res.json();
  if (data.error) throw new Error(`Graph API: ${data.error.message} (code ${data.error.code})`);
  return data;
}

// ─── API functions ────────────────────────────────────────────────────────────

async function getAccountInfo(key) {
  const { accessToken, userId, label } = getAccount(key);
  const data = await graph(`/${userId}`, 'GET', {
    fields: 'id,name,username,biography,followers_count,follows_count,media_count,profile_picture_url,website',
    access_token: accessToken,
  });
  return { account: label, ...data };
}

async function getRecentPosts(key, limit = 10) {
  const { accessToken, userId } = getAccount(key);
  return graph(`/${userId}/media`, 'GET', {
    fields: 'id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count,permalink',
    limit,
    access_token: accessToken,
  });
}

async function publishPhoto(key, imageUrl, caption = '') {
  const { accessToken, userId } = getAccount(key);
  const container = await graph(`/${userId}/media`, 'POST', {
    image_url: imageUrl,
    caption,
    access_token: accessToken,
  });
  const result = await graph(`/${userId}/media_publish`, 'POST', {
    creation_id: container.id,
    access_token: accessToken,
  });
  return { success: true, post_id: result.id, caption, image_url: imageUrl };
}

async function publishCarousel(key, imageUrls, caption = '') {
  const { accessToken, userId } = getAccount(key);
  const children = await Promise.all(
    imageUrls.map(url =>
      graph(`/${userId}/media`, 'POST', {
        image_url: url,
        is_carousel_item: true,
        access_token: accessToken,
      })
    )
  );
  const carousel = await graph(`/${userId}/media`, 'POST', {
    media_type: 'CAROUSEL',
    children: children.map(c => c.id).join(','),
    caption,
    access_token: accessToken,
  });
  const result = await graph(`/${userId}/media_publish`, 'POST', {
    creation_id: carousel.id,
    access_token: accessToken,
  });
  return { success: true, post_id: result.id, caption, image_count: imageUrls.length };
}

async function getConversations(key) {
  const { accessToken, userId } = getAccount(key);
  return graph(`/${userId}/conversations`, 'GET', {
    platform: 'instagram',
    fields: 'id,participants,updated_time,message_count',
    access_token: accessToken,
  });
}

async function getMessages(key, conversationId) {
  const { accessToken } = getAccount(key);
  return graph(`/${conversationId}`, 'GET', {
    fields: 'messages{id,message,from,created_time,attachments}',
    access_token: accessToken,
  });
}

async function sendMessage(key, recipientId, message) {
  const { accessToken, userId } = getAccount(key);
  return graph(`/${userId}/messages`, 'POST', {
    recipient: JSON.stringify({ id: recipientId }),
    message: JSON.stringify({ text: message }),
    access_token: accessToken,
  });
}

async function getPostComments(key, postId) {
  const { accessToken } = getAccount(key);
  return graph(`/${postId}/comments`, 'GET', {
    fields: 'id,text,username,timestamp,replies{id,text,username,timestamp}',
    access_token: accessToken,
  });
}

async function replyToComment(key, commentId, message) {
  const { accessToken } = getAccount(key);
  return graph(`/${commentId}/replies`, 'POST', {
    message,
    access_token: accessToken,
  });
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const accountNames = Object.keys(ACCOUNTS).join(', ');
const accountDesc = `Account key as defined in INSTAGRAM_ACCOUNTS (configured: ${accountNames})`;

const TOOLS = [
  {
    name: 'get_account_info',
    description: 'Get profile info for an Instagram account.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
      },
      required: ['account'],
    },
  },
  {
    name: 'get_recent_posts',
    description: 'Get recent posts from an Instagram account.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        limit: { type: 'number', description: 'Number of posts (default 10, max 100)' },
      },
      required: ['account'],
    },
  },
  {
    name: 'publish_photo',
    description: 'Publish a single photo post. Image must be a publicly accessible URL.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        image_url: { type: 'string', description: 'Publicly accessible image URL' },
        caption: { type: 'string', description: 'Post caption' },
      },
      required: ['account', 'image_url'],
    },
  },
  {
    name: 'publish_carousel',
    description: 'Publish a carousel (multi-image) post. 2–10 images.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        image_urls: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 10,
          description: 'Publicly accessible image URLs',
        },
        caption: { type: 'string', description: 'Post caption' },
      },
      required: ['account', 'image_urls'],
    },
  },
  {
    name: 'get_conversations',
    description: 'List DM conversations for an Instagram account.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
      },
      required: ['account'],
    },
  },
  {
    name: 'get_messages',
    description: 'Get messages in a specific DM conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        conversation_id: { type: 'string', description: 'Conversation ID from get_conversations' },
      },
      required: ['account', 'conversation_id'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a DM to an Instagram user. Requires instagram_manage_messages permission.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        recipient_id: { type: 'string', description: 'Instagram user ID of the recipient' },
        message: { type: 'string', description: 'Message text' },
      },
      required: ['account', 'recipient_id', 'message'],
    },
  },
  {
    name: 'get_post_comments',
    description: 'Get comments on an Instagram post.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        post_id: { type: 'string', description: 'Post ID' },
      },
      required: ['account', 'post_id'],
    },
  },
  {
    name: 'reply_to_comment',
    description: 'Reply to a comment on an Instagram post.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        comment_id: { type: 'string', description: 'Comment ID to reply to' },
        message: { type: 'string', description: 'Reply text' },
      },
      required: ['account', 'comment_id', 'message'],
    },
  },
];

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'graph-bridge-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result;
    switch (name) {
      case 'get_account_info':  result = await getAccountInfo(args.account); break;
      case 'get_recent_posts':  result = await getRecentPosts(args.account, args.limit); break;
      case 'publish_photo':     result = await publishPhoto(args.account, args.image_url, args.caption); break;
      case 'publish_carousel':  result = await publishCarousel(args.account, args.image_urls, args.caption); break;
      case 'get_conversations': result = await getConversations(args.account); break;
      case 'get_messages':      result = await getMessages(args.account, args.conversation_id); break;
      case 'send_message':      result = await sendMessage(args.account, args.recipient_id, args.message); break;
      case 'get_post_comments': result = await getPostComments(args.account, args.post_id); break;
      case 'reply_to_comment':  result = await replyToComment(args.account, args.comment_id, args.message); break;
      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

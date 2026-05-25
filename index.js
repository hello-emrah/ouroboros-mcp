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

  if (method === 'GET' || method === 'DELETE') {
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

// ─── Async container helper (video, reels, story) ─────────────────────────────

async function waitForContainer(creationId, accessToken, { maxWaitMs = 90000, pollMs = 3000 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < maxWaitMs) {
    last = await graph(`/${creationId}`, 'GET', {
      fields: 'status_code,status',
      access_token: accessToken,
    });
    if (last.status_code === 'FINISHED') return last;
    if (last.status_code === 'ERROR' || last.status_code === 'EXPIRED') {
      throw new Error(`Container ${last.status_code}: ${last.status || 'no detail'}`);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error(`Container did not finish within ${maxWaitMs / 1000}s. Last status: ${last && last.status_code}`);
}

// ─── Video, Reels, Stories publishing ─────────────────────────────────────────

async function publishVideo(key, videoUrl, caption = '', coverUrl) {
  const { accessToken, userId } = getAccount(key);
  const params = {
    media_type: 'VIDEO',
    video_url: videoUrl,
    caption,
    access_token: accessToken,
  };
  if (coverUrl) params.cover_url = coverUrl;
  const container = await graph(`/${userId}/media`, 'POST', params);
  await waitForContainer(container.id, accessToken);
  const result = await graph(`/${userId}/media_publish`, 'POST', {
    creation_id: container.id,
    access_token: accessToken,
  });
  return { success: true, post_id: result.id, type: 'video', caption, video_url: videoUrl };
}

async function publishReel(key, videoUrl, caption = '', coverUrl, shareToFeed = true) {
  const { accessToken, userId } = getAccount(key);
  const params = {
    media_type: 'REELS',
    video_url: videoUrl,
    caption,
    share_to_feed: shareToFeed,
    access_token: accessToken,
  };
  if (coverUrl) params.cover_url = coverUrl;
  const container = await graph(`/${userId}/media`, 'POST', params);
  await waitForContainer(container.id, accessToken);
  const result = await graph(`/${userId}/media_publish`, 'POST', {
    creation_id: container.id,
    access_token: accessToken,
  });
  return { success: true, post_id: result.id, type: 'reel', caption, video_url: videoUrl, share_to_feed: shareToFeed };
}

async function publishStory(key, { imageUrl, videoUrl }) {
  const { accessToken, userId } = getAccount(key);
  if (!imageUrl && !videoUrl) throw new Error('Either image_url or video_url is required for a story.');
  if (imageUrl && videoUrl) throw new Error('Provide image_url or video_url, not both.');
  const params = {
    media_type: 'STORIES',
    access_token: accessToken,
  };
  if (imageUrl) params.image_url = imageUrl;
  if (videoUrl) params.video_url = videoUrl;
  const container = await graph(`/${userId}/media`, 'POST', params);
  if (videoUrl) await waitForContainer(container.id, accessToken);
  const result = await graph(`/${userId}/media_publish`, 'POST', {
    creation_id: container.id,
    access_token: accessToken,
  });
  return { success: true, post_id: result.id, type: 'story', media_type: imageUrl ? 'image' : 'video' };
}

// ─── Insights ─────────────────────────────────────────────────────────────────

async function getPostInsights(key, postId, metrics) {
  const { accessToken } = getAccount(key);
  const metric = metrics && metrics.length
    ? metrics.join(',')
    : 'reach,impressions,saved,likes,comments,shares,total_interactions';
  return graph(`/${postId}/insights`, 'GET', {
    metric,
    access_token: accessToken,
  });
}

// ─── Discovery and moderation ─────────────────────────────────────────────────

async function getTaggedPosts(key, limit = 25) {
  const { accessToken, userId } = getAccount(key);
  return graph(`/${userId}/tags`, 'GET', {
    fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,username,timestamp',
    limit,
    access_token: accessToken,
  });
}

async function searchHashtag(key, hashtag, { sort = 'top', limit = 25 } = {}) {
  const { accessToken, userId } = getAccount(key);
  const clean = hashtag.replace(/^#/, '');
  const search = await graph(`/ig_hashtag_search`, 'GET', {
    user_id: userId,
    q: clean,
    access_token: accessToken,
  });
  if (!search.data || !search.data.length) {
    return { hashtag: clean, results: [] };
  }
  const hashtagId = search.data[0].id;
  const edge = sort === 'recent' ? 'recent_media' : 'top_media';
  const media = await graph(`/${hashtagId}/${edge}`, 'GET', {
    user_id: userId,
    fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
    limit,
    access_token: accessToken,
  });
  return { hashtag: clean, hashtag_id: hashtagId, sort, ...media };
}

async function hideComment(key, commentId, hide = true) {
  const { accessToken } = getAccount(key);
  // The hide endpoint expects the param on the URL even on POST
  const url = new URL(`${GRAPH_API_BASE}/${commentId}`);
  url.searchParams.set('hide', String(hide));
  url.searchParams.set('access_token', accessToken);
  const res = await fetch(url.toString(), { method: 'POST' });
  const data = await res.json();
  if (data.error) throw new Error(`Graph API: ${data.error.message} (code ${data.error.code})`);
  return { success: true, comment_id: commentId, hidden: hide, ...data };
}

async function deleteComment(key, commentId) {
  const { accessToken } = getAccount(key);
  const data = await graph(`/${commentId}`, 'DELETE', { access_token: accessToken });
  return { success: true, comment_id: commentId, ...data };
}

async function getAccountInsights(key, { metrics, period = 'day', metric_type, since, until } = {}) {
  const { accessToken, userId } = getAccount(key);
  const metric = metrics && metrics.length
    ? metrics.join(',')
    : 'reach,profile_views,follower_count,website_clicks';
  const params = {
    metric,
    period,
    access_token: accessToken,
  };
  if (metric_type) params.metric_type = metric_type;
  if (since) params.since = since;
  if (until) params.until = until;
  return graph(`/${userId}/insights`, 'GET', params);
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
  {
    name: 'publish_video',
    description: 'Publish a feed video post. video_url must be a publicly accessible MP4. Async: waits up to 90s for Meta to process the upload.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        video_url: { type: 'string', description: 'Public URL to an MP4 (H.264/AAC). Aspect ratio 4:5 to 16:9 for feed, up to 60 minutes.' },
        caption: { type: 'string', description: 'Optional caption' },
        cover_url: { type: 'string', description: 'Optional public URL to a JPEG cover thumbnail' },
      },
      required: ['account', 'video_url'],
    },
  },
  {
    name: 'publish_reel',
    description: 'Publish a Reel. video_url must be a publicly accessible MP4. Async: waits up to 90s for Meta to process the upload.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        video_url: { type: 'string', description: 'Public URL to an MP4. 9:16 aspect, up to 90 seconds, H.264/AAC, 30fps recommended.' },
        caption: { type: 'string', description: 'Optional caption' },
        cover_url: { type: 'string', description: 'Optional public URL to a JPEG cover thumbnail' },
        share_to_feed: { type: 'boolean', description: 'Also share to feed (default true)' },
      },
      required: ['account', 'video_url'],
    },
  },
  {
    name: 'publish_story',
    description: 'Publish a Story (image or video). Exactly one of image_url or video_url is required. Video stories are async (waits up to 90s).',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        image_url: { type: 'string', description: 'Public URL to a JPEG/PNG. 9:16 aspect recommended.' },
        video_url: { type: 'string', description: 'Public URL to an MP4. 9:16 aspect, up to 60 seconds for stories.' },
      },
      required: ['account'],
    },
  },
  {
    name: 'get_post_insights',
    description: 'Get insights (metrics) for a specific post, reel, or video. Defaults to a cross-media-type metric set.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        post_id: { type: 'string', description: 'IG media ID' },
        metrics: { type: 'array', items: { type: 'string' }, description: 'Optional list of metrics to request. Defaults to reach, impressions, saved, likes, comments, shares, total_interactions.' },
      },
      required: ['account', 'post_id'],
    },
  },
  {
    name: 'get_account_insights',
    description: 'Get insights (metrics) for the account itself, over a time window. Defaults to reach, profile_views, follower_count, website_clicks.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        metrics: { type: 'array', items: { type: 'string' }, description: 'Optional list of metrics. Default: reach, profile_views, follower_count, website_clicks.' },
        period: { type: 'string', description: 'day, week, days_28. Default: day.' },
        metric_type: { type: 'string', description: 'Optional metric_type (e.g. total_value) required by some v18+ metrics.' },
        since: { type: 'string', description: 'Optional Unix timestamp lower bound' },
        until: { type: 'string', description: 'Optional Unix timestamp upper bound' },
      },
      required: ['account'],
    },
  },
  {
    name: 'get_tagged_posts',
    description: 'Get posts that have tagged this Instagram account (UGC pickup). Returns media items where the account is photo-tagged.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        limit: { type: 'number', description: 'Number of posts to return (default 25)' },
      },
      required: ['account'],
    },
  },
  {
    name: 'search_hashtag',
    description: 'Search a hashtag and return its top or recent media. Two-step under the hood (search → posts). NOTE: Meta caps unique hashtag searches at 30 per account per 7 days, so use deliberately.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        hashtag: { type: 'string', description: 'Hashtag to search (with or without leading #)' },
        sort: { type: 'string', enum: ['top', 'recent'], description: 'top or recent. Default: top.' },
        limit: { type: 'number', description: 'Number of posts to return (default 25)' },
      },
      required: ['account', 'hashtag'],
    },
  },
  {
    name: 'hide_comment',
    description: 'Hide (or unhide) a comment. Hidden comments stay attached to the post but are not visible to the public.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        comment_id: { type: 'string', description: 'IG comment ID to hide or unhide' },
        hide: { type: 'boolean', description: 'true to hide (default), false to unhide' },
      },
      required: ['account', 'comment_id'],
    },
  },
  {
    name: 'delete_comment',
    description: 'Permanently delete a comment. This action cannot be undone. Use hide_comment first if reversibility matters.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        comment_id: { type: 'string', description: 'IG comment ID to delete' },
      },
      required: ['account', 'comment_id'],
    },
  },
];

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'ouroboros-mcp', version: '1.3.0' },
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
      case 'publish_video':     result = await publishVideo(args.account, args.video_url, args.caption, args.cover_url); break;
      case 'publish_reel':      result = await publishReel(args.account, args.video_url, args.caption, args.cover_url, args.share_to_feed); break;
      case 'publish_story':     result = await publishStory(args.account, { imageUrl: args.image_url, videoUrl: args.video_url }); break;
      case 'get_post_insights': result = await getPostInsights(args.account, args.post_id, args.metrics); break;
      case 'get_account_insights': result = await getAccountInsights(args.account, { metrics: args.metrics, period: args.period, metric_type: args.metric_type, since: args.since, until: args.until }); break;
      case 'get_tagged_posts':  result = await getTaggedPosts(args.account, args.limit); break;
      case 'search_hashtag':    result = await searchHashtag(args.account, args.hashtag, { sort: args.sort, limit: args.limit }); break;
      case 'hide_comment':      result = await hideComment(args.account, args.comment_id, args.hide !== false); break;
      case 'delete_comment':    result = await deleteComment(args.account, args.comment_id); break;
      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

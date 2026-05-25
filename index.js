#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const GRAPH_API_BASE   = 'https://graph.instagram.com/v21.0';
const THREADS_API_BASE = 'https://graph.threads.net/v1.0';

// Load account keys from env. ACCOUNTS is platform-neutral and preferred;
// INSTAGRAM_ACCOUNTS is the legacy fallback (kept so existing installs keep working).
// Per-platform credentials are looked up lazily per call:
//   INSTAGRAM_{KEY}_TOKEN / INSTAGRAM_{KEY}_USER_ID
//   THREADS_{KEY}_TOKEN   / THREADS_{KEY}_USER_ID
function loadAccountKeys() {
  const raw = process.env.ACCOUNTS || process.env.INSTAGRAM_ACCOUNTS || '';
  const keys = raw.split(',').map(k => k.trim()).filter(Boolean);
  if (!keys.length) throw new Error('Set ACCOUNTS (or legacy INSTAGRAM_ACCOUNTS) env var with a comma-separated list of account keys.');
  return keys;
}

const ACCOUNT_KEYS = loadAccountKeys();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getAccount(key) {
  if (!ACCOUNT_KEYS.includes(key)) {
    throw new Error(`Unknown account "${key}". Configured accounts: ${ACCOUNT_KEYS.join(', ')}.`);
  }
  const upper = key.toUpperCase();
  const accessToken = process.env[`INSTAGRAM_${upper}_TOKEN`];
  const userId      = process.env[`INSTAGRAM_${upper}_USER_ID`];
  if (!accessToken || !userId) {
    throw new Error(`Missing Instagram credentials for "${key}". Set INSTAGRAM_${upper}_TOKEN and INSTAGRAM_${upper}_USER_ID.`);
  }
  return { label: key, accessToken, userId };
}

function getThreadsAccount(key) {
  if (!ACCOUNT_KEYS.includes(key)) {
    throw new Error(`Unknown account "${key}". Configured accounts: ${ACCOUNT_KEYS.join(', ')}.`);
  }
  const upper = key.toUpperCase();
  const accessToken = process.env[`THREADS_${upper}_TOKEN`];
  const userId      = process.env[`THREADS_${upper}_USER_ID`];
  if (!accessToken || !userId) {
    throw new Error(`Missing Threads credentials for "${key}". Set THREADS_${upper}_TOKEN and THREADS_${upper}_USER_ID.`);
  }
  return { label: key, accessToken, userId };
}

async function graph(endpoint, method = 'GET', params = {}) {
  return apiCall(GRAPH_API_BASE, endpoint, method, params);
}

async function threadsGraph(endpoint, method = 'GET', params = {}) {
  return apiCall(THREADS_API_BASE, endpoint, method, params);
}

async function apiCall(base, endpoint, method, params) {
  const url = new URL(`${base}${endpoint}`);
  const options = { method };

  if (method === 'GET' || method === 'DELETE') {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  } else {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(params);
  }

  const res = await fetch(url.toString(), options);
  const data = await res.json();
  if (data.error) throw new Error(`${base.includes('threads') ? 'Threads API' : 'Graph API'}: ${data.error.message} (code ${data.error.code})`);
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
  // Universally safe defaults across image, carousel, video, and reel.
  // 'impressions' was deprecated April 2025 (use 'views' for video/reel specifically).
  const metric = metrics && metrics.length
    ? metrics.join(',')
    : 'reach,likes,comments,shares,saved,total_interactions';
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
  // Safe defaults for the standard query (no metric_type required).
  // For 'profile_views', 'accounts_engaged', 'website_clicks', etc, pass them
  // explicitly via metrics AND set metric_type='total_value'.
  const metric = metrics && metrics.length
    ? metrics.join(',')
    : 'reach,follower_count';
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

// ─── Threads ──────────────────────────────────────────────────────────────────

async function waitForThreadsContainer(creationId, accessToken, { maxWaitMs = 90000, pollMs = 3000 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < maxWaitMs) {
    last = await threadsGraph(`/${creationId}`, 'GET', {
      fields: 'status,error_message',
      access_token: accessToken,
    });
    if (last.status === 'FINISHED' || last.status === 'PUBLISHED') return last;
    if (last.status === 'ERROR' || last.status === 'EXPIRED') {
      throw new Error(`Threads container ${last.status}: ${last.error_message || 'no detail'}`);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error(`Threads container did not finish within ${maxWaitMs / 1000}s. Last status: ${last && last.status}`);
}

async function threadsGetAccount(key) {
  const { accessToken, userId, label } = getThreadsAccount(key);
  const data = await threadsGraph(`/${userId}`, 'GET', {
    fields: 'id,username,name,threads_profile_picture_url,threads_biography',
    access_token: accessToken,
  });
  return { account: label, ...data };
}

async function threadsGetRecent(key, limit = 10) {
  const { accessToken, userId } = getThreadsAccount(key);
  return threadsGraph(`/${userId}/threads`, 'GET', {
    fields: 'id,media_type,media_url,permalink,owner,username,text,timestamp,shortcode,is_quote_post,has_replies,is_reply,reply_audience',
    limit,
    access_token: accessToken,
  });
}

async function threadsGetPost(key, threadId) {
  const { accessToken } = getThreadsAccount(key);
  return threadsGraph(`/${threadId}`, 'GET', {
    fields: 'id,media_type,media_url,permalink,owner,username,text,timestamp,shortcode,is_quote_post,has_replies,root_post,replied_to,is_reply,reply_audience',
    access_token: accessToken,
  });
}

async function threadsGetReplies(key, threadId, { conversation = false } = {}) {
  const { accessToken } = getThreadsAccount(key);
  const edge = conversation ? 'conversation' : 'replies';
  return threadsGraph(`/${threadId}/${edge}`, 'GET', {
    fields: 'id,text,username,timestamp,media_type,media_url,permalink,is_reply,replied_to,has_replies,root_post,hide_status',
    access_token: accessToken,
  });
}

// Internal: build a single (non-carousel-item) thread and publish it.
async function publishThread(key, { text, imageUrl, videoUrl, replyToId, replyControl, altText, linkAttachment } = {}) {
  const { accessToken, userId } = getThreadsAccount(key);
  if (!text && !imageUrl && !videoUrl) throw new Error('Threads publish needs at least text, image_url, or video_url.');
  if (imageUrl && videoUrl) throw new Error('Provide image_url OR video_url, not both. Use threads_publish_carousel for multi-media.');

  let mediaType = 'TEXT';
  const params = { access_token: accessToken };
  if (imageUrl) {
    mediaType = 'IMAGE';
    params.image_url = imageUrl;
  } else if (videoUrl) {
    mediaType = 'VIDEO';
    params.video_url = videoUrl;
  }
  params.media_type = mediaType;
  if (text) params.text = text;
  if (replyToId) params.reply_to_id = replyToId;
  if (replyControl) params.reply_control = replyControl;
  if (altText) params.alt_text = altText;
  if (linkAttachment) params.link_attachment = linkAttachment;

  const container = await threadsGraph(`/${userId}/threads`, 'POST', params);
  // Video needs processing; image and text generally don't, but the publish step still polls server-side.
  if (videoUrl) await waitForThreadsContainer(container.id, accessToken);
  const result = await threadsGraph(`/${userId}/threads_publish`, 'POST', {
    creation_id: container.id,
    access_token: accessToken,
  });
  return { success: true, post_id: result.id, type: mediaType.toLowerCase(), text: text || null, reply_to_id: replyToId || null };
}

async function threadsPublish(key, args) {
  return publishThread(key, args);
}

async function threadsReply(key, { replyToId, text, imageUrl, videoUrl, replyControl }) {
  if (!replyToId) throw new Error('reply_to_id is required for threads_reply.');
  return publishThread(key, { text, imageUrl, videoUrl, replyToId, replyControl });
}

async function threadsPublishCarousel(key, { items, text, replyToId, replyControl }) {
  const { accessToken, userId } = getThreadsAccount(key);
  if (!items || items.length < 2) throw new Error('threads_publish_carousel needs at least 2 items.');
  if (items.length > 20) throw new Error('Threads carousels accept up to 20 items.');

  // Step 1: build a container for each item with is_carousel_item: true
  const childIds = [];
  for (const item of items) {
    if (!item.url) throw new Error('Each carousel item needs a url.');
    const itemType = (item.type || 'image').toLowerCase();
    if (!['image', 'video'].includes(itemType)) throw new Error(`Carousel item type must be image or video. Got: ${item.type}`);
    const params = {
      is_carousel_item: true,
      media_type: itemType.toUpperCase(),
      access_token: accessToken,
    };
    if (itemType === 'image') params.image_url = item.url;
    else params.video_url = item.url;
    if (item.alt_text) params.alt_text = item.alt_text;
    const child = await threadsGraph(`/${userId}/threads`, 'POST', params);
    if (itemType === 'video') await waitForThreadsContainer(child.id, accessToken);
    childIds.push(child.id);
  }

  // Step 2: build the carousel container
  const carouselParams = {
    media_type: 'CAROUSEL',
    children: childIds.join(','),
    access_token: accessToken,
  };
  if (text) carouselParams.text = text;
  if (replyToId) carouselParams.reply_to_id = replyToId;
  if (replyControl) carouselParams.reply_control = replyControl;
  const carousel = await threadsGraph(`/${userId}/threads`, 'POST', carouselParams);

  // Step 3: publish
  const result = await threadsGraph(`/${userId}/threads_publish`, 'POST', {
    creation_id: carousel.id,
    access_token: accessToken,
  });
  return { success: true, post_id: result.id, type: 'carousel', item_count: items.length, text: text || null, reply_to_id: replyToId || null };
}

async function threadsGetPostInsights(key, threadId, metrics) {
  const { accessToken } = getThreadsAccount(key);
  const metric = metrics && metrics.length
    ? metrics.join(',')
    : 'views,likes,replies,reposts,quotes,shares';
  return threadsGraph(`/${threadId}/insights`, 'GET', {
    metric,
    access_token: accessToken,
  });
}

async function threadsGetAccountInsights(key, { metrics, since, until } = {}) {
  const { accessToken, userId } = getThreadsAccount(key);
  const metric = metrics && metrics.length
    ? metrics.join(',')
    : 'views,likes,replies,reposts,quotes,followers_count';
  const params = { metric, access_token: accessToken };
  if (since) params.since = since;
  if (until) params.until = until;
  return threadsGraph(`/${userId}/threads_insights`, 'GET', params);
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const accountNames = ACCOUNT_KEYS.join(', ');
const accountDesc = `Account key as defined in ACCOUNTS env var (configured: ${accountNames})`;

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
    description: 'Get insights (metrics) for a specific post, reel, or video. Universally safe defaults across all media types. For video/reel-specific metrics like views, ig_reels_avg_watch_time, plays, pass them explicitly via metrics.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        post_id: { type: 'string', description: 'IG media ID' },
        metrics: { type: 'array', items: { type: 'string' }, description: 'Optional list of metrics. Default: reach, likes, comments, shares, saved, total_interactions. The legacy "impressions" metric was deprecated April 2025; use "views" for video and reel.' },
      },
      required: ['account', 'post_id'],
    },
  },
  {
    name: 'get_account_insights',
    description: 'Get insights (metrics) for the account itself, over a time window. Default returns reach and follower_count. For profile_views, accounts_engaged, website_clicks, etc, pass them in metrics AND set metric_type to total_value.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        metrics: { type: 'array', items: { type: 'string' }, description: 'Optional list of metrics. Default: reach, follower_count. For profile_views, accounts_engaged, website_clicks, set metric_type=total_value.' },
        period: { type: 'string', description: 'day, week, days_28. Default: day.' },
        metric_type: { type: 'string', description: 'Set to total_value for the newer aggregate metrics (profile_views, accounts_engaged, website_clicks, etc).' },
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

  // ─── Threads ────────────────────────────────────────────────────────────────

  {
    name: 'threads_get_account',
    description: 'Get Threads profile info (id, username, name, profile picture, biography). Requires THREADS_{KEY}_TOKEN and THREADS_{KEY}_USER_ID.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
      },
      required: ['account'],
    },
  },
  {
    name: 'threads_get_recent',
    description: 'Get recent threads (posts) from the authenticated Threads account.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        limit: { type: 'number', description: 'Number of threads to return (default 10)' },
      },
      required: ['account'],
    },
  },
  {
    name: 'threads_get_post',
    description: 'Get full details for a single thread by ID, including reply chain context.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        thread_id: { type: 'string', description: 'Threads media ID' },
      },
      required: ['account', 'thread_id'],
    },
  },
  {
    name: 'threads_get_replies',
    description: 'Get replies to a specific thread. Pass conversation=true for the full conversation tree instead of direct replies only.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        thread_id: { type: 'string', description: 'Threads media ID to fetch replies for' },
        conversation: { type: 'boolean', description: 'true for full conversation tree, false (default) for direct replies only' },
      },
      required: ['account', 'thread_id'],
    },
  },
  {
    name: 'threads_publish',
    description: 'Publish a thread. Text-only, image, or video. Provide text alone, or text plus exactly one of image_url or video_url. Video posts wait for Meta to process.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        text: { type: 'string', description: 'Post text. Up to 500 characters.' },
        image_url: { type: 'string', description: 'Public URL to a JPEG/PNG (optional)' },
        video_url: { type: 'string', description: 'Public URL to an MP4 (optional, mutually exclusive with image_url)' },
        reply_to_id: { type: 'string', description: 'Optional. If set, this post becomes a reply to the given thread. Prefer threads_reply for clarity.' },
        reply_control: { type: 'string', enum: ['everyone', 'accounts_you_follow', 'mentioned_only'], description: 'Who can reply. Default: everyone.' },
        alt_text: { type: 'string', description: 'Optional accessibility alt text for the image' },
        link_attachment: { type: 'string', description: 'Optional URL to attach as a link preview (text-only posts)' },
      },
      required: ['account'],
    },
  },
  {
    name: 'threads_publish_carousel',
    description: 'Publish a Threads carousel: 2 to 20 image/video items with optional shared text.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['image', 'video'], description: 'image or video' },
              url: { type: 'string', description: 'Public URL to the media' },
              alt_text: { type: 'string', description: 'Optional alt text' },
            },
            required: ['url'],
          },
          description: '2 to 20 carousel items',
        },
        text: { type: 'string', description: 'Optional caption shared across the carousel' },
        reply_to_id: { type: 'string', description: 'Optional reply target' },
        reply_control: { type: 'string', enum: ['everyone', 'accounts_you_follow', 'mentioned_only'], description: 'Who can reply' },
      },
      required: ['account', 'items'],
    },
  },
  {
    name: 'threads_reply',
    description: 'Reply to a thread. Same shape as threads_publish but reply_to_id is required.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        reply_to_id: { type: 'string', description: 'Thread ID to reply to' },
        text: { type: 'string', description: 'Reply text' },
        image_url: { type: 'string', description: 'Optional image URL' },
        video_url: { type: 'string', description: 'Optional video URL (mutually exclusive with image_url)' },
        reply_control: { type: 'string', enum: ['everyone', 'accounts_you_follow', 'mentioned_only'], description: 'Who can reply to this reply' },
      },
      required: ['account', 'reply_to_id'],
    },
  },
  {
    name: 'threads_get_post_insights',
    description: 'Get insights for a specific thread. Defaults to views, likes, replies, reposts, quotes, shares.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        thread_id: { type: 'string', description: 'Threads media ID' },
        metrics: { type: 'array', items: { type: 'string' }, description: 'Optional metrics list. Default: views, likes, replies, reposts, quotes, shares.' },
      },
      required: ['account', 'thread_id'],
    },
  },
  {
    name: 'threads_get_account_insights',
    description: 'Get account-level Threads insights. Defaults to views, likes, replies, reposts, quotes, followers_count.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: accountDesc },
        metrics: { type: 'array', items: { type: 'string' }, description: 'Optional metrics list. Default: views, likes, replies, reposts, quotes, followers_count.' },
        since: { type: 'string', description: 'Optional Unix timestamp lower bound' },
        until: { type: 'string', description: 'Optional Unix timestamp upper bound' },
      },
      required: ['account'],
    },
  },
];

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'ouroboros-mcp', version: '1.4.0' },
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
      case 'threads_get_account':           result = await threadsGetAccount(args.account); break;
      case 'threads_get_recent':            result = await threadsGetRecent(args.account, args.limit); break;
      case 'threads_get_post':              result = await threadsGetPost(args.account, args.thread_id); break;
      case 'threads_get_replies':           result = await threadsGetReplies(args.account, args.thread_id, { conversation: args.conversation }); break;
      case 'threads_publish':               result = await threadsPublish(args.account, { text: args.text, imageUrl: args.image_url, videoUrl: args.video_url, replyToId: args.reply_to_id, replyControl: args.reply_control, altText: args.alt_text, linkAttachment: args.link_attachment }); break;
      case 'threads_publish_carousel':      result = await threadsPublishCarousel(args.account, { items: args.items, text: args.text, replyToId: args.reply_to_id, replyControl: args.reply_control }); break;
      case 'threads_reply':                 result = await threadsReply(args.account, { replyToId: args.reply_to_id, text: args.text, imageUrl: args.image_url, videoUrl: args.video_url, replyControl: args.reply_control }); break;
      case 'threads_get_post_insights':     result = await threadsGetPostInsights(args.account, args.thread_id, args.metrics); break;
      case 'threads_get_account_insights':  result = await threadsGetAccountInsights(args.account, { metrics: args.metrics, since: args.since, until: args.until }); break;
      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

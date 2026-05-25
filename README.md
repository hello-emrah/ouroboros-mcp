<p align="center">
  <img src="assets/logo.png" alt="Ouroboros" width="240" />
</p>

<h1 align="center">Ouroboros</h1>

<p align="center">
  An MCP server for the Meta Graph API.<br/>
  <strong>Instagram</strong>: photos, carousels, Reels, Stories, video, DMs, comments, moderation, insights, tagged posts, hashtag search.<br/>
  <strong>Threads</strong>: text, image, video, carousels, replies, conversations, insights.<br/>
  Across multiple accounts.<br/>
  <strong>The endless loop, on your terms.</strong>
</p>

<p align="center">
  <a href="https://buymeacoffee.com/hello_emrah"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-c46b44?logo=buymeacoffee&logoColor=ffffff&style=for-the-badge" alt="Buy Me a Coffee" /></a>
</p>

---

The serpent eats her tail. The platform's content cycle is endless and so is the rhythm of working it: post, reply, monitor, post again. Ouroboros wraps Meta's Graph API so the cycle runs through Claude Code instead of a browser tab and a phone. The lotus crown on the mark is the reminder: you sit above the loop, not inside it.

> [!important] **URLs, not local files.**
> Meta's publishing endpoints (both Instagram and Threads) do not accept local file uploads. Every `publish_*` and `threads_publish*` tool takes a **publicly accessible URL** as input. Host your media somewhere reachable (S3, Cloudflare R2, your own CDN, a public bucket) and pass the URL. This is a Meta limitation, not an Ouroboros one. If your asset is on disk, upload it to a host first.

## Features

### Instagram
- Publish **photos**, **carousels**, **Reels**, **Stories**, and **feed video**
- Read and send **DMs**
- Read, reply, **hide**, and **delete** **comments**
- Pull **post insights** (per-post metrics) and **account insights** (account-level metrics)
- Discover **tagged posts** (UGC pickup) and **search hashtags** (top or recent media)
- Fetch account info and recent posts

### Threads
- Publish **text**, **image**, **video**, and **carousel** threads
- **Reply** to threads with media support
- Read recent threads, single posts, replies, and full conversations
- Pull **post** and **account insights**

### Shared
- **Multi-account support**, configure any number of accounts via env vars, no code changes
- **Same account key, multiple platforms**: a single account key (`koda`) carries credentials for both Instagram and Threads via separate `INSTAGRAM_*` and `THREADS_*` env vars

## Requirements

- Node.js 18+
- Instagram Business or Creator account
- Meta Developer App with Instagram Graph API enabled

## Installation

```bash
git clone https://github.com/hello-emrah/ouroboros-mcp.git
cd ouroboros-mcp
npm install
```

## Configuration

Copy `.env.example` to `.env` and fill in your credentials.

```bash
cp .env.example .env
```

```env
# Comma-separated list of account keys (name them whatever you like).
# A key can carry Instagram credentials, Threads credentials, or both.
ACCOUNTS=myaccount,mybusiness

# Instagram credentials per account key (omit if the account doesn't use IG tools)
INSTAGRAM_MYACCOUNT_TOKEN=your_long_lived_ig_access_token
INSTAGRAM_MYACCOUNT_USER_ID=your_instagram_user_id

INSTAGRAM_MYBUSINESS_TOKEN=your_long_lived_ig_access_token
INSTAGRAM_MYBUSINESS_USER_ID=your_instagram_user_id

# Threads credentials per account key (omit if the account doesn't use Threads tools)
THREADS_MYACCOUNT_TOKEN=your_long_lived_threads_access_token
THREADS_MYACCOUNT_USER_ID=your_threads_user_id

META_APP_ID=your_app_id
META_APP_SECRET=your_app_secret
```

> The legacy `INSTAGRAM_ACCOUNTS` env var is still accepted as the account-key registry for backwards compatibility. New installs should prefer `ACCOUNTS`.

### Getting your credentials

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps/) and create a **Business** app
2. Add the products you need to your app: **Instagram Graph API** for Instagram tools, **Threads** for Threads tools
3. Under Settings → Basic, copy your App ID and App Secret

**For Instagram:** add these permissions under App Review → Permissions:
- `instagram_business_basic`
- `instagram_content_publish`
- `instagram_manage_comments`
- `instagram_manage_insights`
- `instagram_manage_messages` *(requires Meta app review for production; works in dev mode for your own accounts)*

Generate a long-lived access token via the Instagram API setup page (the token from "Generate token" is already 60-day long-lived). Call `GET /me?fields=id,username` on `graph.instagram.com` to get each account's User ID.

**For Threads:** add these permissions:
- `threads_basic`
- `threads_content_publish`
- `threads_manage_replies`
- `threads_manage_insights`

Generate a Threads access token via the Threads API setup page in your Meta Developer App. Call `GET /me?fields=id,username` on `graph.threads.net` to get the Threads User ID for each account.

## Wiring into Claude Code

Add to your `~/.claude.json` under `mcpServers`:

```json
"ouroboros": {
  "command": "node",
  "args": ["/path/to/ouroboros-mcp/index.js"],
  "env": {
    "ACCOUNTS": "myaccount,mybusiness",
    "INSTAGRAM_MYACCOUNT_TOKEN": "...",
    "INSTAGRAM_MYACCOUNT_USER_ID": "...",
    "THREADS_MYACCOUNT_TOKEN": "...",
    "THREADS_MYACCOUNT_USER_ID": "...",
    "INSTAGRAM_MYBUSINESS_TOKEN": "...",
    "INSTAGRAM_MYBUSINESS_USER_ID": "...",
    "META_APP_ID": "...",
    "META_APP_SECRET": "..."
  }
}
```

Each account key only needs the credentials for the platforms it will use. An IG-only account omits the `THREADS_*` vars; a Threads-only account omits the `INSTAGRAM_*` ones; both means both. Tools error cleanly if you call them for a platform the account isn't credentialed for.

Restart Claude Code. Tools appear under the `mcp__ouroboros__*` namespace.

## Tools

Twenty-seven tools across Instagram (18) and Threads (9). All take an `account` parameter matching one of your configured account keys.

## Instagram tools

### Account

| Tool | Description |
|---|---|
| `get_account_info` | Profile info, follower count, bio |
| `get_recent_posts` | Recent media with likes and comments counts |
| `get_account_insights` | Account-level metrics (reach, follower_count) over a window |

### Publishing

| Tool | Description |
|---|---|
| `publish_photo` | Single image post |
| `publish_carousel` | Multi-image carousel (2 to 10 images) |
| `publish_video` | Feed video post (MP4 URL). Async, waits up to 90s for Meta to process. |
| `publish_reel` | Reel (MP4 URL). Async. `share_to_feed` defaults true. |
| `publish_story` | Story, either image or video. Async for video stories. |

### Comments and DMs

| Tool | Description |
|---|---|
| `get_post_comments` | Comments on a post, including replies |
| `reply_to_comment` | Reply to a specific comment |
| `hide_comment` | Hide (or unhide) a comment |
| `delete_comment` | Permanently delete a comment |
| `get_conversations` | List DM conversations |
| `get_messages` | Messages within a conversation |
| `send_message` | Send a DM to a user |

### Insights

| Tool | Description |
|---|---|
| `get_post_insights` | Per-post metrics. Universally safe defaults: reach, likes, comments, shares, saved, total_interactions. For video/reel-specific (views, ig_reels_avg_watch_time, plays), pass them explicitly. |
| `get_account_insights` | Account-level metrics over a window. Defaults: reach, follower_count. For profile_views, accounts_engaged, website_clicks, set `metric_type=total_value`. |

### Discovery

| Tool | Description |
|---|---|
| `get_tagged_posts` | Posts that tagged this account (UGC pickup) |
| `search_hashtag` | Top or recent media for a given hashtag. **Rate limited: 30 unique hashtag searches per account per 7 days.** |

## Threads tools

### Account

| Tool | Description |
|---|---|
| `threads_get_account` | Profile info (id, username, name, picture, biography) |
| `threads_get_recent` | Recent threads from the account |
| `threads_get_account_insights` | Account-level metrics. Default: views, likes, replies, reposts, quotes, followers_count. |

### Reading

| Tool | Description |
|---|---|
| `threads_get_post` | Full details for a single thread by ID |
| `threads_get_replies` | Replies to a thread. Pass `conversation: true` for the full conversation tree. |

### Publishing

| Tool | Description |
|---|---|
| `threads_publish` | Text, image, or video thread. Up to 500 characters of text. Optional `reply_control` and `link_attachment`. |
| `threads_publish_carousel` | Multi-item carousel: 2 to 20 image / video items with shared text. |
| `threads_reply` | Reply to a specific thread. Same shape as `threads_publish` plus `reply_to_id` required. |

### Insights

| Tool | Description |
|---|---|
| `threads_get_post_insights` | Per-thread metrics. Default: views, likes, replies, reposts, quotes, shares. |
| `threads_get_account_insights` | (also listed under Account) |

## Format and size constraints

Meta enforces format and size limits on the publishing endpoints. Ouroboros passes your URL through, so check your media against these before publishing:

### Instagram

| Tool | Format | Aspect | Duration | Notes |
|---|---|---|---|---|
| `publish_photo` | JPEG, PNG | 4:5 to 1.91:1 | — | Min 320px, max 1440px wide |
| `publish_carousel` | JPEG, PNG | 4:5 to 1.91:1 | — | 2 to 10 images, all same aspect |
| `publish_video` | MP4, MOV (H.264 / AAC) | 4:5 to 16:9 | Up to 60 min | 30fps recommended |
| `publish_reel` | MP4 (H.264 / AAC) | 9:16 | Up to 90s | 30fps recommended, min 720x1280 |
| `publish_story` (image) | JPEG, PNG | 9:16 recommended | — | — |
| `publish_story` (video) | MP4 (H.264 / AAC) | 9:16 recommended | Up to 60s | — |

### Threads

| Tool | Text | Media | Notes |
|---|---|---|---|
| `threads_publish` (text) | Up to 500 chars | — | Optional `link_attachment` URL |
| `threads_publish` (image) | Up to 500 chars | JPEG, PNG (public URL) | Max 8MB |
| `threads_publish` (video) | Up to 500 chars | MP4 (H.264 / AAC, public URL) | Up to 5 min, async |
| `threads_publish_carousel` | Up to 500 chars shared | 2 to 20 image/video items | Each item is a separate container under the hood |
| `threads_reply` | Up to 500 chars | Image or video, same rules | Requires `reply_to_id` |

## Notes

- **Publishing takes URLs, not files.** Repeated from above because it bites everyone once. Local file uploads are not supported by Meta's publishing endpoints. Host your asset somewhere reachable and pass the URL.
- **Async publishing.** `publish_video`, `publish_reel`, and `publish_story` (video) wait up to 90 seconds for Meta to process the upload. Larger files may need a longer wait; if you hit the timeout the container often finishes anyway and you can retry the publish step.
- **Errors come back inline.** When Meta rejects a call (bad URL, expired token, missing permission, format mismatch), the error message and code surface in the tool's response. No silent failures.
- **DM sending** requires `instagram_manage_messages`. Works in dev mode for accounts added as app testers; requires Meta app review for general use.
- **Insights** require their platform-specific permission: `instagram_manage_insights` for IG, `threads_manage_insights` for Threads. The legacy IG `impressions` metric was deprecated by Meta on 2 April 2025 for posts, reels, videos, and carousels; use `views` for video and reel where you need that surface. IG account-level metrics like `profile_views`, `accounts_engaged`, and `website_clicks` are now part of the v18+ aggregate set: pass them in `metrics` AND set `metric_type=total_value`.
- **Threads reply control.** `reply_control` accepts `everyone` (default), `accounts_you_follow`, or `mentioned_only`. Set on the top-level publish call, not per reply.
- **Long-lived tokens** expire after 60 days. Refresh IG tokens via `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=...`. Refresh Threads tokens via the equivalent endpoint on `graph.threads.net`. Or rotate from the Meta dashboard.

## Design philosophy

The visual mark and the tool itself were built deliberately against the visual language of capitalist software design. Single-shade flat seals in considered colours, ancient-glyph silhouettes, generous whitespace. The mark could be pressed into wax or carved into stone. The Meta-blue here is intentional, a wink: an ouroboros-shaped tool wrapping Meta's own infinity-looped API.

Built for personal use and shared openly. Not productised, not monetised, not instrumented. Use it for your own work or fork it for yours.

## License

MIT

<p align="center">
  <img src="assets/logo.png" alt="Ouroboros" width="240" />
</p>

<h1 align="center">Ouroboros</h1>

<p align="center">
  An MCP server for the Instagram Graph API.<br/>
  Photos, carousels, Reels, Stories, video. DMs. Comments and moderation.<br/>
  Insights. Tagged posts. Hashtag search.<br/>
  Across multiple accounts.<br/>
  <strong>The endless loop, on your terms.</strong>
</p>

<p align="center">
  <a href="https://buymeacoffee.com/hello_emrah"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-c46b44?logo=buymeacoffee&logoColor=ffffff&style=for-the-badge" alt="Buy Me a Coffee" /></a>
</p>

---

The serpent eats her tail. The platform's content cycle is endless and so is the rhythm of working it: post, reply, monitor, post again. Ouroboros wraps Meta's Graph API so the cycle runs through Claude Code instead of a browser tab and a phone. The lotus crown on the mark is the reminder: you sit above the loop, not inside it.

> [!important] **URLs, not local files.**
> Instagram's Graph API does not accept local file uploads from the publishing endpoints. Every `publish_*` tool here takes a **publicly accessible URL** as input. Host your media somewhere reachable (S3, Cloudflare R2, your own CDN, a public bucket) and pass the URL. This is a Meta limitation, not an Ouroboros one. If your asset is on disk, upload it to a host first.

## Features

- Publish **photos**, **carousels**, **Reels**, **Stories**, and **feed video**
- Read and send **DMs**
- Read, reply, **hide**, and **delete** **comments**
- Pull **post insights** (per-post metrics) and **account insights** (account-level metrics)
- Discover **tagged posts** (UGC pickup) and **search hashtags** (top or recent media)
- Fetch account info and recent posts
- **Multi-account support**, configure any number of accounts via env vars, no code changes

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
# Comma-separated list of account keys (name them whatever you like)
INSTAGRAM_ACCOUNTS=myaccount,mybusiness

# Repeat for each account key
INSTAGRAM_MYACCOUNT_TOKEN=your_long_lived_access_token
INSTAGRAM_MYACCOUNT_USER_ID=your_instagram_user_id

INSTAGRAM_MYBUSINESS_TOKEN=your_long_lived_access_token
INSTAGRAM_MYBUSINESS_USER_ID=your_instagram_user_id

META_APP_ID=your_app_id
META_APP_SECRET=your_app_secret
```

### Getting your credentials

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps/) and create a **Business** app
2. Add the **Instagram Graph API** product to your app
3. Under Settings → Basic, copy your App ID and App Secret
4. Add these permissions under App Review → Permissions:
   - `instagram_business_basic`
   - `instagram_content_publish`
   - `instagram_manage_comments`
   - `instagram_manage_messages` *(requires Meta app review for production; works in dev mode for your own accounts)*
5. Use the [Graph API Explorer](https://developers.facebook.com/tools/explorer) to generate a User Token, then exchange it for a long-lived token (60 days)
6. Call `GET /me?fields=id,username` to get each account's User ID

## Wiring into Claude Code

Add to your `~/.claude.json` under `mcpServers`:

```json
"ouroboros": {
  "command": "node",
  "args": ["/path/to/ouroboros-mcp/index.js"],
  "env": {
    "INSTAGRAM_ACCOUNTS": "myaccount,mybusiness",
    "INSTAGRAM_MYACCOUNT_TOKEN": "...",
    "INSTAGRAM_MYACCOUNT_USER_ID": "...",
    "INSTAGRAM_MYBUSINESS_TOKEN": "...",
    "INSTAGRAM_MYBUSINESS_USER_ID": "...",
    "META_APP_ID": "...",
    "META_APP_SECRET": "..."
  }
}
```

Restart Claude Code. Tools appear under the `mcp__ouroboros__*` namespace.

## Tools

Eighteen tools across account, publishing, comments and DMs, insights, and discovery. All take an `account` parameter matching one of your configured account keys.

### Account

| Tool | Description |
|---|---|
| `get_account_info` | Profile info, follower count, bio |
| `get_recent_posts` | Recent media with likes and comments counts |
| `get_account_insights` | Account-level metrics (reach, profile views, follower count, website clicks) over a window |

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
| `get_post_insights` | Per-post metrics (reach, impressions, saved, likes, comments, shares, total interactions) |
| `get_account_insights` | Account-level metrics over a window (also listed under Account) |

### Discovery

| Tool | Description |
|---|---|
| `get_tagged_posts` | Posts that tagged this account (UGC pickup) |
| `search_hashtag` | Top or recent media for a given hashtag. **Rate limited: 30 unique hashtag searches per account per 7 days.** |

## Format and size constraints

Meta enforces format and size limits on the publishing endpoints. Ouroboros passes your URL through, so check your media against these before publishing:

| Tool | Format | Aspect | Duration | Notes |
|---|---|---|---|---|
| `publish_photo` | JPEG, PNG | 4:5 to 1.91:1 | — | Min 320px, max 1440px wide |
| `publish_carousel` | JPEG, PNG | 4:5 to 1.91:1 | — | 2 to 10 images, all same aspect |
| `publish_video` | MP4, MOV (H.264 / AAC) | 4:5 to 16:9 | Up to 60 min | 30fps recommended |
| `publish_reel` | MP4 (H.264 / AAC) | 9:16 | Up to 90s | 30fps recommended, min 720x1280 |
| `publish_story` (image) | JPEG, PNG | 9:16 recommended | — | — |
| `publish_story` (video) | MP4 (H.264 / AAC) | 9:16 recommended | Up to 60s | — |

## Notes

- **Publishing takes URLs, not files.** Repeated from above because it bites everyone once. Local file uploads are not supported by Meta's publishing endpoints. Host your asset somewhere reachable and pass the URL.
- **Async publishing.** `publish_video`, `publish_reel`, and `publish_story` (video) wait up to 90 seconds for Meta to process the upload. Larger files may need a longer wait; if you hit the timeout the container often finishes anyway and you can retry the publish step.
- **Errors come back inline.** When Meta rejects a call (bad URL, expired token, missing permission, format mismatch), the error message and code surface in the tool's response. No silent failures.
- **DM sending** requires `instagram_manage_messages`. Works in dev mode for accounts added as app testers; requires Meta app review for general use.
- **Insights** requires `instagram_manage_insights`. Some newer account metrics need `metric_type=total_value` and a `period`; pass these through if the docs call for them.
- **Long-lived tokens** expire after 60 days. Refresh via `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=...` or rotate from the Meta dashboard.

## Design philosophy

The visual mark and the tool itself were built deliberately against the visual language of capitalist software design. Single-shade flat seals in considered colours, ancient-glyph silhouettes, generous whitespace. The mark could be pressed into wax or carved into stone. The Meta-blue here is intentional, a wink: an ouroboros-shaped tool wrapping Meta's own infinity-looped API.

Built for personal use and shared openly. Not productised, not monetised, not instrumented. Use it for your own work or fork it for yours.

## License

MIT

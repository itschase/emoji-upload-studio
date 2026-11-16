# Emote Forge Upload Studio

Emote Forge Upload Studio is a hosted, browser-based workspace for preparing and submitting large Emoji.gg libraries. It imports up to 500 PNG or GIF files at once, pairs them with CSV metadata, lets the user correct every record, and coordinates up to ten Emoji.gg upload tabs in parallel.

The application does **not** receive or store imported media. Images, manifests, queue state, and recovery records live in IndexedDB in the user's browser. During an active run, each worker receives only its current batch directly from the Studio page and submits it through Emoji.gg's real form.

## Access requirement

The official production Studio is locked until the user:

1. signs in through Discord OAuth; and
2. is confirmed as a current member of the **Emote Forge** Discord server.

Until verification succeeds, the application exposes only the access screen. Imports, library data, statistics, settings, workers, and queue controls remain unavailable. OAuth may add the user to Emote Forge with explicit approval of the `identify` and `guilds.join` scopes. A secure HTTP-only receipt cookie expires after twelve hours, and the Cloudflare service rechecks current guild membership before unlocking the Studio.

## User workflow

1. Install Tampermonkey and the Studio userscript from the hosted Studio.
2. Open the Studio and authorize Discord membership in Emote Forge.
3. Import image files and, optionally, an `upload_manifest.csv`.
4. Review names, tags, categories, licenses, descriptions, and previews.
5. Allow popups for the Studio, choose 1–10 upload tabs, and start the queue.
6. Keep the Studio open while upload tabs process independent batches of up to ten.

No Node installation, terminal, local server, or desktop companion is required for normal users.

## Main features

- **Browser-local library:** media and queue data use IndexedDB on the current device and browser profile.
- **CSV-assisted imports:** exact-filename metadata matching with generated starter metadata when a CSV is omitted.
- **Metadata editor:** title, prioritized tags, category, license, description, preview, and record removal.
- **Parallel upload-tab orchestration:** 1–10 Emoji.gg tabs with non-overlapping batches of at most ten.
- **Safe result handling:** successful items become `submitted`; explicit failures retry up to three times; ambiguous outcomes become `uncertain` instead of being silently duplicated.
- **Crash recovery:** records left `inflight` after the Studio closes become `uncertain` on the next launch.
- **Combined statistics:** local asset/pack/status totals plus public Emoji.gg profile counts for emojis, stickers, packs, downloads, rank, and loaded-card completeness.
- **Discord access:** signed-in membership is mandatory across the production interface.
- **Private deployment source:** Cloudflare can build directly from a private GitHub repository while serving the public application.

## Privacy and trust boundaries

| Data | Location |
| --- | --- |
| Imported PNG/GIF files | Browser IndexedDB |
| CSV metadata and queue state | Browser IndexedDB |
| Active batch transfer | Directly between the Studio and Emoji.gg upload tab |
| Final media submission | Emoji.gg |
| Discord identity and membership | Discord and the Emote Forge access Worker |
| Discord client secret, bot token, signing key | Encrypted Cloudflare Worker secrets |

The hosted service has no media-upload endpoint. Frontend JavaScript and the Tampermonkey userscript are necessarily delivered to users and can be inspected in their browsers. Repository privacy protects source history and backend implementation; the security boundary depends on server-held secrets, current Discord membership checks, and signed receipts.

## Metadata CSV

Download `upload_manifest.template.csv` from the Studio. Rows are matched by exact filename.

| Field | Value |
| --- | --- |
| `filename` | Exact `.png` or `.gif` filename |
| `title` | Short Emoji.gg display name |
| `tags` | Best-first tags separated with semicolons |
| `description` | Clear SEO-oriented description, up to 2,500 characters |
| `category_value` | Emoji.gg category number `1`–`23` |
| `license` | `CC BY 4.0`, `Basic`, `WTFPL`, or `Streamer` |

The userscript tests tag candidates against Emoji.gg's tag input and keeps up to ten accepted tags. It hashes each site preview and matches it to the original file before entering metadata, so reordered uploads still receive the correct fields.

## Architecture

```text
Private GitHub repository
        │ push
        ▼
Cloudflare Workers Build
        ├── static React/Vite Studio
        └── Discord OAuth + membership service
                    │ HTTP-only signed receipt
                    ▼
Browser Studio (IndexedDB)
        │ File objects via postMessage
        ├── Emoji.gg upload tab 1
        ├── Emoji.gg upload tab 2
        └── ... up to upload tab 10
```

Upload tabs open from a direct user click so the browser can grant popup permission. Each upload tab validates the Studio origin and random run session before accepting a batch. The Studio validates origin, source window, session, upload-tab ID, and batch ID before accepting results.

## Cloudflare deployment

The repository includes `wrangler.toml`, `auth-worker/worker.mjs`, and the production Vite build.

1. Connect a Cloudflare Worker to the private GitHub repository.
2. Use `npm run build` as the build command and `npx wrangler deploy` as the deploy command. `wrangler.toml` serves `dist/` through the Worker asset binding.
3. Set `DISCORD_GUILD_ID` and `ALLOWED_RETURN_ORIGINS` to the final Emote Forge server ID and deployed Studio origin.
4. Generate a state secret and Ed25519 signing pair locally with `node auth-worker/generate-keys.mjs`. Never commit its output.
5. Add these encrypted Worker secrets:
   - `DISCORD_CLIENT_SECRET`
   - `DISCORD_BOT_TOKEN`
   - `STATE_SECRET`
   - `SIGNING_PRIVATE_JWK`
   - `SIGNING_PUBLIC_JWK`
6. Add the exact Discord redirect URL: `https://<studio-host>/oauth/callback`.
7. Add the Emote Forge bot to the server. It does not need message or administrator permissions.
8. Deploy, then install `https://<studio-host>/uploader.user.js` through Tampermonkey.

Cloudflare stores secrets outside the repository. The frontend never receives the Discord client secret or bot token. OAuth state is signed and expires after ten minutes. Access receipts use Ed25519 signatures, are stored in HTTP-only cookies, and expire after twelve hours.

## Discord application

The Discord application is **Emote Forge**, application/client ID `1571592048576831691`. The required server is Emote Forge, guild ID `1571591932290011266`.

Required OAuth scopes:

- `identify`
- `guilds.join`

The Discord client secret and bot token must never appear in source, logs, issues, CSV files, or frontend environment variables.

## Local development

```bash
npm install
npm run dev
```

Open the Vite URL with `?mode=hosted` to preview browser-only mode. Localhost previews bypass Discord membership only for development.

```bash
npm run build
npm test
node --check uploader.user.js
node --check auth-worker/worker.mjs
```

The older Node queue server remains temporarily as a migration and regression-test fallback. It is not required by the hosted user flow.

## Deployment updates

Cloudflare's Git integration can read a private repository after the owner grants access. Every push to the production branch rebuilds the frontend and Worker. Users receive the updated UI on reload. The userscript is served from the same deployment and will use its hosted `@updateURL` and `@downloadURL` after the production hostname is assigned.

## Operational cautions

- Keep the Studio open during an active run.
- Allow popups only for the trusted Studio origin.
- Clearing site data removes the local IndexedDB library; retain original images and CSV files as the durable source.
- A lost worker can leave a result ambiguous. Review `uncertain` records before retrying because Emoji.gg may have accepted the original submission.
- Use only media and metadata you are authorized to submit.

License: [MIT](LICENSE).

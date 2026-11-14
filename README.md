# Emoji.gg Upload Studio

A local dashboard for preparing large emoji uploads. Import PNG and GIF images, edit each image's name, prioritized tags, category, license, and description, then start a queue of any size. A small Tampermonkey worker uses the signed-in [Emoji.gg submission page](https://emoji.gg/submit) to send groups of up to ten, respecting the site's form limit. The studio tracks results and resumes from its saved position.

The dashboard is the working view. The Emoji.gg worker tab stays open in the background. On the Emoji.gg upload page, the worker shows a small status panel with an **Open Upload Studio ↗** link that opens the dashboard in a new tab.

## Why this exists

Emoji.gg's form accepts ten images per submission. Preparing hundreds or thousands by hand requires repeating file selection, metadata entry, and status tracking. This tool stages everything locally first and performs those repeated steps while preserving per-image results. It does not bypass the site's upload limit or use an undocumented upload API.

## Requirements

- Node.js 20 or newer
- A current Chromium browser with [Tampermonkey](https://www.tampermonkey.net/) installed
- An Emoji.gg account signed in on the worker tab
- PNG or GIF images under 256 KiB each

## Installation

1. Download or clone this repository.
2. Copy `config.example.json` to `config.local.json` and set `root` to the folder where the studio should store image packs. You can instead set `EMOJI_QUEUE_ROOT` in your environment. The root is never uploaded as a whole; only queued image files are sent to Emoji.gg.
3. Run `npm start` in this directory.
4. Open **http://127.0.0.1:43861/** in your browser. This is the dashboard, served only on your computer. Keep the server running while uploading.
5. [Install the Upload Studio Worker from Greasy Fork](https://greasyfork.org/en/scripts/605370-emoji-gg-upload-studio-worker) in Tampermonkey, then open **https://emoji.gg/submit** while signed in. A **Local upload queue** panel appears in the lower left. Click **Open Upload Studio ↗** there whenever you want to open the dashboard in a new tab. The worker pairs automatically while the studio is open. Use **Pair worker** in the studio to reopen the 60-second pairing window if necessary.

If the panel does not appear, confirm Tampermonkey is enabled and that you are on the Emoji.gg submission page. If the link opens an unavailable page, start the local server with `npm start`. The Tampermonkey script can update from this repository's raw `uploader.user.js` file; reload existing Emoji.gg tabs after an update.

## Preparing an upload

Choose a pack name and select as many PNG/GIF images as you want under **Import to local draft**. Import saves them to a pack folder under your configured root and creates `upload_manifest.csv` with draft names and descriptions derived from filenames. Nothing is submitted during import.

Review the image previews and edit the metadata cards. Tags are prioritized with semicolons, such as `cat; cute; reaction; emoji`. The worker tries each tag against Emoji.gg's allowed list and requires at least three accepted tag chips before submitting an image. Save changes to write them to the pack's CSV. Existing pack folders with compatible `upload_manifest.csv` files also appear automatically.

Enter the number of pending images to queue, or enter `0` for all pending images. Optionally enter one exact pack-folder name. **Submit queued images** starts the worker. **Pause after batch** and **Resume** control the run. Keep the Emoji.gg worker tab and local server open while it works.

## Progress and recovery

- Each image preview on Emoji.gg is hashed and matched to the source file before metadata is entered, so reordered files receive the correct fields.
- A manifest row becomes `submitted` only when the site's per-item result reports success. Explicit failures become `retry`; ambiguous outcomes become `uncertain` and are not automatically resent.
- Queue position is saved in `.upload-queue` under the configured root. If the server stops during a submission, that in-flight batch is marked `uncertain` for review rather than duplicated automatically.
- A pack folder receives the `.uploaded-` prefix only after every manifest row is `submitted`.
- For an unattended run, `node auto-finish.mjs` watches the queue, performs one bounded pass over explicit `retry` rows, and writes `.upload-queue/auto-finish-report.json`. It leaves `uncertain` rows for review.

Use this only for images you are permitted to submit. The tool is independent of Emoji.gg and may need updates if the site changes its form or tag list.

## Development

Run `npm test` for the local import, catalog, edit, and worker-gate test. The server uses only built-in Node.js modules; no package installation is needed. Personal configuration and local process logs are excluded by `.gitignore`.

License: [MIT](LICENSE).

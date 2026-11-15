# Emoji.gg Upload Studio

A local dashboard for preparing large emoji uploads. Import PNG and GIF images, edit each image's name, prioritized tags, category, license, and description, then start a queue of any size. A small Tampermonkey worker uses the signed-in [Emoji.gg submission page](https://emoji.gg/submit) to send groups of up to ten, respecting the site's form limit. The studio tracks results and resumes from its saved position.

The dashboard is the working view. The Emoji.gg worker tab stays open in the background. On the Emoji.gg upload page, the worker shows a small status panel with submitted, queued, and failed counts, a pause or resume control, and an **Open Upload Studio ↗** link that opens the dashboard in a new tab. Both parts are maintained in this repository: Tampermonkey runs the worker in the browser, while Node.js runs the local dashboard and file queue.

If **Emoji.gg Local Upload Queue** 0.2.x is also installed, disable or remove it. Keep only **Emoji.gg Upload Studio Worker** enabled; the older script can prevent new worker tabs from connecting.

## Why this exists

Emoji.gg's form accepts ten images per submission. Preparing hundreds or thousands by hand requires repeating file selection, metadata entry, and status tracking. This tool stages everything locally first and performs those repeated steps while preserving per-image results. It does not bypass the site's upload limit or use an undocumented upload API.

## Requirements

- Node.js 20 or newer
- A current Chromium browser with [Tampermonkey](https://www.tampermonkey.net/) installed
- An Emoji.gg account signed in on the worker tab
- PNG or GIF images under 256 KiB each

## Installation

1. Clone this repository with Git. Automatic Studio updates require a clean checkout of the official repository; a downloaded ZIP works but cannot update itself.
2. On Windows, double-click **Start Studio.cmd**. On first launch it creates an `upload-packs` folder and local configuration automatically, starts the server, and opens the dashboard. To store packs elsewhere, copy `config.example.json` to `config.local.json` and change `root`, or set `EMOJI_QUEUE_ROOT` in your environment. The root is never uploaded as a whole; only queued image files are sent to Emoji.gg.
3. **Studio Control.cmd** provides Start, Stop, Restart, and Status choices. Alternatively use `npm start`, `npm stop`, `npm restart`, and `npm run status` in a terminal. Stop lets active batches finish before the server closes; restart waits for that shutdown and then opens the Studio again.
4. The default dashboard address is **http://127.0.0.1:43861/**. The dashboard header shows its actual port and configured image folder, so you can tell which local instance you opened. Keep the server running while uploading.
5. [Install the Upload Studio Worker from Greasy Fork](https://greasyfork.org/en/scripts/605370-emoji-gg-upload-studio-worker) in Tampermonkey, then open **https://emoji.gg/submit** while signed in. A **Local upload queue** panel appears in the lower left. Click **Open Upload Studio ↗** there whenever you want to open the dashboard in a new tab. The worker pairs automatically while the studio is open. Use **Pair worker** in the studio to reopen the 60-second pairing window if necessary.

If the panel does not appear, confirm Tampermonkey is enabled and that you are on the Emoji.gg submission page. If the link opens an unavailable page, start the local server with `npm start`. The worker's `@updateURL` and `@downloadURL` point to this repository's raw `uploader.user.js`; Tampermonkey checks it on its own schedule when the installed script has a newer `@version`. Reload existing Emoji.gg tabs after an update so they run the new code. The Studio cannot install or update the Tampermonkey script itself.

The local Studio checks the official GitHub repository when you start it and every 15 minutes while it is open. It installs a clean fast-forward update while the queue is idle or paused, then restarts the local server. During active uploads, it waits for a pause so no batch is interrupted. Local source edits and non-Git copies are left alone. Your queue and manifests stay in the configured image folder and are not replaced by code updates. The dashboard header displays the running Studio version.

If an older Studio server is already using the same port, the launcher reports it instead of opening a misleading dashboard. Finish or safely pause that queue before switching server versions; updating only the userscript does not update the server.

## Five-minute quick start

1. Start the Studio and install the Tampermonkey worker as described above.
2. In **Import a prepared pack**, enter a new pack name and select PNG/GIF images. Optionally select a completed CSV based on **Download CSV template**.
3. Review the generated metadata cards and save any changes.
4. Open one signed-in Emoji.gg submit tab, choose a **Parallel tabs** target, and select **Apply tab count**. The first worker opens the remaining reserved tabs.
5. Choose a pack folder and image count, then select **Submit queued images**. Keep the server and worker tabs open while the queue runs.

## Preparing an upload

Choose a pack name and select as many PNG/GIF images as you want under **Import a prepared pack**. Import saves them to a pack folder under your configured root and creates `upload_manifest.csv` with draft names and descriptions derived from filenames. Nothing is submitted during import.

For a metadata-ready import, download [`upload_manifest.template.csv`](upload_manifest.template.csv), add one row per image, then select the CSV and all matching images together. The CSV import is transactional: the Studio validates and stages every file before the finished pack folder appears. A failed import cannot add renamed duplicates or a half-written manifest to an existing pack.

| CSV field | What to enter |
| --- | --- |
| `filename` | Exact PNG/GIF filename, including extension |
| `title` | Short Emoji.gg name |
| `tags` | Prioritized tags separated by semicolons |
| `description` | Clear SEO-friendly description, up to 2,500 characters |
| `category_value` | Emoji.gg category number `1` through `23` |
| `license` | `CC BY 4.0`, `Basic`, `WTFPL`, or `Streamer` |

Category values are: `1` Original Style, `2` TV / Movie, `3` Meme, `4` Anime, `5` Celebrity, `6` Blobs, `7` Thinking, `8` Animated, `9` NSFW, `10` Gaming, `11` Letters, `12` Other, `13` Pepe, `14` Logos, `15` Cute, `16` Utility, `17` Animals, `18` Recolors, `19` Flags, `20` Hearts, `21` Pixel Art, `22` Reactions, and `23` Aesthetic.

Review the image previews and edit the metadata cards. Tags are prioritized with semicolons, such as `cat; cute; reaction; emoji`. The worker tries each tag against Emoji.gg's allowed list and requires at least three accepted tag chips before submitting an image. Save changes to write them to the pack's CSV. Existing pack folders with compatible `upload_manifest.csv` files also appear automatically.

Enter the number of pending images to queue, or enter `0` for all pending images. Optionally enter one exact pack-folder name. Choose **1–10 parallel tabs**. **Apply tab count** reserves unique worker identities and opens only the missing tabs, even while the queue is paused. Slow tabs retain their reservation for one minute, preventing repeated reconciliation from opening duplicate workers. **Submit queued images** starts the queue. Each healthy tab receives its own non-overlapping batch of at most ten images. **Pause after batch** and **Resume** control the run. Keep the Emoji.gg worker tabs and local server open while it works. Start with one tab if Emoji.gg limits concurrent submissions on your account.

Already-open worker tabs are reused before new tabs are created. Outdated workers are shown separately and perform a one-time reload after the userscript update is installed. Ownership is bound to both the worker identity and its live page instance, so a duplicate or stale page cannot quarantine the active page's submission. A replacement page may take over only after the previous page stops heartbeating.

## Progress and recovery

- Each image preview on Emoji.gg is hashed and matched to the source file before metadata is entered, so reordered files receive the correct fields.
- A manifest row becomes `submitted` only when the site's per-item result reports success. An explicit site failure is returned to the front of the remaining queue immediately, for up to three automatic retries, so it can recover during the current run instead of waiting until every other item finishes. Existing `retry` rows are also loaded ahead of pending rows when a new run begins. A failure that exhausts those attempts remains `retry`; ambiguous outcomes become `uncertain` and are never automatically resent.
- Queue position is saved in `.upload-queue` under the configured root. If the server stops during a submission, that in-flight batch is marked `uncertain` for review rather than duplicated automatically.
- The server records which tab owns each batch. A tab cannot read or report another tab's lease, and two tabs cannot receive the same images. Restarting the server with an in-flight batch marks that batch `uncertain` for review.
- The dashboard's connected-tab count uses live worker check-ins. A worker keeps checking in while it submits a batch. Total outstanding leases are capped by the configured worker count even while pages navigate or temporarily disconnect.
- Each worker journals its leased batch and parsed site results in Tampermonkey storage. After a page reload, known results are acknowledged idempotently and a batch interrupted before submission safely returns to `retry`. A post-submit batch with no captured result remains blocked for reconciliation instead of being mass-marked `uncertain` by an idle duplicate page.
- A safety circuit breaker pauses the queue when ten items in one run receive ambiguous outcomes. This bounds damage to one normal batch and leaves the evidence available for review.
- A pack folder receives the `.uploaded-` prefix only after every manifest row is `submitted`.
- For an unattended run, `node auto-finish.mjs` watches the queue, performs one bounded pass over explicit `retry` rows, and writes `.upload-queue/auto-finish-report.json`. It leaves `uncertain` rows for review.

Use this only for images you are permitted to submit. The tool is independent of Emoji.gg and may need updates if the site changes its form or tag list.

## Development

Run `npm test` for the local import, catalog, edit, and worker-gate test. The server uses only built-in Node.js modules; no package installation is needed. Personal configuration and local process logs are excluded by `.gitignore`.

The dashboard uses the official [Bootswatch Cyborg](https://bootswatch.com/cyborg/) Bootstrap theme, kept locally so the Studio does not depend on a CDN while running.

License: [MIT](LICENSE).

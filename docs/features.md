# Feature guide

Detailed walkthroughs of each part of YouTube Automation Agent. For installation and configuration, start with the [README](../README.md).

- [Production readiness](#production-readiness)
- [Autonomous Channel Operator](#autonomous-channel-operator)
- [Resumable generation](#resumable-generation)
- [AI video generation](#ai-video-generation)
- [Scene Repair Studio and narration](#scene-repair-studio-and-narration)
- [Shorts Repurposing Studio](#shorts-repurposing-studio)
- [Ranked Shorts Studio](#ranked-shorts-studio)
- [Evidence desk](#evidence-desk)
- [Discoverability preflight](#discoverability-preflight)
- [Learning loop](#learning-loop)
- [Controlled growth experiments](#controlled-growth-experiments)
- [Outcome & ROI Studio](#outcome--roi-studio)
- [Scene-aware retention](#scene-aware-retention)
- [Audience Engagement Studio](#audience-engagement-studio)
- [Automation schedule](#automation-schedule)
- [Activation measurement and privacy](#activation-measurement-and-privacy)

Review Studio, mentioned throughout, is the **Content review** panel for each video.

## Production readiness

Before activating autonomous production, open **Production readiness** in the dashboard and choose **Run verified check**. The gate makes small live text and narration requests, verifies access to the connected YouTube channel, creates and decodes a temporary MP4 containing audio and video, and validates every queued upload's metadata. It never creates or uploads a YouTube video, and temporary probe assets are deleted after the run.

AI image generation can incur a larger provider charge, so its live probe is a separate opt-in checkbox. Without that checkbox, image configuration is reported as verified, skipped, or using the built-in gradient fallback without making a paid image request.

AI video verification has its own **Include paid video probe** checkbox. When enabled, the agent creates the provider's shortest supported test clip, records the external task and model, downloads and decodes the MP4, then removes the temporary asset. It never silently tries a second paid provider.

Results persist locally in SQLite with exact remediation steps. A recorded blocking failure stops autonomous generation and publishing until a later run passes; manual work remains available when readiness has never been checked or the last result is older than 24 hours.

## Autonomous Channel Operator

Open **Autonomous operator** in the dashboard and describe the channel outcome, not a task list. Set the objective, audience, content pillars, publishing cadence, success metric, and boundaries, then choose **Activate & run now**.

The operator refreshes YouTube trend and configured-competitor signals, checks recent channel topics, creates an evidence-labeled editorial plan, and sends each planned video through strategy, script, thumbnail, SEO, production, and workflow management. Active strategies also guide scheduled generation at the requested weekly cadence. Operator runs, decisions, progress, and failures persist in SQLite and remain visible in the dashboard.

By default, finished videos wait for factual review, media-rights confirmation, and approval. Once approved, the publishing agent schedules and uploads them. Turning on autonomy does not bypass those gates, and simulated videos still cannot publish.

## Resumable generation

Every generation stage writes a local SQLite checkpoint. If a provider times out or the application restarts, the dashboard shows the saved-stage count and the first incomplete stage. Choose **Resume** to continue from there, or select an earlier stage when you intentionally want to regenerate that stage and everything after it. Saved files are validated before reuse; missing artifacts are regenerated automatically.

Autonomous Operator runs preserve their research and editorial plan, so **Resume run** continues unfinished plan items instead of researching and generating completed videos again. Publishing remains fail-closed: if an upload may have reached YouTube but no video ID was returned, the agent requires channel reconciliation before another upload attempt.

## AI video generation

Local slideshow rendering is the default, so upgrading does not start paid video requests. The slideshow is rendered in headless Chromium (install it once with `npx playwright install chromium`) and assembled with FFmpeg. Generated images fill each slide; slides without an image use a gradient background.

To generate real clips, choose a provider in **Channel setup**, set a paid-seconds cap, then run the separately opted-in paid video readiness probe. The supported providers and their clip limits are listed in the [README](../README.md#video).

Long-form productions use hybrid assembly: the agent generates bounded provider clips for the hook and important sections, fills the remaining timeline locally, mixes the existing narration, and keeps the generated caption file alongside the production. As soon as a provider returns its task ID, the agent persists it before polling, so interrupted jobs can resume that known task instead of submitting it again. If a provider fails, the production falls back to the local slideshow.

## Scene Repair Studio and narration

Every production keeps a durable scene manifest with its narration, visual prompt, timing, provider/task identity, asset origin, rights state, evidence links, and revision history. Open **Scene Repair Studio** inside Review Studio to edit a scene, change its order, lock a scene that already works, upload a licensed replacement asset, or regenerate only that scene.

Paid video regeneration always shows the provider and generated seconds and requires a separate confirmation. Uploaded assets require an explicit rights confirmation. Narration edits invalidate that scene's audio and factual review; live narration must be regenerated and any new factual claim must be reviewed against verified evidence before approval.

Narration is fail-closed. The agent records the TTS provider, model, external task when available, generation time, cost evidence, and failure reason for every scene. If narration is missing, simulated, stale, or failed, the production cannot be approved, scheduled, or published. Use **Regenerate narration only** to repair the audio without spending video-generation credits or replacing a visual.

An intentionally silent production requires a separate operator confirmation and a stored reason of at least 10 characters. The override remains visible in Review Studio, can be reversed, and is included in the narration revision history. Silence is never inferred from a failed provider call.

When the timeline is ready, **Rebuild final video** creates a new MP4 and scene-aware captions while preserving the previous final video path in the production record. Approval stays blocked while any scene is missing, generating, stale, failed, or waiting for rebuild. Approved or scheduled productions are locked against scene repair.

## Shorts Repurposing Studio

Open **Shorts Repurposing Studio** inside Review Studio and choose **Create 3 Short drafts**. The agent selects self-contained windows from the durable scene timeline and preserves the exact source-scene IDs, start time, duration, rationale, title, description, tags, layout, and inherited review evidence for each candidate. Draft selection is local and does not call an AI provider.

Choose a blurred-canvas, center-crop, or stacked-focus layout, then render a real 9:16 MP4 with mobile-safe burned captions and a separate SRT file. The source video and narration are reused, so the default workflow does not spend new image, video, or TTS credits. Changing the layout invalidates the prior render and requires a fresh local render.

Every Short has its own approval and schedule. Scheduling remains blocked until the source production is approved, provenance is resolved, uploaded media rights are confirmed, every source scene is current, and the operator explicitly confirms the Short's privacy and publish time. Published Shorts retain their parent-production identity while their analytics use a separate Shorts baseline.

## Ranked Shorts Studio

Ranked Shorts Studio builds the countdown format used by clip-ranking Shorts channels: a vertical 9:16 Short that opens with a hook, then plays licensed clips from #N down to #1 with the original clip audio and burned-in rank captions.

Put your clips in a folder with an optional `clips.json` manifest:

```json
{
  "clips": [
    { "file": "01.mp4", "title": "Croc steals the boat", "license": "owned",
      "source": "self-recorded", "start": 2, "duration": 7 },
    { "file": "02.mp4", "title": "Dog opens the fridge", "license": "licensed",
      "source": "licence agreement 42", "start": 0, "duration": 6 }
  ]
}
```

Each clip needs a supported licence (`owned`, `licensed`, `cc-by`, `cc-by-sa`, `public-domain`, or `permission`) and a source note. Clips without both are rejected before anything is rendered, and the credits are written into the description. The local-folder workflow never downloads third-party footage.

Stock mode uses a free **stock-footage API** — Pixabay (instant key from your account) or Pexels. Add `PIXABAY_API_KEY` or `PEXELS_API_KEY` to `.env`, then let the agent search, download, and license-track the clips automatically. Both licences permit free use; every download keeps its licence source in the episode description:

```bash
npm run shorts:ranked -- stock --topic "Dogs failing at fetch" --count 7
npm run shorts:ranked -- stock --topic "Dogs failing at fetch" --queries "dog fail,dog pool" --music ./music.mp3
```

Clips are stored under `data/footage/<provider>/` and reused from cache. Optional `--music <file>` loops a local music bed under the clips (the mix stays at low volume so clip audio remains audible).

### Destination showcase format

`--format showcase` swaps the countdown for a TravelWonders-style destination showcase: best-first scenic order, no hook card, no rank captions — just rapid scenic cuts with a small persistent overlay (for example `♥ Venice`) burned top-center from an ASS file. Titles follow the "Discover <destination>…!" pattern:

```bash
npm run shorts:ranked -- stock --topic "Venice Italy" --format showcase --render
```

Showcase defaults: 8 clips of 3 seconds (24 seconds total), AI-written overlay/title/description/tags when a text provider is configured, and the thumbnail taken from the first clip. `--overlay "♥ Venice"` overrides the overlay text; colour flag emoji do not render in libass, so the heart is drawn as a red `♥` glyph instead.

### Music beds

`--music auto` (the showcase default) picks a royalty-free viral-style track from the built-in Pixabay catalog — phonk, upbeat electronic, funk, and tropical-house instrumentals curated from tracks that were not Content ID registered when checked — rotates the choice per day and per slot, downloads it once into `data/footage/music/`, and credits the artist in the description automatically. Actual YouTube Shorts library songs cannot be attached through the YouTube Data API; embedding a licensed trending song in the MP4 would risk a Content ID claim, so the automated pipeline uses these equivalent viral-style beds instead. Drop your own `.mp3`/`.m4a`/`.wav`/`.ogg` files into `data/footage/music-library/` and the pipeline rotates through those instead (credited as "from the channel music library"). Without either, showcase episodes fall back to a locally synthesized ambient pad; ranked episodes keep the original clip audio only.

### Daily ranked Shorts automation

Set `ranked_shorts_automation` to `true` (the **Channel setup** dashboard form, or `PUT /api/settings` with `{"ranked_shorts_automation": true}`) and the agent runs a morning batch at 07:00: it picks two different destinations from `ranked_shorts_topics` (or the built-in 16-place list), collects eight licensed stock clips per episode, plans and renders each showcase with a rotating royalty-free viral-style music bed, and schedules the uploads 12 hours apart. Episodes are auto-approved from the licence-tagged stock clips and upload through the publish queue (checked every 15 minutes) with `ranked_shorts_privacy` (default `public`). Tune the cadence with `ranked_shorts_per_day`, `ranked_shorts_gap_hours`, and `ranked_shorts_privacy`. An evening top-up run at 19:00 creates a missing episode if the morning batch failed part-way, and the manual approval flow stays available for episodes you create yourself in the dashboard or CLI.

### Running the daily Shorts in GitHub Actions

`.github/workflows/shorts.yml` runs the same showcase pipeline in the cloud. Each run prepares the Short for the **next** slot and uploads it as a private video with YouTube's `publishAt` set to 01:30 or 13:30 UTC (07:00/19:00 IST), so the video goes public on time even when GitHub's scheduler runs late:

- Add `YOUTUBE_CREDENTIALS_JSON`, `YOUTUBE_TOKENS_JSON`, and `PIXABAY_API_KEY` as repository secrets (**Settings → Secrets and variables → Actions**). The workflow restores them into `config/credentials.json`, `config/tokens.json`, and `.env` on the runner; nothing secret is committed.
- The workflow is free on a public repository. A private repository draws on the account's monthly Actions minutes — two runs a day is roughly 350–450 minutes a month.
- Each run picks the destination for the target publish date from the same 16-place rotation (`dayIndex * 2 + slot`), collects eight licensed clips, renders the showcase with a rotating royalty-free viral-style music bed, approves the licence-tagged clips, and uploads scheduled. The rendered MP4 and thumbnail are kept as a workflow artifact for 14 days.
- A second cron at 04:30/16:30 UTC retries the same slot if the first run failed. Before rendering, the workflow checks the channel, including private scheduled uploads, and skips when that slot already exists — retries never create duplicates.
- Trigger a manual run from **Actions → Travel Short → Run workflow**. `publish_at` sets an exact UTC publish time (default: now), `dry_run` renders without uploading, `topic` overrides the destination, and `slot` chooses the rotation half and music mood.
- GitHub's cron is best-effort and can start hours late. Because publishing uses YouTube's scheduled release, a late run only shortens the lead time; it does not move the publish time. If a run is delayed past the target, the Short is uploaded public immediately as a fallback.
- Scheduled workflows use UTC. GitHub pauses schedules after 60 days without repository activity; re-enable the workflow from the Actions tab if that happens.
- Google OAuth refresh tokens issued while the consent screen is in **Testing** expire after 7 days. To fix it permanently, open **Google Auth Platform → Audience** for the project that owns this OAuth client, click **Publish app** (staying unverified is fine for personal use), then mint a production token with `npm run youtube:reauth` and update the `YOUTUBE_TOKENS_JSON` secret. Existing testing tokens keep their 7-day expiry, so re-authorizing once after publishing is required.

GitHub Actions replaces the local 07:00/19:00 scheduler for the daily Shorts; keep `ranked_shorts_automation` set to `false` on the local server so the two schedulers do not upload duplicates.

### Re-authorizing YouTube

Mint a fresh refresh token at any time (for example after publishing the OAuth app or if uploads fail with `invalid_grant`):

```bash
npm run youtube:reauth
# open the printed URL, approve access, then run the command with the code:
npm run youtube:reauth -- --code "<code-or-full-redirect-url>"
Get-Content config\tokens.json -Raw | gh secret set YOUTUBE_TOKENS_JSON -R prabujayant/youtube-automation-agent
```

The helper reports `no 7-day expiry (production token)` when the OAuth app is in production. While the app is still in **Testing**, the new token also expires after seven days; publish the app first (Google Auth Platform → Audience → **Publish app**) and re-authorize once more.

Plan, render, and schedule from the CLI, the API, or the **Ranked Shorts** dashboard view:

```bash
npm run shorts:ranked -- plan --dir ./my-clips --topic "Funniest canal moments" --count 7
npm run shorts:ranked -- render <episodeId>
npm run shorts:ranked -- approve <episodeId> --confirm --at "2026-10-27T14:00:00Z"
```

Planning uses your configured text provider to choose and order the clips from their titles and notes, then writes the hook, captions, title, description, and tags. Without a text provider it falls back to the manifest order or score. Descriptions stay clean and human-readable: a short intro, the destination line, the music credit, one footage-licence line, and up to five hashtags. Per-clip licence provenance lives in the episode record, and only CC-BY/CC-BY-SA footage (which requires attribution) is listed clip by clip. Rendering copies the source clips into `data/ranked-shorts/<episodeId>/`, trims each to its slot, fits them full-bleed (or as a blurred canvas), builds a hook card for the ranked format, burns the overlay or `#N` countdown captions, and produces the final MP4, thumbnail, and SRT/ASS.

Clip audio stays inside the MP4. The publishing gate accepts that only after probing the rendered file and recording the audio evidence, so a silent render still fails. Approval requires explicit confirmation of the licences and the schedule, and publishes through the same queue and privacy rules as every other video.

## Evidence desk

Every production has an **Evidence desk** inside Review Studio. Autonomous research carries exact YouTube source metadata into the production, while AI-generated scripts list the factual claims that need review. Add any official articles, datasets, asset licenses, or other evidence the script needs, verify each source, and connect it to the claims it supports.

A claim can be approved only when it links to a verified source. Unsupported claims remain blocking, and an intentional waiver requires a reviewer note. Productions with no externally verifiable factual claims are marked as not requiring provenance review. The separate factual-review and media-rights attestations remain required before scheduling.

Use the altered or synthetic media control only when the video contains realistic content that requires YouTube disclosure. The selected value is preserved in the publishing queue and included in the YouTube upload request.

## Discoverability preflight

Every saved production receives an optional **DarkzSEO Discoverability Preflight** in Review Studio after metadata and provenance are assembled. The bundled content auditor reviews a canonical content package (not the private dashboard) with versioned GEO, AIO, AEO, and web-search checks, and stores the engine version, schema version, severity summary, stable rule IDs, and individual findings in SQLite.

Findings are advisory. Keep a useful recommendation as actionable, or dismiss a false positive with a reviewer reason that carries forward to matching findings on later audits. The bundled audit requires no Python package and never silently changes scripts or metadata.

To test a separate DarkzSEO 1.4+ checkout (requires Python 3.9+) instead of the bundled auditor:

```bash
DARKZSEO_PATH=../darkzseo/darkzseo.py npm start
```

The optional external adapter uses a shell-free Python child process, sends content JSON over stdin, and reads JSON-only stdout. If that runtime is missing or broken, the agent falls back to the bundled audit. The public PyPI `darkzseo` 1.3.3 package has a different site-audit CLI and is not used.

## Learning loop

After publication, the agent captures comparable 24-hour and 7-day performance snapshots. It evaluates CTR, retention, engagement, watch time, format, length, hook style, and title style against the channel's own history, not a universal view-count target.

Open **Analytics → What the agent learned** to review the evidence and confidence behind each recommendation. Pending or rejected recommendations never influence generation. Once you approve one, the next Autonomous Channel Operator run includes it as an explicit planning constraint. Simulated analytics fallbacks are stored as unverified and are never eligible for baselines or recommendations.

When an approved learning calls for better packaging, the agent prepares a control plus title and thumbnail variants for new videos. Review Studio shows those options before approval; the selected combination is the only one handed to the publishing queue. The agent does not silently swap live YouTube metadata.

## Controlled growth experiments

Open **Analytics → Controlled Growth Experiments** after a video with approved-learning packaging variants is published. Create a draft plan with a 24–168 hour window per arm and a minimum-impressions threshold, review the exact title and thumbnail combinations, then separately approve and start the live test.

The agent records a cumulative analytics sample before and after each arm and evaluates only the interval delta. Every arm must reach the configured impression and click floor. The leading CTR must clear a 95% evidence threshold without a material retention regression or traffic-source shift; otherwise the result is explicitly **inconclusive**. Simulated analytics never advance an experiment.

Arm rotations are limited to the plan you approved. After the final arm, the agent restores the control title and thumbnail before presenting the result. Applying the winner is a separate confirmation; only then does the validated packaging pattern become an approved learning for future Autonomous Operator runs. Experiment state and evidence are stored in SQLite so restarts do not erase progress.

## Outcome & ROI Studio

The Autonomous Operator strategy can define a measurable primary outcome (views, watch hours, net subscribers, engagement rate, or estimated revenue) plus a numeric target, evidence window, monthly production budget, and currency. The free-text outcome context remains available for goals that need human nuance.

At each real analytics window, the agent stores subscriber gains and losses, watch hours, monetization evidence when the channel exposes it, and known production costs from durable scene records. **Analytics → Outcome & ROI Studio** shows target progress, evidence coverage, net subscribers, estimated revenue, known cost, ROI, and comparisons by content pillar, format, and production provider.

Missing evidence is explicit. A channel without monetization access shows revenue as unavailable rather than zero, and ROI stays unavailable until both revenue and complete cost evidence exist. When at least two comparable videos exist in each group, the learning engine can propose reallocating future content toward the pillar or format that best advances the configured outcome. That proposal remains pending until you approve it; the agent never changes the strategy or budget silently.

## Scene-aware retention

At each real analytics window, the agent also requests YouTube's audience-retention curve and maps its 100 elapsed-time points onto the stored scene durations. Open **Analytics → Scene-aware retention** to see the curve divided by scene, compare absolute and relative retention, and inspect drop-off, rewatch, strong-hold, or steady signals for each beat.

Retention snapshots are stored separately for long-form videos and Shorts. Missing, sparse, or simulated curves never enter this evidence layer. A scene finding creates a pending learning recommendation; it cannot guide future scripts, pacing, or scene structure until the operator approves it, and the agent never rewrites a published video. Use **Refresh curve** for a read-only update from YouTube Analytics, or `GET /api/retention/:videoId` to inspect stored evidence.

## Audience Engagement Studio

Open **Engagement** in the dashboard. The agent syncs comments for recently published videos every four hours (more often for fresh videos) and classifies them into themes, sentiment, and questions. Likely spam, scams, and toxic comments are quarantined into a separate needs-attention list. The agent never deletes or hides a comment; acting on flagged comments stays in YouTube Studio.

Choose **Draft replies** to generate suggested answers in your channel's voice. Nothing posts automatically: every reply waits in the queue where you can edit, discard, or approve it, and approval requires an explicit confirmation. Posting requires re-authorizing YouTube once to grant the comment permission (`youtube.force-ssl`); until then the studio works in read-and-draft mode. A daily posting cap (default 50, `ENGAGEMENT_DAILY_REPLY_CAP`) keeps approval sessions bounded.

When three or more commenters ask for the same thing, the analysis mines an **audience-requested idea** with comment permalinks as evidence. Like every other learning, it stays pending until you approve it; only then can the Autonomous Channel Operator plan a video that answers it. If no AI text provider is configured, comment sync still works, but the studio records only mechanical facts and never invents themes, drafts, or ideas.

## Automation schedule

The scheduler starts with `npm start` and uses the server's local time.

| When | Job |
| --- | --- |
| Daily at 01:30 and 13:30 UTC | GitHub Actions renders and uploads one destination Short per run (`.github/workflows/shorts.yml`), independent of the local server |
| Daily at 06:00 | Generate content. With an active channel strategy, this follows its cadence and launches an autonomous research-and-production run when the content buffer needs work; otherwise the original topic-selection flow runs. |
| Every 15 minutes | Process the publishing queue |
| Daily at 09:00 | Collect analytics and backfill each real publication's 24-hour and 7-day evidence windows |
| Daily at 22:00 | Run optimizations |
| Every 4 hours | Sync audience comments (on the hour) and refresh growth experiments (at half past) |
| Sundays at 08:00 | Weekly strategy review |
| Saturdays at 03:00 | Database maintenance |

Recommendations require at least two real measurements, and format or style comparisons require at least two videos in each compared group.

## Activation measurement and privacy

The dashboard calculates setup, first-real-MP4, approval, publication, and repeat-generation milestones locally from SQLite and files on disk. A video counts only when a non-simulated `.mp4` with an MP4 container signature still exists.

Anonymous milestone reporting is disabled by default and has no built-in collector. It activates only when you explicitly set both `ANONYMOUS_TELEMETRY_ENABLED` and `ANONYMOUS_TELEMETRY_ENDPOINT`. The allowlisted payload contains the milestone name and time, YouTube Automation Agent version, OS family, Node major version, and a random installation ID. It never includes credentials, channel data, prompts, topics, titles, filenames, or video contents.

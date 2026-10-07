# 77 to Starbase

A friends-only trip site for Misha's friends: fly into Austin, ride his Cybertruck ~383 mi down US-77 to Starbase,
watch a Starship launch from Boca Chica, beach day, drive back. The hero is a three.js cinematic intro (build site →
sky cut → pad and stacking → beach) that ends on a launch sim with a SpaceX-webcast-style HUD.

Live: https://chernetsov.github.io/77-to-starbase/ · Repo: https://github.com/chernetsov/77-to-starbase (public, MIT code).

## Working here

- Dev server: `astro dev --background` (localhost:4321). Manage with `astro dev stop | status | logs`.
- Build check before every commit: `npx astro build`.
- If a page renders blank in dev with 504s on `/node_modules/.vite/deps/*`, Vite's optimized-deps cache is stale:
  `astro dev stop && rm -rf node_modules/.vite && astro dev --background`. It never affects production builds.
- Commit with specific `git add <paths>` and a plain-English subject. Never `--no-verify`.
- Push needs the personal GitHub account. The machine's default `gh` account is the work one, so:
  `gh auth switch -h github.com -u chernetsov && git push; gh auth switch -h github.com -u michael-chernetsov_super`.
  Every push to `main` redeploys Pages (`.github/workflows/deploy.yml`, ~1 min).
- Commit identity is `Misha Chernetsov <chernetsov@gmail.com>`. Never commit with the work email.

### Seeing what you changed

Verify visually; don't ship scene or layout changes unseen.

- `node scripts/snap.mjs <url> <w> <h> <prefix> <ms,...> [launchAtMs|-] [scrollSelector|-] [opts]` drives one shared
  GPU headless Chrome and writes `/tmp/77shots/<prefix>-<ms>.png`. It appends `autostart&mute` itself.
  Options: `--mobile`, `--dpr n`, `--crop x,y,w,h`, `--console`, `--eval <js>`, `--gate`, `--sound`. Run captures
  one after another, not in parallel. `--eval` runs before lazily-built Leaflet maps exist; wrap clicks in `setTimeout`.
- Dev-only URL params on `/`: `?intro=<0..1>` holds the intro at that fraction; `?t=<sec>` seeks the launch clock
  (T−10 … flight); `&hold` freezes it. Both imply autostart.
- Labs (shipped, linked from the nav flask icon): `/lab/` index, `truck` (`?model=lite`, `?view=side`, `?roll=1`,
  `?rollstep=`, `?cam=x,y,z`), `models` (ship, stack, factory parts), `pad`, `factory` (`?dusk`, `?view=`), `audio`.
- Still frames can't show motion. For timing or feel (easing, bumps, wheel spin) say what you verified and how,
  and ask Misha to watch it play. Small offline simulations (e.g. of the suspension springs) are a good check.

## Layout

- `src/pages/index.astro`: the page. Sections in order: hero, 01 Host, 02 Ground track (route map + stop cards),
  03 Flight plan (4 days), 04 Viewing geometry (map), 05 Launch manifest, 06 Vehicles, 07 Checklist, 08 Crew (form).
- `src/components/SiteNav.astro`: sticky nav. Items are groups that cover every section and light up for whichever
  section you're in: Host · Trip (02–03) · Launch (04–06) · Join (07–08). Then a lab flask icon and the GitHub mark.
- `src/components/Hero3D.astro`: canvas, loader/start gate, HUD markup, CSS and the HUD boot animation.
- `src/scripts/hero3d/`: `scene.ts` (intro choreography, camera, truck drive and suspension, launch camera),
  `starship.ts` (V3 stack, chopsticks), `launchfx.ts` (gravity turn, exhaust, trail), `factory.ts` (build site),
  `scenery.ts` (Boca Chica terrain, beach, dunes, horizon), `cybertruck.ts` (GLB load, wheel pivots), `audio.ts`.
- `src/scripts/wireframes.ts`: the rotating hidden-line schematics in the Vehicles cards (crease edges plus a fresnel
  silhouette, built from the same truck GLB and `buildStack`). Lazy-imported near the section; renders only on screen.
- `src/scripts/maps.ts` + `TripMap.astro` + `GroundTrackStops.astro`: Leaflet maps (Esri tiles) with clickable
  pins and photo cards. `GroundTrackStops` takes `set="route" | "viewing"`.
- `src/data/stops.ts` (stop cards), `route.json` (OSRM road geometry, regenerate with `node scripts/fetch-route.mjs`),
  `launches.json` (schedule; see below).
- `infra/`: AWS SAM app for "Request a seat": HTTP API → Lambda → DynamoDB, Telegram message to Misha.

## Scene conventions

- Everything at true scale, in meters. Starship V3 stack 124.4 m, 9 m diameter. Research real dimensions, photos and
  satellite imagery before modeling; Misha notices wrong proportions, flat or low-poly parts, and outdated hardware.
- World axes (`scenery.ts`): launch mount at the origin, +x east toward the Gulf, +z south. The settled camera
  stands on the beach at (480, 2.4, −60) looking west at the pad; the build site is ~3.3 km west-southwest.
  Read the axis comments before placing anything. Guessing directions has caused bugs (rocket heading south).
- The intro timeline is `INTRO` in `scene.ts` (seconds; total 38). Chapter buttons seek to `CHAPTERS`.
  `introElapsed()` adds a ~3.5 s ease-in from standstill when the intro starts from the top.
- Camera moves start and end at rest, or hand off velocity and acceleration continuously. Use the quintic
  `hermite()` (zero acceleration at both ends), never a cubic or a linear start. Join consecutive moves into one
  stitched motion instead of turn-then-move. After the intro the camera trails the mouse with a ~0.7 s lag.
- The truck leaves frame and reappears where the next shot needs it, rather than driving impossibly fast.
- Cybertruck: Sketcher/jnanbr07 GLB (CC BY 4.0) is the hero model; hashikemu's is the lite backup. Wheels spin
  through per-axle pivots. Wheel turn is capped per frame (`WHEEL_STEP_MAX`) so the six-spoke rims always read as
  rolling forward. No motion blur; Misha wants the wheels seen whole. The body rides on springs (`ride` state)
  over `groundBump` plus sparse `roadBump` humps on asphalt (one every ~80 m, a few cm).
- Launch: a gentle gravity turn east (`DOWNRANGE`, `flightPath()` in `launchfx.ts`). The stack pitches along the
  path, and the exhaust, trail and camera aim follow the same path. Chopsticks stay open after stacking.
- Look at real launch footage for sequence and timing (chopsticks, venting, ignition, Mach 1).

## Design

- SpaceX-minimal: black, white, one accent (`--sunset` #e8622c), Barlow Condensed caps for labels and display,
  Barlow body, JetBrains Mono for data. Tokens are in `src/styles/global.css`; reuse them, don't invent sizes or colors.
- Keep the density budget. Fold new information into existing elements instead of adding rows. Prefer fewer
  font sizes and colors; Misha has flagged "too many sizes" before.
- Text over the 3D scene stays readable via halos and soft scrims (`--halo`), never solid panels.
- The HUD borrows from SpaceX webcasts: thin arc timeline with event marks, speed/altitude readouts, an engine map.
  Pieces boot by opening out from the center of where they'll sit. Strokes must read at 1×; check thickness.
- Icons over words where the meaning is obvious (lab flask, GitHub mark). The lab should be findable, not loud.
- Every motion respects `prefers-reduced-motion`.
- Check phone widths (390 and 340 px) for nav overflow, map label overlap and fit.

## Content facts

- Host: Misha (Mikhail Chernetsov), proud Texan since 2020; he and his family host. The hero chip uses
  `public/images/misha-avatar.jpg`; the Host section uses `misha-600.*`. His photos are not licensed for reuse.
- Guests come from around the US (SF is the most likely origin). Nobody is flying in from Singapore; don't mention it.
  The checklist says "ID", not "passport".
- Itinerary is 4 days: fly in and Austin; drive down and see the pad in the evening; launch day; beach and drive back.
- Open items: the hotel's name (ask Misha), and the "World's largest Buc-ee's" claim at Luling is doubtful.
- Schedule: `src/data/launches.json` holds `updatedAt`, `lastFlight` and the next three `upcoming` flights, each
  with `confidence` (`medium` | `low` | `very-low`). The hero countdown targets the first Texas entry with a `net`.
  Updating it and pushing to `main` redeploys.
- Photos come from Wikimedia Commons with per-photo credit in the card (`Special:FilePath?width=1600`, then
  `magick -resize 800x533^ -extent 800x533 -strip` and `cwebp`). Music: "Drifter" (James Gargette, CC0) and
  "Space Atmosphere" (Alexandr Zhelanov, CC BY 3.0); credits in `public/audio/CREDITS.md` and the page footer.
- Sound is on by default; the start gate's tap unlocks audio and starts the intro together.

## Backend

- AWS account: Misha's personal one, CLI profile `pronounce`, region `us-east-1`, CloudFormation stack `starbase-77`
  (stack names can't start with a digit).
- Redeploy: `cd infra && sam build && sam deploy --profile pronounce --region us-east-1 --stack-name starbase-77
  --resolve-s3 --capabilities CAPABILITY_IAM --parameter-overrides AllowedOrigin=https://chernetsov.github.io
  TelegramChatId=<Misha's chat id>`.
- The endpoint is the `PUBLIC_SIGNUP_ENDPOINT` repo variable (Actions → Variables); the build bakes it in.
- Notifications are Telegram only (Misha rarely reads email). The bot token is the SSM SecureString
  `/starbase-77/telegram-token`, which Misha sets himself; the chat id is a stack parameter. A failed notification
  never fails the signup.
- Notifications go out only for a new person or a changed request, capped at 30 per UTC day; the 31st sends one
  "signup flood" warning. The daily counters are rows keyed `_notifycount#YYYY-MM-DD` (older `_mailcount#`);
  skip them when exporting, along with `_tglink#` rows (one-time start codes, TTL'd on `expiresAt`).
- Public bot @starbase77bot (`infra/functions/bot/`, webhook `POST /telegram` guarded by the secret header in SSM
  `/starbase-77/telegram-webhook-secret`). Anyone who presses Start is subscribed in the `BotUsersTable` (keyed by
  chatId; `subscribed` flips on /start and /stop). The form's thank-you links to `t.me/starbase77bot?start=<code>`,
  which sets `telegramChatId` on that seat request. Other messages are forwarded to Misha (cap 50 per day).
  No broadcasts or in-bot booking yet; those are a later discussion.
- After a deploy that changes the bot, re-run `node scripts/telegram-setup.mjs`: it creates the webhook secret if
  missing, registers the webhook, and sets the bot's name, descriptions, commands and the Site menu button.
- Known gaps Misha chose to leave for now: no AWS budget alert, re-submitting someone's email overwrites their row,
  no bot check or invite code. API throttle is 2 req/s (burst 5).
- Credentials: environment or AWS profiles only, never in code, config or commands. `.env*` is gitignored.

## Working with Misha

- He gives short, visual feedback and iterates fast. Act on it directly, show a screenshot (crop or zoom on the
  detail in question) and commit each accepted change separately.
- Lead with what changed and where to look. Name the tunable constant and its current value so he can say
  "more" or "less".
- When an effect fights the look (wheel blur did), propose a different approach rather than tuning forever.
- He's happy for agents to research online (photos, satellite maps, launch footage, vector logos) and to spend
  tokens on realism.
- Ask before decisions that are his: accounts, emails, licensing, publishing, anything public about him.

## Astro docs

https://docs.astro.build: [routing](https://docs.astro.build/en/guides/routing/),
[components](https://docs.astro.build/en/basics/astro-components/),
[styling](https://docs.astro.build/en/guides/styling/).

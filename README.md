# 77 to Starbase

A friends-only trip site: fly into Austin, ride a Cybertruck down US-77, and watch a Starship launch from Starbase.
The hero is a true-scale three.js scene of the Starbase build site, the pad and Boca Chica Beach, ending in a
launch sim.

**Live:** https://chernetsov.github.io/77-to-starbase/

Built with [Astro](https://astro.build), [three.js](https://threejs.org) and [Leaflet](https://leafletjs.com).
The 3D models, photos and music are third-party works under their own licenses; see [LICENSE](LICENSE) and the
credits on the site.

## Develop

```sh
npm install
astro dev --background   # http://localhost:4321
npx astro build
```

- `/lab/` has inspectors for the Cybertruck models, the ship and stack, the pad, the build site and the soundtrack.
- In dev, `/?intro=0.5` holds the intro halfway through, and `/?t=20` seeks the launch sim to T+20 s.
- `node scripts/snap.mjs` takes timed screenshots with a shared headless Chrome (usage at the top of the file).
- `node scripts/fetch-route.mjs` regenerates the road geometry in `src/data/route.json`.

## Launch schedule

All schedule content lives in `src/data/launches.json`: `updatedAt`, `lastFlight`, and the next three `upcoming` flights.
Each entry has a `confidence` of `medium`, `low`, or `very-low`. The hero countdown targets the first Texas entry that
has a `net` date. Pushing to `main` redeploys the site.

## Deploy

GitHub Pages builds from `.github/workflows/deploy.yml` on every push to `main`. `SITE` and `BASE_PATH` come from the
repo, so a fork serves at `https://<user>.github.io/<repo>/`.

### Seat requests (AWS)

`infra/` is an AWS SAM app: HTTP API → Lambda → DynamoDB, plus a Telegram message to the owner for every request.

```sh
cd infra
sam build
sam deploy --guided   # AllowedOrigin=https://<user>.github.io, TelegramChatId=<your chat with the bot>
```

Create a bot with @BotFather and store its token as the SSM SecureString `/starbase-77/telegram-token` first. Then set the stack output `SignupEndpoint` as the GitHub repository variable
`PUBLIC_SIGNUP_ENDPOINT` (Settings → Secrets and variables → Actions → Variables) and re-run the deploy. Until it is
set, the form tells visitors signups are not live yet.

The same stack runs the public bot's webhook (`infra/functions/bot/`). After deploying, run
`node scripts/telegram-setup.mjs` to create the webhook secret, register the webhook and set the bot's profile.

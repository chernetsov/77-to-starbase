# 77 to Starbase

A friends-only trip site: fly into Austin, ride a Cybertruck down US-77, and watch a Starship launch from Starbase.

## Develop

```sh
npm install
astro dev --background   # http://localhost:4321
```
## Launch schedule

All schedule content lives in `src/data/launches.json`: `updatedAt`, `lastFlight`, and the next three `upcoming` flights.
Each entry has a `confidence` of `medium`, `low`, or `very-low`. The hero countdown targets the first Texas entry that has a `net` date.
A background agent can update this file and push to `main`, which redeploys the site.

## Publish (GitHub Pages)

1. Create a repo under your personal account and push `main`.
2. Repo **Settings → Pages → Source: GitHub Actions**.
3. `.github/workflows/deploy.yml` builds with `SITE`/`BASE_PATH` derived from the repo, so it serves at
   `https://<user>.github.io/77-to-starbase/`.

## Seat requests (AWS)

`infra/` is an AWS SAM app: HTTP API → Lambda → DynamoDB, plus an SES email to you for every request.

```sh
cd infra
sam build
sam deploy --guided   # AllowedOrigin=https://<user>.github.io, OwnerEmail=<your SES-verified address>
```

Verify `OwnerEmail` in SES first. Then set the stack output `SignupEndpoint` as a GitHub repository variable named
`PUBLIC_SIGNUP_ENDPOINT` (Settings → Secrets and variables → Actions → Variables) and re-run the deploy.
Until it is set, the form tells visitors signups are not live yet.

To email updates to everyone, the Lambda function can only send to verified addresses while SES is in sandbox mode.
Request SES production access before mailing friends.

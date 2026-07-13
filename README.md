# Reslink Blog Pipeline

Automated: topic scan → write → quality check → publish to Sanity. No manual
copy-paste. Runs once a day on its own.

## What's in here

```
reslink-blog-pipeline/
  .github/workflows/publish-blog.yml   the daily trigger (GitHub Actions)
  scripts/orchestrator.js              the main pipeline
  scripts/lint.js                      the quality gate (runs before publish)
  prompts/topic-scanner.md             swap in your real agent prompt
  prompts/content-writer.md            swap in your real agent prompt
  .env.example                         list of secrets you need
```

## 1. Get your three accounts/keys ready

- **OpenRouter**: sign up at openrouter.ai, no card needed. Create an API key
  under Settings → Keys. This is `OPENROUTER_API_KEY`.
- **Sanity**: in your existing Sanity project, go to manage.sanity.io →
  your project → API → Tokens → Add API token. Give it **Editor** permissions
  (needs write access). This is `SANITY_API_TOKEN`. Your `SANITY_PROJECT_ID`
  and `SANITY_DATASET` (usually `production`) are on the same project's
  API settings page.
- **Slack (optional)**: Slack → your workspace → search "Incoming Webhooks"
  → add to a channel → copy the URL. This is `SLACK_WEBHOOK_URL`. Skip this
  if you're fine relying on GitHub's automatic failure emails.

## 2. Edit the two prompt files

Open `prompts/topic-scanner.md` and `prompts/content-writer.md` and replace
the placeholder text with your actual agent instructions from claude.ai.
One rule to keep: the content writer must output Markdown, not HTML (the
placeholder file explains why).

## 3. Test it locally, before automating anything

```bash
cd reslink-blog-pipeline
npm install
cp .env.example .env
# open .env and fill in your real keys
node --env-file=.env scripts/orchestrator.js
```

Watch the terminal output. It'll tell you the topic it picked, the word
count, whether it passed the lint gate, and whether it published. Check your
Sanity Studio to see the new post. Run this a few times until you trust it.

To test only the lint gate against a markdown file you already have:

```bash
node scripts/lint.js path/to/some-draft.md
```

## 4. Put it on GitHub and add your secrets

```bash
git init
git add .
git commit -m "Initial blog pipeline"
gh repo create reslink-blog-pipeline --private --source=. --push
# no gh CLI? create a private repo on github.com and follow its
# "push an existing repository" instructions instead
```

Then, on GitHub: your repo → Settings → Secrets and variables → Actions →
New repository secret. Add each of these (same names as `.env.example`):

- `OPENROUTER_API_KEY`
- `SANITY_PROJECT_ID`
- `SANITY_DATASET`
- `SANITY_API_TOKEN`
- `SLACK_WEBHOOK_URL` (optional)

## 5. Test the automated trigger

Go to your repo → Actions tab → "Publish blog post" → Run workflow. This
runs it exactly the way the daily schedule will, without waiting for the
schedule. Confirm it works before walking away from it.

Once that's green, it runs itself daily at 6:00 AM IST. No further action
needed from you unless something fails, in which case you'll get an alert
(Slack, or GitHub's automatic email if you skipped Slack).

## Changing the schedule

Edit the `cron` line in `.github/workflows/publish-blog.yml`. GitHub Actions
cron is always UTC, IST is UTC+5:30, so subtract 5:30 from the IST time you
want.

## Upgrading quality later (the whole point of doing it this way)

When you're ready to swap the free model for Claude:

1. Get an Anthropic API key from console.anthropic.com.
2. In `scripts/orchestrator.js`, the `callOpenRouter` function's URL and
   auth header change to Anthropic's Messages API instead of OpenRouter's.
   That's the only code change, the lint gate, Sanity push, alerting, and
   schedule all stay exactly as they are.

Nothing else about this pipeline needs to be rebuilt for that.

## If something breaks

- Check the failed run's log under the Actions tab, every step prints what
  it's doing.
- Most common cause: a Sanity token without write permission, or a stale
  free model ID (OpenRouter rotates these, check
  https://openrouter.ai/models?max_price=0 and set `OPENROUTER_MODEL` as a
  repo secret to override the default).

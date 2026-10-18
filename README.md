# AI Resume Builder

Paste your background and a job requirement and get a resume tailored to that job. The resume is written by an **open-source LLM** (Meta Llama) and saved in an **open-source database** (Postgres on Supabase). Everything runs on free tiers.

**Live site:** https://vignesh4a.github.io/ai-resume-builder/

## How it works

```
Browser (GitHub Pages, static HTML/JS)
   │  supabase-js (anon key + user JWT)
   ▼
Supabase (free tier, open source)
   ├── Auth: guest (anonymous) accounts, optional email magic link
   ├── Postgres: profiles + resumes tables, protected by Row Level Security
   └── Edge Function "generate-resume"
          │  holds the LLM API key server-side
          ▼
   Open-source LLM over an OpenAI-compatible API
   (default: Llama 3.3 70B on Groq's free tier)
```

| Piece | Free service | Why |
|---|---|---|
| Hosting | GitHub Pages | Free static hosting with HTTPS |
| Database + auth | [Supabase](https://supabase.com) (open-source Postgres) | 500 MB DB on the free tier, plus Row Level Security |
| Server code | Supabase Edge Functions | Keeps the LLM key secret. 500k calls/month free |
| LLM | Llama 3.3 70B via [Groq](https://console.groq.com) | Free API key with generous rate limits |

Features:
- Tailors your resume to a job description
- Shows a job-match score with matched and missing keywords
- Offers two templates
- Lets you edit the text in place before you download
- Downloads a PDF through the browser's print dialog
- Keeps a history of your resumes
- Lets you start as a guest and add an email later

## One-time setup (about 10 minutes)

### 1. Create a free Supabase project
1. Sign up at https://supabase.com and create a new project. Write down the **database password**.
2. Go to **Authentication → Sign In / Providers**:
   - Turn on **Allow anonymous sign-ins**
   - Keep **Email** turned on
3. Go to **Authentication → URL Configuration** and set **Site URL** to `https://vignesh4a.github.io/ai-resume-builder/`.
4. Collect these values:
   - **Project ref** and **Project URL** (Project Settings → General / API)
   - **anon public key** (Project Settings → API Keys)
   - A **personal access token** from https://supabase.com/dashboard/account/tokens

### 2. Get a free LLM API key
Create a key at https://console.groq.com/keys.

To use another provider, set the `LLM_BASE_URL` and `LLM_MODEL` variables:

| Provider | `LLM_BASE_URL` | Example `LLM_MODEL` |
|---|---|---|
| Groq (default) | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| OpenRouter (free models) | `https://openrouter.ai/api/v1` | `meta-llama/llama-3.3-70b-instruct:free` |
| Hugging Face | `https://router.huggingface.co/v1` | `meta-llama/Llama-3.3-70B-Instruct` |
| Self-hosted Ollama | `https://your-host/v1` | `llama3.1` |

### 3. Add the values to this GitHub repository
Go to **Settings → Secrets and variables → Actions**.

**Secrets:**
- `SUPABASE_ACCESS_TOKEN`: your personal access token
- `SUPABASE_DB_PASSWORD`: your database password
- `LLM_API_KEY`: your Groq (or other provider) key

**Variables:**
- `SUPABASE_PROJECT_REF`: for example `abcdefghijklmnop`
- `SUPABASE_URL`: for example `https://abcdefghijklmnop.supabase.co`
- `SUPABASE_ANON_KEY`: the anon public key. It is safe to expose because RLS protects the data.
- `LLM_BASE_URL` and `LLM_MODEL`: optional, only needed to change the provider

### 4. Deploy
Open **Actions** and run both workflows with **Run workflow**:
1. **Deploy database & AI function to Supabase** creates the tables and deploys the function.
2. **Deploy website to GitHub Pages** publishes the site.

After that, every push to `main` redeploys automatically.

## Local development
```bash
# Put your Supabase URL and anon key in web/config.js (don't commit them), then:
npx serve web        # or: python3 -m http.server -d web 8000
```
To run the function locally:

```bash
supabase start
supabase functions serve --env-file .env
```

`.env` should contain `LLM_API_KEY=...`.

## Project layout
```
web/                         Static website (GitHub Pages)
  index.html, app.js, styles.css, config.js
supabase/
  migrations/*.sql           Tables + Row Level Security policies
  functions/generate-resume  Edge Function that calls the LLM and saves the resume
.github/workflows/           CI deploys for Pages and Supabase
```

## Limits & privacy
- Each user can generate 20 resumes per hour (`HOURLY_LIMIT`). This protects the free LLM quota.
- The AI is told to use only facts from your background. Always review the result before sending it.
- Users can see only their own data, enforced by Postgres Row Level Security.

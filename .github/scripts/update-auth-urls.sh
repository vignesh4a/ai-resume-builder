#!/usr/bin/env bash
# Points Supabase sign-in redirects at wherever the site is hosted:
# GitHub Pages always, plus Cloudflare Pages (*.pages.dev) when it is configured.
# The Site URL (default redirect) is the .pages.dev address when there is one.
set -euo pipefail

ref="$(echo "${SUPABASE_PROJECT_REF:-} ${SUPABASE_URL:-}" | grep -oE '\b[a-z]{20}\b' | head -1 || true)"
if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ] || [ -z "$ref" ]; then
  echo "::warning title=Sign-in settings::Skipped: SUPABASE_ACCESS_TOKEN or the project ref is missing."
  exit 0
fi

urls=()
gh_url="https://$(echo "$OWNER" | tr '[:upper:]' '[:lower:]').github.io/${REPO}/"
urls+=("$gh_url")
site="$gh_url"

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  sub="$(curl -sS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${CF_PROJECT:-cvcraft}" \
    | jq -r '.result.subdomain // empty')"
  if [ -n "$sub" ]; then
    site="https://${sub}/"
    urls+=("$site")
  fi
fi

api="https://api.supabase.com/v1/projects/${ref}/config/auth"
current="$(curl -fsS -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" "$api")" || {
  echo "::error title=Read auth config failed::Could not read Supabase auth settings. Check SUPABASE_ACCESS_TOKEN."
  exit 1
}
wanted="$(printf '%s\n' "${urls[@]}" | jq -R . | jq -s '[.[] | ., . + "**"]')"
allow="$(echo "$current" | jq -r --argjson wanted "$wanted" '
  [(.uri_allow_list // "" | split(",")[] | gsub("^\\s+|\\s+$"; "") | select(. != "" and (test("localhost") | not))), $wanted[]]
  | unique | join(",")')"
body="$(jq -n --arg site "$site" --arg allow "$allow" '{site_url: $site, uri_allow_list: $allow}')"
result="$(curl -sS -X PATCH -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" -H "Content-Type: application/json" -d "$body" "$api")"
if [ "$(echo "$result" | jq -r '.site_url // empty')" != "$site" ]; then
  echo "::error title=Update auth config failed::$(echo "$result" | head -c 500)"
  exit 1
fi
echo "::notice title=Sign-in settings::Site URL = ${site} | Redirect URLs = $(echo "$result" | jq -r '.uri_allow_list') | Google provider enabled = $(echo "$result" | jq -r '.external_google_enabled')"

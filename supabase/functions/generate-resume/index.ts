// Supabase Edge Function: turns a candidate's background + a job requirement
// into a structured resume using an open-weight LLM (gpt-oss, Llama, Qwen… via any
// OpenAI-compatible endpoint: Groq, OpenRouter, Hugging Face router, Ollama...).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const LLM_BASE_URL = Deno.env.get("LLM_BASE_URL") ?? "https://api.groq.com/openai/v1";
const LLM_MODEL = Deno.env.get("LLM_MODEL") ?? "openai/gpt-oss-120b";
const LLM_API_KEY = Deno.env.get("LLM_API_KEY") ?? "";
const HOURLY_LIMIT = Number(Deno.env.get("HOURLY_LIMIT") ?? "20");
const MAX_INPUT_CHARS = 12000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const SYSTEM_PROMPT = `You are an expert resume writer and ATS optimisation specialist.
Write a one-to-two page resume tailored to the target job requirement, using ONLY facts
from the candidate background. Never invent employers, degrees, dates, certifications or metrics.
Rephrase achievements with strong action verbs and mirror the requirement's keywords where truthful.
Respond with a single JSON object and nothing else, matching exactly this shape:
{
  "name": string,
  "headline": string,
  "contact": { "email": string, "phone": string, "location": string, "links": string[] },
  "summary": string,
  "skills": [{ "category": string, "items": string[] }],
  "experience": [{ "role": string, "company": string, "location": string, "start": string, "end": string, "bullets": string[] }],
  "projects": [{ "name": string, "description": string, "bullets": string[] }],
  "education": [{ "degree": string, "institution": string, "year": string, "details": string }],
  "certifications": string[],
  "custom_sections": [{ "heading": string, "bullets": string[] }],
  "match": { "score": number, "matched_keywords": string[], "missing_keywords": string[], "tips": string[] }
}
Use empty strings or empty arrays for anything not present in the background.
"match.score" is 0-100: how well the candidate fits the requirement.
"missing_keywords" lists important requirement keywords the background does not support.
"custom_sections" holds any other sections from the background (Awards, Languages, Publications…).`;

type Section = { key: string; heading: string };
const STANDARD_KEYS = ["summary", "skills", "experience", "projects", "education", "certifications"];

// Sanitises the layout detected from the user's uploaded resume.
function cleanSections(format: unknown): Section[] {
  const list = (format as { sections?: unknown })?.sections;
  if (!Array.isArray(list)) return [];
  return list
    .filter((s): s is Section => typeof s?.key === "string" && typeof s?.heading === "string")
    .slice(0, 15)
    .map((s) => ({ key: s.key.slice(0, 20), heading: s.heading.slice(0, 60) }));
}

function layoutInstruction(sections: Section[]) {
  if (!sections.length) return "";
  const list = sections.map((s, i) =>
    `${i + 1}. "${s.heading}" -> ${STANDARD_KEYS.includes(s.key) ? `"${s.key}"` : '"custom_sections"'}`).join("\n");
  return `\n\nLAYOUT: The candidate's existing resume uses these sections, in this order. Keep the same sections and fill them into the JSON keys shown; put every section marked custom_sections into "custom_sections" using its exact heading:\n${list}`;
}

function extractJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("Model did not return JSON");
    return JSON.parse(text.slice(start, end + 1));
  }
}

// Open-weight models in rough order of preference for resume writing.
const PREFERRED_MODELS = [
  /llama-4-maverick/i, /llama-3\.3-70b/i, /gpt-oss-120b/i, /qwen3?-?.*(235b|72b|32b)/i, /llama-4-scout/i,
  /deepseek.*(v3|r1)/i, /llama-3\.1-70b/i, /gpt-oss-20b/i, /mistral|mixtral/i, /llama/i, /qwen|gemma/i,
];
const NOT_CHAT = /guard|safeguard|whisper|tts|embed|playai|orpheus|compound|prompt-guard|vision-only|moderation/i;

// Model actually used; replaced at runtime if the configured one has been retired.
let activeModel = LLM_MODEL;

async function availableModels(): Promise<string[]> {
  const res = await fetch(`${LLM_BASE_URL}/models`, { headers: { Authorization: `Bearer ${LLM_API_KEY}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data ?? []).map((m: { id: string }) => m.id).filter((id: string) => !NOT_CHAT.test(id));
}

async function pickFallbackModel(): Promise<string | null> {
  const ids = await availableModels();
  for (const re of PREFERRED_MODELS) {
    const hit = ids.find((id) => re.test(id));
    if (hit) return hit;
  }
  return ids[0] ?? null;
}

function chatRequest(model: string, jsonMode: boolean, background: string, requirement: string, sections: Section[]) {
  return fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 8000,
      // Reasoning models spend tokens thinking first; keep that short so the resume isn't cut off.
      ...(/gpt-oss/i.test(model) ? { reasoning_effort: "low" } : {}),
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `TARGET JOB REQUIREMENT:\n${requirement}\n\nCANDIDATE BACKGROUND:\n${background}${layoutInstruction(sections)}`,
        },
      ],
    }),
  });
}

async function callLlm(background: string, requirement: string, sections: Section[]) {
  let jsonMode = true;
  let switchedModel = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await chatRequest(activeModel, jsonMode, background, requirement, sections);
    if (res.ok) {
      const data = await res.json();
      return extractJson(data.choices?.[0]?.message?.content ?? "");
    }
    const detail = await res.text();
    if (!switchedModel && /model_not_found|does not exist|decommissioned|deprecated|not supported|no such model|invalid model/i.test(detail)) {
      const fallback = await pickFallbackModel();
      if (fallback && fallback !== activeModel) {
        console.warn(`Model ${activeModel} unavailable; switching to ${fallback}`);
        activeModel = fallback;
        switchedModel = true;
        continue;
      }
    }
    if (jsonMode && /response_format|json_object|json mode/i.test(detail)) {
      jsonMode = false;
      continue;
    }
    throw new Error(`LLM request failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  throw new Error("LLM request failed after retries.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!LLM_API_KEY) return json({ error: "Server is missing LLM_API_KEY secret" }, 500);

  try {
    // Act as the calling user so Row Level Security applies to every query.
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || user.is_anonymous) return json({ error: "Please sign in with Google first." }, 401);

    const { background, requirement, title, template, format } = await req.json();
    const sections = cleanSections(format);
    if (typeof background !== "string" || typeof requirement !== "string" ||
        background.trim().length < 30 || requirement.trim().length < 20) {
      return json({ error: "Please provide your background and the job requirement in more detail." }, 400);
    }
    if (background.length > MAX_INPUT_CHARS || requirement.length > MAX_INPUT_CHARS) {
      return json({ error: `Each field must be under ${MAX_INPUT_CHARS} characters.` }, 400);
    }

    // Protect the free LLM quota.
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from("resumes")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since);
    if ((count ?? 0) >= HOURLY_LIMIT) {
      return json({ error: "Hourly limit reached. Please try again later." }, 429);
    }

    const content = await callLlm(background, requirement, sections);

    const { data: saved, error } = await supabase
      .from("resumes")
      .insert({
        title: (typeof title === "string" && title.trim()) || String(content.headline || "Resume"),
        requirement,
        background,
        content,
        model: activeModel,
        template: typeof template === "string" ? template.slice(0, 20) : "classic",
        format: format && typeof format === "object" ? { ...format, sections } : null,
      })
      .select()
      .single();
    if (error) throw error;

    return json({ resume: saved });
  } catch (err) {
    console.error(err);
    return json({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});

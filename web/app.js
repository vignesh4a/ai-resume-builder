import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { importResume } from "./lib/importer.js";
import { resolveStyle, readResumeDom, fileBaseName, downloadPdf, downloadDocx } from "./lib/exporter.js";

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG || {};
const $ = (id) => document.getElementById(id);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// Must be read before createClient(), which strips the OAuth result from the URL.
const cameFromOAuth = /access_token=|[?&]code=/.test(window.location.href);
const oauthError = new URLSearchParams(window.location.hash.slice(1) || window.location.search).get("error_description");

const els = {
  boot: $("boot"),
  landing: $("landing"),
  landingError: $("landing-error"),
  app: $("app"),
  form: $("resume-form"),
  background: $("background"),
  requirement: $("requirement"),
  title: $("title"),
  generate: $("generate-btn"),
  bgCount: $("bg-count"),
  reqCount: $("req-count"),
  saveState: $("save-state"),
  resume: $("resume"),
  match: $("match"),
  loading: $("loading"),
  loadingMsg: $("loading-msg"),
  progressBar: $("progress-bar"),
  copy: $("copy-btn"),
  pdf: $("pdf-btn"),
  docx: $("docx-btn"),
  drop: $("dropzone"),
  fileInput: $("file-input"),
  formatCard: $("format-card"),
  regen: $("regen-btn"),
  grid: $("library-grid"),
  search: $("search"),
  libraryCount: $("library-count"),
  greeting: $("greeting"),
  toasts: $("toasts"),
};

function showView(name) {
  document.body.classList.remove("booting");
  els.boot.hidden = true;
  els.landing.hidden = name !== "landing";
  els.app.hidden = name !== "app";
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  showView("landing");
  $("setup-banner").hidden = false;
  $$(".js-google").forEach((b) => (b.disabled = true));
  throw new Error("Missing Supabase config");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let currentUser = null;
let profile = null;
let resumes = [];
let currentTemplate = "classic";
// Format detected from the user's uploaded resume, and the one used by the resume on screen.
let uploadFormat = null;
let activeFormat = null;

// ---------- Helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null && text !== "") node.textContent = text;
  return node;
}

const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null && x !== "") : []);
const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));

function toast(message, kind = "info") {
  const t = el("div", `toast ${kind}`, message);
  els.toasts.append(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, kind === "error" ? 6000 : 3500);
}

function safeHref(link) {
  const s = str(link);
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(s)) return `https://${s}`;
  return null;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function relativeTime(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

// ---------- Auth ----------

async function signInWithGoogle() {
  els.landingError.textContent = "";
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.origin + window.location.pathname,
      queryParams: { prompt: "select_account" },
    },
  });
  if (error) {
    els.landingError.textContent = /provider is not enabled/i.test(error.message)
      ? "Google sign-in isn't enabled in Supabase yet (Authentication → Providers → Google)."
      : error.message;
  }
}

$$(".js-google").forEach((b) => b.addEventListener("click", signInWithGoogle));

$("signout-btn").addEventListener("click", async () => {
  await supabase.auth.signOut();
  toast("Signed out. See you soon!");
});

const userBtn = $("user-btn");
const userPop = $("user-pop");
userBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  userPop.hidden = !userPop.hidden;
  userBtn.setAttribute("aria-expanded", String(!userPop.hidden));
});
document.addEventListener("click", (e) => {
  if (!userPop.hidden && !userPop.contains(e.target)) userPop.hidden = true;
});

async function enterApp(user) {
  currentUser = user;
  showView("app");

  // Record the login (once per actual Google sign-in) and load the stored profile.
  if (cameFromOAuth) {
    const { data, error } = await supabase.rpc("record_login", { user_agent: navigator.userAgent });
    if (error) console.warn("record_login failed", error);
    profile = data || null;
  }
  if (!profile) {
    const { data } = await supabase.from("profiles").select("*").eq("user_id", user.id).maybeSingle();
    profile = data;
  }

  renderUser();
  if (profile?.background) els.background.value = profile.background;
  if (profile?.resume_format) {
    uploadFormat = profile.resume_format;
    renderFormatCard();
    setTemplate("upload");
  }
  if (profile?.draft_requirement) els.requirement.value = profile.draft_requirement;
  updateCounts();
  await loadLibrary();

  if (cameFromOAuth) {
    const first = !profile || (profile.login_count ?? 0) <= 1;
    toast(first ? `Welcome aboard, ${firstName()}! 🎉` : `Welcome back, ${firstName()}!`, "success");
  }
}

function firstName() {
  const name = profile?.full_name || currentUser?.user_metadata?.full_name || currentUser?.email || "";
  return name.split(/[\s@]/)[0] || "there";
}

function renderUser() {
  const meta = currentUser.user_metadata || {};
  const name = profile?.full_name || meta.full_name || meta.name || currentUser.email;
  const avatar = profile?.avatar_url || meta.avatar_url || meta.picture;
  const img = $("user-avatar");
  if (avatar) {
    img.src = avatar;
    img.hidden = false;
    $("user-initial").hidden = true;
  } else {
    img.hidden = true;
    $("user-initial").hidden = false;
    $("user-initial").textContent = (name || "?").charAt(0).toUpperCase();
  }
  $("user-name").textContent = name;
  $("user-email").textContent = currentUser.email;
  if (profile?.login_count) {
    $("user-logins").textContent =
      `${profile.login_count} sign-in${profile.login_count === 1 ? "" : "s"}` +
      (profile.created_at ? ` · member since ${new Date(profile.created_at).toLocaleDateString()}` : "");
  }
  const hour = new Date().getHours();
  const part = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  els.greeting.textContent = `${part}, ${firstName()} 👋`;
}

supabase.auth.onAuthStateChange((event, session) => {
  const user = session?.user;
  // Defer: supabase-js recommends not calling other client methods inside this callback.
  setTimeout(() => {
    if (user && !user.is_anonymous) {
      if (user.id !== currentUser?.id) enterApp(user);
    } else if (user?.is_anonymous) {
      // Guest sessions from the earlier version: require a Google login now.
      supabase.auth.signOut();
    } else if (event === "SIGNED_OUT" || event === "INITIAL_SESSION") {
      currentUser = null;
      profile = null;
      showView("landing");
      if (oauthError) els.landingError.textContent = oauthError;
    }
  }, 0);
});

// ---------- Tabs ----------

function switchTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $("tab-create").hidden = name !== "create";
  $("tab-library").hidden = name !== "library";
  window.scrollTo({ top: 0, behavior: "smooth" });
}
$$(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

// ---------- Inputs: counters, autosave, helpers ----------

function updateCounts() {
  const b = els.background.value.trim().length;
  const r = els.requirement.value.trim().length;
  els.bgCount.textContent = `${b.toLocaleString()} chars`;
  els.reqCount.textContent = `${r.toLocaleString()} chars`;
  document.querySelector('[data-step="1"]').classList.toggle("done", b >= 30);
  document.querySelector('[data-step="2"]').classList.toggle("done", r >= 20);
}

const autosave = debounce(async () => {
  if (!currentUser) return;
  els.saveState.textContent = "Saving…";
  const { error } = await supabase.from("profiles").upsert({
    user_id: currentUser.id,
    background: els.background.value,
    draft_requirement: els.requirement.value,
    updated_at: new Date().toISOString(),
  });
  els.saveState.textContent = error ? "Not saved" : "Saved ✓";
}, 900);

for (const field of [els.background, els.requirement]) {
  field.addEventListener("input", () => {
    updateCounts();
    autosave();
  });
}

$("sample-btn").addEventListener("click", () => {
  if (els.background.value.trim() && !confirm("Replace your text with an example?")) return;
  els.background.value = `Jane Doe · jane.doe@email.com · +91 98765 43210 · Bengaluru · github.com/janedoe · linkedin.com/in/janedoe

Software Engineer, Acme Payments (Jul 2021 – Present)
- Built and maintained payment APIs in Java 17 / Spring Boot handling 2M requests/day
- Reduced p95 latency by 40% by adding Redis caching and query tuning on PostgreSQL
- Moved 6 services to Docker + Kubernetes on AWS (EKS), set up CI/CD with GitHub Actions
- Mentored 3 interns; led code reviews

Intern, DataWorks (Jan 2021 – Jun 2021)
- Wrote Python ETL jobs loading 50 GB/day into a data warehouse

Projects: PayKit – open-source payment SDK (500+ GitHub stars)
Skills: Java, Spring Boot, Python, SQL, PostgreSQL, Redis, Docker, Kubernetes, AWS, REST, Git
Education: B.Tech Computer Science, VIT University, 2021 (CGPA 8.7)
Certifications: AWS Certified Solutions Architect – Associate (2023)`;
  updateCounts();
  autosave();
  toast("Example filled in. Edit it to match you.");
});

$("paste-btn").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) return toast("Your clipboard is empty.");
    els.requirement.value = text.trim();
    updateCounts();
    autosave();
    toast("Job requirement pasted.", "success");
  } catch {
    toast("Clipboard access was blocked. Paste with Ctrl+V instead.", "error");
  }
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !$("tab-create").hidden) {
    e.preventDefault();
    els.form.requestSubmit();
  }
});

// ---------- Templates ----------

function setTemplate(name) {
  if (name === "upload" && !(activeFormat || uploadFormat)) name = "classic";
  currentTemplate = name;
  applyStyle();
  $$(".seg button").forEach((b) => b.classList.toggle("active", b.dataset.tpl === name));
  $$('input[name="template"]').forEach((r) => (r.checked = r.value === name));
}
$$(".seg button").forEach((b) => b.addEventListener("click", () => setTemplate(b.dataset.tpl)));

// Every template is a style object (see exporter.js); the preview reads it through
// CSS variables and flag classes, and the PDF/Word exports read the same object.
const STYLE_FLAGS = {
  "f-center": (st) => st.nameAlign === "center",
  "f-rule": (st) => st.headingRule,
  "f-upper": (st) => st.headingUpper,
  "f-title-upper": (st) => st.titleUpper,
  "f-title-bold": (st) => st.titleBold,
  "f-skills-table": (st) => st.skillsTable,
  "f-pipe": (st) => st.roleLayout === "pipe",
  "f-role-upper": (st) => st.roleUpper,
  "f-dates-below": (st) => st.datesBelow,
  "f-dates-italic": (st) => st.datesItalic,
  "f-side-bar": (st) => st.sideBar,
};

function applyStyle() {
  const st = resolveStyle(currentTemplate, activeFormat || uploadFormat);
  const r = els.resume.style;
  const css = {
    "--r-font": `"${st.font}", ${st.serif ? '"Times New Roman", Georgia, serif' : '"Carlito", Arial, sans-serif'}`,
    "--r-size": `${st.bodySize}pt`,
    "--r-name-size": `${st.nameSize}pt`,
    "--r-head-size": `${st.headingSize}pt`,
    "--r-accent": st.accent,
    "--r-name-color": st.nameColor,
    "--r-title-color": st.titleColor,
    "--r-text": st.textColor,
    "--r-muted": st.mutedColor,
    "--r-rule-color": st.ruleColor,
    "--r-rule-width": `${st.ruleWidth}pt`,
    "--r-shade": st.tableShade || "transparent",
    "--r-label-color": st.skillLabelColor || st.textColor,
    "--r-bullet": JSON.stringify(`${st.bulletChar} `),
    "--r-bullet-color": st.bulletColor || st.textColor,
    "--r-role-color": st.roleColor || st.textColor,
  };
  for (const [k, v] of Object.entries(css)) r.setProperty(k, v);
  for (const [cls, test] of Object.entries(STYLE_FLAGS)) els.resume.classList.toggle(cls, !!test(st));
}

// ---------- Upload an existing resume ----------

function renderFormatCard() {
  const show = !!uploadFormat;
  els.formatCard.hidden = !show;
  $$(".js-upload-tpl").forEach((n) => (n.hidden = !show));
  if (!show) return;
  const f = uploadFormat;
  $("format-file").textContent = f.filename || "your resume";
  const bits = [
    f.font ? `${f.font} ${f.bodySize ?? ""}pt`.trim() : null,
    f.nameAlign === "center" ? "centred name" : "left-aligned name",
    f.accent ? "accent colour" : null,
    f.headingRule ? "underlined headings" : null,
  ].filter(Boolean);
  $("format-style").textContent = bits.join(" · ");
  const list = $("format-sections");
  list.replaceChildren();
  for (const sct of f.sections || []) list.append(el("span", "chip neutral", sct.heading));
  if (!f.sections?.length) list.append(el("span", "muted small", "No section headings detected; the standard order will be used."));
}

async function handleFile(file) {
  if (!file) return;
  els.drop.classList.add("busy");
  $("drop-label").textContent = `Reading ${file.name}…`;
  try {
    const { text, format } = await importResume(file);
    const current = els.background.value.trim();
    if (current && current !== text && !confirm("Replace the text in step 1 with the content of this file?")) return;
    els.background.value = text;
    uploadFormat = format;
    activeFormat = null;
    renderFormatCard();
    setTemplate("upload");
    updateCounts();
    toast(`Read ${file.name}: ${format.sections.length} sections found. Its format will be used.`, "success");

    // Keep the original file and detected format with the user's account.
    const safe = file.name.replace(/[^\w.-]+/g, "_").slice(-80);
    const path = `${currentUser.id}/${Date.now()}-${safe}`;
    const { error: upErr } = await supabase.storage.from("resume-uploads").upload(path, file, { upsert: false });
    if (upErr) console.warn("upload failed", upErr);
    const { error } = await supabase.from("profiles").upsert({
      user_id: currentUser.id,
      background: text,
      resume_format: format,
      source_file_path: upErr ? null : path,
      source_file_name: file.name,
      updated_at: new Date().toISOString(),
    });
    els.saveState.textContent = error ? "Not saved" : "Saved ✓";
  } catch (err) {
    toast(err.message || "Could not read that file.", "error");
  } finally {
    els.drop.classList.remove("busy", "over");
    $("drop-label").textContent = "Upload your existing resume";
    els.fileInput.value = "";
  }
}

els.drop.addEventListener("click", () => els.fileInput.click());
els.drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    els.fileInput.click();
  }
});
els.fileInput.addEventListener("change", () => handleFile(els.fileInput.files[0]));
for (const ev of ["dragenter", "dragover"]) {
  els.drop.addEventListener(ev, (e) => {
    e.preventDefault();
    els.drop.classList.add("over");
  });
}
els.drop.addEventListener("dragleave", () => els.drop.classList.remove("over"));
els.drop.addEventListener("drop", (e) => {
  e.preventDefault();
  handleFile(e.dataTransfer.files[0]);
});

$("format-remove").addEventListener("click", async () => {
  uploadFormat = null;
  activeFormat = null;
  renderFormatCard();
  setTemplate("classic");
  await supabase.from("profiles").upsert({ user_id: currentUser.id, resume_format: null, updated_at: new Date().toISOString() });
  toast("Uploaded format removed. Using the Classic template.");
});
$$('input[name="template"]').forEach((r) => r.addEventListener("change", () => setTemplate(r.value)));

// ---------- Generate ----------

const LOADING_STEPS = [
  "Reading the job requirement…",
  "Picking out the key skills…",
  "Matching your experience…",
  "Writing strong bullet points…",
  "Polishing the summary…",
  "Almost there…",
];
let loadingTimer;

function setLoading(on) {
  els.generate.disabled = on;
  els.regen.disabled = on || !els.resume.dataset.ready;
  els.generate.classList.toggle("busy", on);
  els.loading.hidden = !on;
  clearInterval(loadingTimer);
  if (!on) return;
  let i = 0;
  const started = Date.now();
  els.loadingMsg.textContent = LOADING_STEPS[0];
  els.progressBar.style.width = "4%";
  loadingTimer = setInterval(() => {
    const secs = (Date.now() - started) / 1000;
    // Ease towards 95% over ~20 seconds.
    els.progressBar.style.width = `${Math.min(95, 100 * (1 - Math.exp(-secs / 7)))}%`;
    if (Math.floor(secs / 2.5) > i && i < LOADING_STEPS.length - 1) {
      i += 1;
      els.loadingMsg.textContent = LOADING_STEPS[i];
    }
  }, 250);
}

async function generate() {
  const background = els.background.value.trim();
  const requirement = els.requirement.value.trim();
  if (background.length < 30) {
    els.background.focus();
    return toast("Tell us a bit more about yourself in step 1 (at least 30 characters).", "error");
  }
  if (requirement.length < 20) {
    els.requirement.focus();
    return toast("Paste the job requirement in step 2.", "error");
  }

  setLoading(true);
  els.pdf.disabled = els.docx.disabled = true;
  if (window.innerWidth < 900) els.loading.scrollIntoView({ behavior: "smooth", block: "center" });
  try {
    const { data, error } = await supabase.functions.invoke("generate-resume", {
      body: {
        background,
        requirement,
        title: els.title.value.trim(),
        template: currentTemplate,
        format: uploadFormat,
      },
    });
    if (error) {
      let message = error.message;
      try { message = (await error.context.json()).error || message; } catch { /* keep default */ }
      throw new Error(message);
    }
    els.progressBar.style.width = "100%";
    activeFormat = uploadFormat;
    showResume(data.resume.content);
    resumes.unshift(data.resume);
    renderLibrary();
    toast("Your resume is ready! Review it, then download.", "success");
  } catch (err) {
    toast(err.message || "Something went wrong. Please try again.", "error");
  } finally {
    setLoading(false);
  }
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  generate();
});
els.regen.addEventListener("click", generate);

// ---------- Render resume ----------

function section(title, ...children) {
  const s = el("section", "r-section");
  s.append(el("h2", null, title), ...children);
  return s;
}

// "Cloud Migration: moved 40 jobs to AWS" → bold lead-in + text.
const LEAD_IN = /^([^:]{3,70}):\s+(\S[\s\S]*)$/;

function bulletList(items) {
  const ul = el("ul");
  for (const b of arr(items)) {
    const li = el("li");
    const m = LEAD_IN.exec(str(b));
    if (m && !/https?$/i.test(m[1])) li.append(el("strong", "r-lead", `${m[1]}:`), document.createTextNode(` ${m[2]}`));
    else li.textContent = str(b);
    ul.append(li);
  }
  return ul;
}

const DEFAULT_ORDER = ["summary", "skills", "experience", "projects", "education", "certifications"];
const DEFAULT_HEADINGS = {
  summary: "Summary", skills: "Skills", experience: "Experience",
  projects: "Projects", education: "Education", certifications: "Certifications",
};

const SECTION_BUILDERS = {
  summary: (r, h) => (r.summary ? section(h, el("p", null, str(r.summary))) : null),
  skills: (r, h) => {
    const skills = arr(r.skills);
    if (!skills.length) return null;
    const list = el("div", "r-skills");
    for (const group of skills) {
      const row = el("div", "r-skill-row");
      if (typeof group === "string") {
        row.append(el("span", "r-skill-items", group));
      } else {
        if (group.category) row.append(el("span", "r-skill-label", str(group.category)));
        row.append(el("span", "r-skill-items", arr(group.items).map(str).join(", ")));
      }
      list.append(row);
    }
    return section(h, list);
  },
  experience: (r, h) => {
    const exp = arr(r.experience);
    if (!exp.length) return null;
    return section(h, ...exp.map((job) => {
      const item = el("div", "r-item");
      const head = el("div", "r-item-head");
      const left = el("div", "r-title-line");
      left.append(el("strong", "r-role", str(job.role)));
      const org = [job.company, job.location].map(str).filter(Boolean).join(" · ");
      if (org) left.append(el("span", "r-org", org));
      head.append(left, el("span", "r-dates", [job.start, job.end].map(str).filter(Boolean).join(" – ")));
      item.append(head, bulletList(job.bullets));
      return item;
    }));
  },
  projects: (r, h) => {
    const projects = arr(r.projects);
    if (!projects.length) return null;
    return section(h, ...projects.map((p) => {
      const item = el("div", "r-item");
      const head = el("div", "r-item-head");
      head.append(el("strong", "r-role", str(p.name)));
      item.append(head);
      if (p.description) item.append(el("p", null, str(p.description)));
      item.append(bulletList(p.bullets));
      return item;
    }));
  },
  education: (r, h) => {
    const edu = arr(r.education);
    if (!edu.length) return null;
    return section(h, ...edu.map((e) => {
      const item = el("div", "r-item");
      const head = el("div", "r-item-head");
      const left = el("div", "r-title-line");
      left.append(el("strong", "r-degree", str(e.degree)));
      if (e.institution) left.append(el("span", "r-org", str(e.institution)));
      head.append(left, el("span", "r-dates", str(e.year)));
      item.append(head);
      if (e.details) item.append(el("p", null, str(e.details)));
      return item;
    }));
  },
  certifications: (r, h) => {
    const certs = arr(r.certifications);
    return certs.length ? section(h, bulletList(certs)) : null;
  },
};

// Lays sections out in the uploaded resume's order and wording when we have it.
function buildSections(r, layout) {
  const nodes = [];
  const usedKeys = new Set();
  const customs = arr(r.custom_sections).filter((c) => c && c.heading);
  const usedCustom = new Set();
  const customNode = (c) => section(str(c.heading), bulletList(c.bullets || c.items));

  for (const s of arr(layout)) {
    if (SECTION_BUILDERS[s.key] && !usedKeys.has(s.key)) {
      usedKeys.add(s.key);
      const node = SECTION_BUILDERS[s.key](r, s.heading || DEFAULT_HEADINGS[s.key]);
      if (node) nodes.push(node);
    } else if (!SECTION_BUILDERS[s.key]) {
      const match = customs.find((c, i) => !usedCustom.has(i) && str(c.heading).toLowerCase() === str(s.heading).toLowerCase());
      if (match) {
        usedCustom.add(customs.indexOf(match));
        nodes.push(customNode(match));
      }
    }
  }
  for (const key of DEFAULT_ORDER) {
    if (usedKeys.has(key)) continue;
    const node = SECTION_BUILDERS[key](r, DEFAULT_HEADINGS[key]);
    if (node) nodes.push(node);
  }
  customs.forEach((c, i) => {
    if (!usedCustom.has(i)) nodes.push(customNode(c));
  });
  return nodes;
}

function showResume(r) {
  const root = els.resume;
  root.replaceChildren();
  root.classList.remove("reveal");

  const header = el("header", "r-header");
  header.append(el("h1", null, str(r.name)));
  if (r.headline) header.append(el("p", "r-headline", str(r.headline)));
  const contact = el("p", "r-contact");
  const c = r.contact || {};
  for (const part of [c.email, c.phone, c.location].map(str).filter(Boolean)) {
    contact.append(el("span", null, part));
  }
  for (const link of arr(c.links)) {
    const href = safeHref(link);
    if (href) {
      const a = el("a", null, str(link).replace(/^https?:\/\//, ""));
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      contact.append(a);
    } else {
      contact.append(el("span", null, str(link)));
    }
  }
  header.append(contact);
  root.append(header);

  for (const node of buildSections(r, activeFormat?.sections)) root.append(node);

  root.contentEditable = "true";
  root.spellcheck = true;
  root.dataset.ready = "1";
  void root.offsetWidth;
  root.classList.add("reveal");
  els.copy.disabled = false;
  els.pdf.disabled = false;
  els.docx.disabled = false;
  els.regen.disabled = false;
  renderMatch(r.match);
}

function renderMatch(m) {
  if (!m || m.score == null) {
    els.match.hidden = true;
    return;
  }
  const score = Math.max(0, Math.min(100, Number(m.score) || 0));
  els.match.replaceChildren();

  const top = el("div", "match-top");
  const ring = el("div", "ring");
  ring.style.setProperty("--p", 0);
  ring.append(el("span", null, `${score}%`));
  const label = el("div");
  const verdict = score >= 80 ? "Strong match" : score >= 60 ? "Good match" : score >= 40 ? "Partial match" : "Weak match";
  label.append(el("strong", null, verdict), el("p", "muted small", "How well your background fits this job"));
  top.append(ring, label);
  els.match.append(top);
  requestAnimationFrame(() => ring.style.setProperty("--p", score));
  ring.classList.add(score >= 70 ? "good" : score >= 45 ? "ok" : "bad");

  const chips = (title, list, cls) => {
    const items = arr(list);
    if (!items.length) return;
    const row = el("div", "chips");
    row.append(el("span", "chips-label", title));
    for (const k of items) row.append(el("span", `chip ${cls}`, str(k)));
    els.match.append(row);
  };
  chips("✓ Matched", m.matched_keywords, "good");
  chips("✗ Missing", m.missing_keywords, "bad");

  const tips = arr(m.tips);
  if (tips.length) {
    const d = el("details", "tips");
    d.append(el("summary", null, `💡 ${tips.length} tip${tips.length === 1 ? "" : "s"} to improve your chances`));
    const ul = el("ul");
    for (const t of tips) ul.append(el("li", null, str(t)));
    d.append(ul);
    els.match.append(d);
  }
  els.match.hidden = false;
}

async function exportAs(kind) {
  const btn = kind === "pdf" ? els.pdf : els.docx;
  btn.disabled = true;
  btn.classList.add("busy");
  try {
    const model = readResumeDom(els.resume);
    const style = resolveStyle(currentTemplate, activeFormat || uploadFormat);
    const name = fileBaseName(model, els.title.value.trim());
    await (kind === "pdf" ? downloadPdf : downloadDocx)(model, style, name);
    toast(`Downloaded ${name}.${kind}`, "success");
  } catch (err) {
    console.error(err);
    toast(`Could not create the ${kind.toUpperCase()} file: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.classList.remove("busy");
  }
}
els.pdf.addEventListener("click", () => exportAs("pdf"));
els.docx.addEventListener("click", () => exportAs("docx"));

els.copy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(els.resume.innerText);
  toast("Resume text copied.", "success");
});

// ---------- Library ----------

async function loadLibrary() {
  const { data, error } = await supabase
    .from("resumes")
    .select("id, title, created_at, content, requirement, template, format")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    toast("Could not load your resumes.", "error");
    return;
  }
  resumes = data || [];
  renderLibrary();
}

function renderStats() {
  const scores = resumes.map((r) => Number(r.content?.match?.score)).filter((n) => Number.isFinite(n));
  $("stat-count").textContent = resumes.length;
  $("stat-score").textContent = scores.length ? `${Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)}%` : "–";
  $("stat-best").textContent = scores.length ? `${Math.max(...scores)}%` : "–";
  els.libraryCount.textContent = resumes.length;
}

function renderLibrary() {
  renderStats();
  const q = els.search.value.trim().toLowerCase();
  const list = resumes.filter((r) =>
    !q || r.title.toLowerCase().includes(q) || (r.requirement || "").toLowerCase().includes(q));

  els.grid.replaceChildren();
  if (!list.length) {
    const empty = el("div", "grid-empty");
    empty.append(
      el("div", "empty-icon", q ? "🔍" : "🗂️"),
      el("p", null, q ? "No resumes match your search." : "No resumes yet."),
    );
    if (!q) {
      const go = el("button", "btn primary", "Create your first resume");
      go.addEventListener("click", () => switchTab("create"));
      empty.append(go);
    }
    els.grid.append(empty);
    return;
  }

  for (const row of list) {
    const card = el("article", "rcard");
    const score = Number(row.content?.match?.score);
    const head = el("div", "rcard-head");
    head.append(el("h3", null, row.title));
    if (Number.isFinite(score)) {
      head.append(el("span", `badge ${score >= 70 ? "good" : score >= 45 ? "ok" : "bad"}`, `${score}%`));
    }
    const snippet = el("p", "muted small rcard-snippet", str(row.requirement).slice(0, 140));
    const foot = el("div", "rcard-foot");
    foot.append(el("span", "muted small", relativeTime(row.created_at)));
    const actions = el("div", "rcard-actions");
    const open = el("button", "btn ghost sm", "Open");
    open.addEventListener("click", () => {
      els.requirement.value = row.requirement;
      els.title.value = row.title;
      updateCounts();
      activeFormat = row.format || null;
      setTemplate(row.template || "classic");
      showResume(row.content);
      switchTab("create");
    });
    const del = el("button", "btn ghost sm danger", "Delete");
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${row.title}"? This can't be undone.`)) return;
      const { error } = await supabase.from("resumes").delete().eq("id", row.id);
      if (error) return toast("Could not delete it.", "error");
      resumes = resumes.filter((r) => r.id !== row.id);
      renderLibrary();
      toast("Resume deleted.");
    });
    actions.append(open, del);
    foot.append(actions);
    card.append(head, snippet, foot);
    els.grid.append(card);
  }
}

els.search.addEventListener("input", debounce(renderLibrary, 150));

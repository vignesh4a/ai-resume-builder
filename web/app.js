import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG || {};
const $ = (id) => document.getElementById(id);

const els = {
  form: $("resume-form"),
  background: $("background"),
  requirement: $("requirement"),
  title: $("title"),
  template: $("template"),
  generate: $("generate-btn"),
  status: $("status"),
  history: $("history-list"),
  resume: $("resume"),
  match: $("match"),
  copy: $("copy-btn"),
  print: $("print-btn"),
  accountLabel: $("account-label"),
  accountBtn: $("account-btn"),
  signout: $("signout-btn"),
  emailDialog: $("email-dialog"),
  emailForm: $("email-form"),
  emailInput: $("email-input"),
  emailTitle: $("email-title"),
};

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  $("setup-banner").hidden = false;
  els.accountLabel.textContent = "Not configured";
  els.generate.disabled = true;
  throw new Error("Missing Supabase config");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let currentUser = null;

// ---------- Helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null && text !== "") node.textContent = text;
  return node;
}

const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null && x !== "") : []);
const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));

function setStatus(message, kind = "") {
  els.status.textContent = message;
  els.status.className = `status ${kind}`;
}

function safeHref(link) {
  const s = str(link);
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(s)) return `https://${s}`;
  return null;
}

// ---------- Auth ----------

async function ensureSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) return session.user;
  // Guests get an anonymous account so their resumes are saved immediately.
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return data.user;
}

function renderAccount() {
  if (!currentUser) return;
  const isGuest = currentUser.is_anonymous;
  els.accountLabel.textContent = isGuest ? "Guest (saved on this browser)" : currentUser.email;
  els.accountBtn.hidden = !isGuest;
  els.signout.hidden = isGuest;
}

els.accountBtn.addEventListener("click", () => {
  els.emailInput.value = "";
  els.emailDialog.showModal();
});

els.emailDialog.addEventListener("close", async () => {
  if (els.emailDialog.returnValue !== "ok") return;
  const email = els.emailInput.value.trim();
  if (!email) return;
  // Link the email to the current guest account so existing resumes are kept.
  const { error } = await supabase.auth.updateUser(
    { email },
    { emailRedirectTo: window.location.href.split("#")[0] },
  );
  if (error && /already/i.test(error.message)) {
    // Email belongs to an existing account: send a sign-in link instead.
    const res = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href.split("#")[0], shouldCreateUser: false },
    });
    setStatus(res.error ? res.error.message : `Sign-in link sent to ${email}.`, res.error ? "error" : "ok");
    return;
  }
  setStatus(error ? error.message : `Check ${email} for a confirmation link.`, error ? "error" : "ok");
});

els.signout.addEventListener("click", async () => {
  await supabase.auth.signOut();
  window.location.reload();
});

supabase.auth.onAuthStateChange((_event, session) => {
  if (!session?.user) return;
  const userChanged = session.user.id !== currentUser?.id;
  currentUser = session.user;
  renderAccount();
  // Defer: supabase-js recommends not calling other client methods inside this callback.
  if (userChanged) setTimeout(() => { loadProfile(); loadHistory(); }, 0);
});

// ---------- Data ----------

async function loadProfile() {
  const { data } = await supabase.from("profiles").select("background").maybeSingle();
  if (data?.background && !els.background.value) els.background.value = data.background;
}

async function saveProfile(background) {
  await supabase.from("profiles").upsert({
    user_id: currentUser.id,
    background,
    updated_at: new Date().toISOString(),
  });
}

async function loadHistory() {
  const { data, error } = await supabase
    .from("resumes")
    .select("id, title, created_at, content, requirement")
    .order("created_at", { ascending: false })
    .limit(50);
  els.history.replaceChildren();
  if (error || !data?.length) {
    els.history.append(el("li", "muted", error ? "Could not load resumes." : "Nothing yet."));
    return;
  }
  for (const row of data) {
    const li = el("li");
    const open = el("button", "link", row.title);
    open.type = "button";
    open.addEventListener("click", () => {
      els.requirement.value = row.requirement;
      showResume(row.content);
    });
    const date = el("span", "muted small", new Date(row.created_at).toLocaleDateString());
    const del = el("button", "icon", "✕");
    del.type = "button";
    del.title = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${row.title}"?`)) return;
      await supabase.from("resumes").delete().eq("id", row.id);
      loadHistory();
    });
    li.append(open, date, del);
    els.history.append(li);
  }
}

// ---------- Generate ----------

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const background = els.background.value.trim();
  const requirement = els.requirement.value.trim();
  els.generate.disabled = true;
  setStatus("Writing your resume with Llama… this usually takes 5–15 seconds.");
  try {
    saveProfile(background);
    const { data, error } = await supabase.functions.invoke("generate-resume", {
      body: { background, requirement, title: els.title.value.trim() },
    });
    if (error) {
      let message = error.message;
      try { message = (await error.context.json()).error || message; } catch { /* keep default */ }
      throw new Error(message);
    }
    showResume(data.resume.content);
    setStatus("Done! Review it, tweak any text, then download.", "ok");
    loadHistory();
  } catch (err) {
    setStatus(err.message || "Something went wrong.", "error");
  } finally {
    els.generate.disabled = false;
  }
});

// ---------- Render ----------

function section(title, ...children) {
  const s = el("section", "r-section");
  s.append(el("h2", null, title), ...children);
  return s;
}

function bulletList(items) {
  const ul = el("ul");
  for (const b of arr(items)) ul.append(el("li", null, str(b)));
  return ul;
}

function showResume(r) {
  const root = els.resume;
  root.className = `resume ${els.template.value}`;
  root.replaceChildren();

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

  if (r.summary) root.append(section("Summary", el("p", null, str(r.summary))));

  const skills = arr(r.skills);
  if (skills.length) {
    const list = el("div", "r-skills");
    for (const group of skills) {
      const p = el("p");
      if (typeof group === "string") {
        p.textContent = group;
      } else {
        if (group.category) p.append(el("strong", null, `${str(group.category)}: `));
        p.append(document.createTextNode(arr(group.items).map(str).join(", ")));
      }
      list.append(p);
    }
    root.append(section("Skills", list));
  }

  const exp = arr(r.experience);
  if (exp.length) {
    const items = exp.map((job) => {
      const item = el("div", "r-item");
      const head = el("div", "r-item-head");
      const left = el("div");
      left.append(el("strong", null, str(job.role)));
      const org = [job.company, job.location].map(str).filter(Boolean).join(" · ");
      if (org) left.append(el("span", "r-org", org));
      head.append(left, el("span", "r-dates", [job.start, job.end].map(str).filter(Boolean).join(" – ")));
      item.append(head, bulletList(job.bullets));
      return item;
    });
    root.append(section("Experience", ...items));
  }

  const projects = arr(r.projects);
  if (projects.length) {
    const items = projects.map((p) => {
      const item = el("div", "r-item");
      const head = el("div", "r-item-head");
      head.append(el("strong", null, str(p.name)));
      item.append(head);
      if (p.description) item.append(el("p", null, str(p.description)));
      item.append(bulletList(p.bullets));
      return item;
    });
    root.append(section("Projects", ...items));
  }

  const edu = arr(r.education);
  if (edu.length) {
    const items = edu.map((e) => {
      const item = el("div", "r-item");
      const head = el("div", "r-item-head");
      const left = el("div");
      left.append(el("strong", null, str(e.degree)));
      if (e.institution) left.append(el("span", "r-org", str(e.institution)));
      head.append(left, el("span", "r-dates", str(e.year)));
      item.append(head);
      if (e.details) item.append(el("p", null, str(e.details)));
      return item;
    });
    root.append(section("Education", ...items));
  }

  const certs = arr(r.certifications);
  if (certs.length) root.append(section("Certifications", bulletList(certs)));

  root.contentEditable = "true";
  root.spellcheck = true;
  els.copy.disabled = false;
  els.print.disabled = false;
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
  top.append(el("strong", null, `Job match: ${score}%`));
  const bar = el("div", "bar");
  const fill = el("span");
  fill.style.width = `${score}%`;
  bar.append(fill);
  top.append(bar);
  els.match.append(top);

  const chips = (label, list, cls) => {
    const items = arr(list);
    if (!items.length) return;
    const row = el("p", "chips");
    row.append(el("span", "muted small", label));
    for (const k of items) row.append(el("span", `chip ${cls}`, str(k)));
    els.match.append(row);
  };
  chips("Matched", m.matched_keywords, "good");
  chips("Missing", m.missing_keywords, "bad");
  const tips = arr(m.tips);
  if (tips.length) {
    const ul = el("ul", "tips");
    for (const t of tips) ul.append(el("li", null, str(t)));
    els.match.append(ul);
  }
  els.match.hidden = false;
}

els.template.addEventListener("change", () => {
  els.resume.classList.remove("classic", "modern");
  els.resume.classList.add(els.template.value);
});

els.print.addEventListener("click", () => window.print());

els.copy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(els.resume.innerText);
  setStatus("Resume text copied to clipboard.", "ok");
});

// ---------- Boot ----------

try {
  // The auth listener above loads profile and history once the session exists.
  await ensureSession();
} catch (err) {
  els.accountLabel.textContent = "Offline";
  setStatus(`Could not connect: ${err.message}. Is anonymous sign-in enabled in Supabase?`, "error");
}

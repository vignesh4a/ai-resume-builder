// Reads an uploaded resume (PDF, DOCX or TXT) in the browser and returns
// its plain text plus a "format" describing how it looks: fonts, sizes,
// colours, rules under headings, shaded skill tables, bullet style, bold
// lead-ins, how job titles and dates are laid out, and the section order.
//
// Both readers turn the document into a list of styled "lines"; analyzeLayout()
// then works out the design from those lines.

const PDFJS_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs";
const PDFJS_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs";
const JSZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// Known section headings mapped to the resume JSON keys the AI fills in.
const Q = "(?:(?:professional|career|executive|core|technical|key|relevant|work|personal|academic|areas of)\\s+)*";
const HEADING_PATTERNS = [
  ["summary", new RegExp(`^${Q}(summary|profile|objective|about( me)?|overview|introduction)$`)],
  ["experience", new RegExp(`^${Q}(experience|employment( history)?|work history|career history)$`)],
  ["skills", new RegExp(`^${Q}(skills|competencies|competences|expertise|technologies|skills (&|and) (tools|technologies)|tech(nical)? stack|skill set|proficiencies)$`)],
  ["projects", new RegExp(`^${Q}projects$`)],
  ["education", /^(education|academic (background|qualifications)|qualifications|education (&|and) (training|certifications))$/],
  ["certifications", /^(certifications?|certificates|licen[cs]es( (&|and) certifications)?|courses|training)$/],
];

const BULLET_RE = /^\s*([•●▪■◆►▸✓✔➤➢○◦\-–*])\s+/;
const DATE_RANGE_RE = /((jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?(19|20)\d{2}\s*[–—-]+\s*(((jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?(19|20)\d{2}|present|current|now|till date|date)/i;
const LEAD_IN_RE = /^([^:]{3,70}):\s+\S/;

export function classifyHeading(line) {
  const raw = line.trim().replace(/[:•|]+$/, "").trim();
  if (!raw || raw.length > 45 || raw.split(/\s+/).length > 6) return null;
  const norm = raw.toLowerCase().replace(/\s+/g, " ");
  for (const [key, re] of HEADING_PATTERNS) if (re.test(norm)) return key;
  // Short ALL-CAPS lines are usually section headings (Awards, Languages…).
  if (/[A-Z]/.test(raw) && raw === raw.toUpperCase() && !/\d{3,}|@|\|/.test(raw) && raw.length >= 4) return "custom";
  return null;
}

const SERIF_HINT = /times|georgia|garamond|cambria|book|serif|minion|palatino|baskerville|caslon|didot|merriweather|libre/i;

// Metric-compatible stand-ins that PDF converters embed instead of the original font.
const FONT_ALIASES = {
  carlito: "Calibri", caladea: "Cambria", "liberation sans": "Arial", arimo: "Arial",
  "liberation serif": "Times New Roman", tinos: "Times New Roman", "liberation mono": "Courier New", cousine: "Courier New",
};

function cleanFontName(name) {
  if (!name) return null;
  const n = name.replace(/^[A-Z]{6}\+/, "").replace(/[-,](bold|italic|regular|light|medium|semibold|black|oblique|roman|mt|ps).*$/i, "")
    .replace(/(PSMT|MT|PS)$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  if (!n || /^(g_d|f\d|t\d|ff\d)/i.test(n)) return null;
  return FONT_ALIASES[n.toLowerCase()] || n;
}

function mode(values) {
  const counts = new Map();
  for (const [v, w] of values) if (v != null) counts.set(v, (counts.get(v) || 0) + (w || 1));
  let best = null, bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(n * 2) / 2));
}

const hex = (c) => (c ? `#${c.replace("#", "").toUpperCase()}` : null);
const isBlackish = (c) => !c || /^#?(000000|0F172A|111111|1C1E21|212121|222222|333333|1F1F1F)$/i.test(c);

function luminance(c) {
  const n = parseInt(c.replace("#", ""), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve(window[globalName]);
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(s);
  });
}

// ---------- Layout analysis (shared by DOCX and PDF) ----------
//
// line = { text, runs: [{ text, bold, italic, color, size, caps, font }], align, border: { color, width } | null,
//          shade: "#hex" | null, inTable: bool, cells: [string] | null, bullet: char | null }

function lineSize(l, fallback) {
  return Math.max(...l.runs.map((r) => r.size ?? fallback), 0) || fallback;
}

function looksLikeHeading(l, bodySize) {
  return l.runs.some((r) => r.bold || r.caps || (r.size ?? bodySize) > bodySize + 0.5) || !!l.border;
}

function analyzeLayout(lines) {
  const content = lines.filter((l) => l.text.trim());
  const allRuns = content.flatMap((l) => l.runs.filter((r) => r.text.trim()));
  const weight = (r) => r.text.trim().length;
  const bodySize = mode(allRuns.map((r) => [r.size, weight(r)])) || 11;
  const font = mode(allRuns.map((r) => [r.font, weight(r)]));

  // Header: name, then title/contact lines until the first real section heading.
  const first = content[0];
  let firstHeading = content.findIndex((l, i) => i > 0 && !l.inTable && (() => {
    const key = classifyHeading(l.text);
    return key && key !== "custom" && looksLikeHeading(l, bodySize);
  })());
  if (firstHeading < 0) firstHeading = content.findIndex((l, i) => i > 1 && !l.inTable && l.border);
  if (firstHeading < 0) firstHeading = Math.min(3, content.length);
  const header = content.slice(1, firstHeading);
  const title = header.find((l) => l.text.length <= 70 && !/@|\d{5,}|\|/.test(l.text) && !BULLET_RE.test(l.text));
  const contactLine = header.find((l) => /@|\+?\d[\d\s-]{7,}|linkedin|github/i.test(l.text));

  // Section headings, and which section every other line belongs to.
  const headings = [];
  let section = null;
  const bySection = new Map();
  content.forEach((l, i) => {
    if (i < firstHeading) return;
    const key = !l.inTable ? classifyHeading(l.text) : null;
    if (key && (key !== "custom" || looksLikeHeading(l, bodySize))) {
      headings.push({ key, heading: l.text.trim().replace(/[:]+$/, ""), line: l });
      section = key;
      return;
    }
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(l);
  });

  const h0 = headings[0]?.line;
  const headingColor = h0?.runs.find((r) => r.color && !isBlackish(r.color))?.color || null;
  const ruled = headings.filter((h) => h.line.border);
  const headingRule = headings.length ? ruled.length / headings.length >= 0.5 : false;
  const ruleColor = mode(ruled.map((h) => [h.line.border.color, 1])) || headingColor;
  const ruleWidth = mode(ruled.map((h) => [h.line.border.width, 1])) || 0.75;

  // Body text and muted (secondary) colours.
  const plainRuns = content.slice(firstHeading).filter((l) => !headings.some((h) => h.line === l))
    .flatMap((l) => l.runs).filter((r) => r.text.trim() && !r.bold);
  const textColor = mode(plainRuns.map((r) => [r.color || "#000000", weight(r)]));
  const mutedColor = mode(plainRuns.filter((r) => r.color && r.color !== textColor && luminance(r.color) > 0.3 && luminance(r.color) < 0.8)
    .map((r) => [r.color, weight(r)]));

  // Skills shown as a (shaded) table.
  const skillLines = bySection.get("skills") || [];
  const skillTableRows = skillLines.filter((l) => l.inTable && (l.cells?.length ?? 0) >= 2);
  const skillsTable = skillTableRows.length >= 2;
  const tableShade = skillsTable ? mode(skillTableRows.map((l) => [l.shade, 1])) : null;
  const skillLabelColor = skillsTable
    ? skillTableRows[0].runs.find((r) => r.bold && r.color && !isBlackish(r.color))?.color || null
    : null;

  // Bullets: character, colour and bold lead-ins ("Cloud Migration: did X").
  const bulletLines = content.filter((l) => l.bullet);
  const bulletChar = mode(bulletLines.map((l) => [l.bullet === "-" || l.bullet === "*" ? "•" : l.bullet, 1]));
  const bulletColor = mode(bulletLines.map((l) => {
    const r = l.runs.find((x) => x.text.trim());
    return [r && r.text.trim().startsWith(l.bullet) && r.color && !isBlackish(r.color) ? r.color : null, 1];
  }));
  const leadIns = bulletLines.filter((l) => {
    const body = l.text.replace(BULLET_RE, "");
    if (!LEAD_IN_RE.test(body)) return false;
    const lead = body.slice(0, body.indexOf(":")).trim();
    // The lead-in text must be bold.
    let seen = "";
    for (const r of l.runs) {
      const t = r.text.replace(BULLET_RE, "").trim();
      if (!t) continue;
      if (!r.bold && seen.length < lead.length * 0.6) return false;
      seen += t;
      if (seen.length >= lead.length * 0.6) return true;
    }
    return false;
  });
  const useLeadIns = bulletLines.length >= 3 && leadIns.length / bulletLines.length >= 0.4;

  // Experience: "ROLE | Company" lines and dates on their own line.
  const expLines = (bySection.get("experience") || []).filter((l) => !l.bullet && !l.inTable);
  const roleLines = expLines.filter((l) => l.runs[0]?.bold && !DATE_RANGE_RE.test(l.text) && l.text.length < 120);
  const pipeRoles = roleLines.filter((l) => /\s\|\s/.test(l.text));
  const roleLayout = pipeRoles.length && pipeRoles.length >= roleLines.length / 2 ? "pipe" : "dash";
  const sampleRole = (roleLayout === "pipe" ? pipeRoles : roleLines)[0];
  const roleColor = sampleRole?.runs[0]?.color && !isBlackish(sampleRole.runs[0].color) ? sampleRole.runs[0].color : null;
  const roleUpper = sampleRole ? sampleRole.text.split("|")[0].trim() === sampleRole.text.split("|")[0].trim().toUpperCase() : false;
  const dateLines = expLines.filter((l) => DATE_RANGE_RE.test(l.text) && l.text.replace(DATE_RANGE_RE, "").replace(/[|,()\s]/g, "").length < 4);
  const datesBelow = dateLines.length >= 1 && dateLines.length >= roleLines.length / 2;
  const datesItalic = datesBelow && dateLines.some((l) => l.runs.some((r) => r.italic));
  const datesColor = datesBelow ? mode(dateLines.map((l) => [l.runs[0]?.color, 1])) : null;

  const titleRun = title?.runs.find((r) => r.text.trim());
  const nameColor = first.runs.find((r) => r.color && !isBlackish(r.color))?.color
    || first.runs.find((r) => r.color)?.color || null;

  return {
    font: font || null,
    serif: SERIF_HINT.test(font || ""),
    bodySize: clamp(bodySize, 8, 14),
    nameSize: clamp(lineSize(first, bodySize * 2), 14, 36),
    headingSize: clamp(h0 ? lineSize(h0, bodySize + 1) : bodySize + 1, 9, 18),
    accent: headingColor,
    nameColor,
    nameAlign: first.align === "center" ? "center" : "left",
    headingUpper: h0 ? h0.text === h0.text.toUpperCase() || h0.runs.some((r) => r.caps) : true,
    headingRule,
    ruleColor: headingRule ? ruleColor : null,
    ruleWidth: headingRule ? clamp(ruleWidth, 0.5, 3) : null,
    titleColor: titleRun?.color || null,
    titleUpper: title ? title.text === title.text.toUpperCase() : false,
    titleBold: !!titleRun?.bold,
    contactAlign: contactLine?.align === "center" ? "center" : null,
    textColor: textColor && textColor !== "#000000" ? textColor : null,
    mutedColor: datesColor || mutedColor || null,
    skillsTable,
    tableShade: tableShade || null,
    skillLabelColor,
    bulletChar: bulletChar || null,
    bulletColor: bulletColor || null,
    leadIns: useLeadIns,
    roleLayout,
    roleColor,
    roleUpper,
    datesBelow,
    datesItalic,
    sections: sectionsFromHeadings(headings),
  };
}

function sectionsFromHeadings(headings) {
  const seen = new Set();
  const out = [];
  for (const h of headings) {
    const id = `${h.key}:${h.heading.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ key: h.key, heading: h.heading });
  }
  return out;
}

// Plain text for the AI: table rows become "Label: value" lines.
function linesToText(lines) {
  return lines.map((l) => {
    if (l.cells && l.cells.length >= 2) {
      const [a, ...rest] = l.cells.map((c) => c.replace(BULLET_RE, "").trim());
      return rest.filter(Boolean).length ? `${a}: ${rest.filter(Boolean).join(" | ")}` : a;
    }
    return l.text;
  }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- DOCX ----------

async function readDocx(buffer) {
  const JSZip = await loadScript(JSZIP_URL, "JSZip");
  const zip = await JSZip.loadAsync(buffer);
  const read = async (path) => (zip.file(path) ? zip.file(path).async("string") : null);
  const parse = (xml) => (xml ? new DOMParser().parseFromString(xml, "application/xml") : null);

  const doc = parse(await read("word/document.xml"));
  if (!doc || !doc.getElementsByTagName("w:body")[0]) throw new Error("This doesn't look like a Word document.");
  const styles = parse(await read("word/styles.xml"));
  const theme = parse(await read("word/theme/theme1.xml"));
  const numbering = parse(await read("word/numbering.xml"));

  const W = "w:";
  const attr = (node, name) => node?.getAttribute(W + name) ?? null;
  const child = (node, name) => {
    if (!node) return null;
    for (const c of node.children) if (c.tagName === W + name) return c;
    return null;
  };
  const on = (el) => !!el && !["0", "false", "off"].includes(attr(el, "val"));

  const themeFonts = {
    minor: theme?.getElementsByTagName("a:minorFont")[0]?.getElementsByTagName("a:latin")[0]?.getAttribute("typeface"),
    major: theme?.getElementsByTagName("a:majorFont")[0]?.getElementsByTagName("a:latin")[0]?.getAttribute("typeface"),
  };
  const fontFromRFonts = (rf) => {
    if (!rf) return null;
    const direct = attr(rf, "ascii") || attr(rf, "hAnsi");
    if (direct) return direct;
    const t = attr(rf, "asciiTheme") || attr(rf, "hAnsiTheme");
    if (t) return /major/i.test(t) ? themeFonts.major : themeFonts.minor;
    return null;
  };
  const runProps = (rPr) => {
    if (!rPr) return {};
    const sz = attr(child(rPr, "sz"), "val");
    const color = attr(child(rPr, "color"), "val");
    const out = {
      font: fontFromRFonts(child(rPr, "rFonts")),
      size: sz ? Number(sz) / 2 : null,
      color: color && color !== "auto" ? hex(color) : null,
      bold: child(rPr, "b") ? on(child(rPr, "b")) : null,
      italic: child(rPr, "i") ? on(child(rPr, "i")) : null,
      caps: child(rPr, "caps") ? on(child(rPr, "caps")) : null,
    };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null));
  };
  const borderOf = (pPr) => {
    const b = child(child(pPr, "pBdr"), "bottom");
    if (!b || ["nil", "none"].includes(attr(b, "val"))) return null;
    const c = attr(b, "color");
    return { color: c && c !== "auto" ? hex(c) : "#000000", width: Number(attr(b, "sz") || 4) / 8 };
  };
  const shadeOf = (pr) => {
    const f = attr(child(pr, "shd"), "fill");
    return f && !/^(auto|FFFFFF)$/i.test(f) ? hex(f) : null;
  };

  // Styles, with basedOn inheritance.
  const styleMap = new Map();
  for (const s of styles?.getElementsByTagName("w:style") || []) {
    const pPr = child(s, "pPr");
    styleMap.set(attr(s, "styleId"), {
      basedOn: attr(child(s, "basedOn"), "val"),
      run: runProps(child(s, "rPr")),
      jc: attr(child(pPr, "jc"), "val"),
      border: borderOf(pPr),
      numPr: child(pPr, "numPr"),
    });
  }
  const styleProps = (id, depth = 0) => {
    const s = styleMap.get(id);
    if (!s || depth > 5) return { run: {} };
    const base = s.basedOn ? styleProps(s.basedOn, depth + 1) : { run: {} };
    return { run: { ...base.run, ...s.run }, jc: s.jc || base.jc, border: s.border || base.border, numPr: s.numPr || base.numPr };
  };
  const rDefault = styles?.getElementsByTagName("w:rPrDefault")[0];
  const defaults = { ...runProps(rDefault ? child(rDefault, "rPr") : null), ...styleProps("Normal").run };

  // Bullet characters from numbering definitions.
  const abstractFor = new Map();
  const bulletFor = new Map();
  for (const n of numbering?.getElementsByTagName("w:num") || []) {
    abstractFor.set(attr(n, "numId"), attr(child(n, "abstractNumId"), "val"));
  }
  for (const a of numbering?.getElementsByTagName("w:abstractNum") || []) {
    for (const lvl of a.getElementsByTagName("w:lvl")) {
      if (attr(child(lvl, "numFmt"), "val") !== "bullet") continue;
      const t = attr(child(lvl, "lvlText"), "val") || "•";
      const color = attr(child(child(lvl, "rPr"), "color"), "val");
      // Symbol-font bullets use private-use code points; show them as a round bullet.
      bulletFor.set(`${attr(a, "abstractNumId")}:${attr(lvl, "ilvl")}`, {
        char: /^[-]$/.test(t) || !t.trim() ? "•" : t,
        color: color && color !== "auto" ? hex(color) : null,
      });
    }
  }
  const bulletOf = (numPr) => {
    if (!numPr) return null;
    const abs = abstractFor.get(attr(child(numPr, "numId"), "val"));
    return bulletFor.get(`${abs}:${attr(child(numPr, "ilvl"), "val") || "0"}`) || null;
  };

  const readParagraph = (p, extra = {}) => {
    const pPr = child(p, "pPr");
    const sp = styleProps(attr(child(pPr, "pStyle"), "val"));
    const runs = [];
    for (const r of p.getElementsByTagName("w:r")) {
      let t = "";
      for (const c of r.children) {
        if (c.tagName === "w:t") t += c.textContent;
        else if (c.tagName === "w:tab") t += "\t";
        else if (c.tagName === "w:br") t += "\n";
      }
      if (!t) continue;
      runs.push({ text: t, ...defaults, ...sp.run, ...runProps(child(r, "rPr")) });
    }
    let text = runs.map((r) => r.text).join("");
    let bullet = BULLET_RE.exec(text)?.[1] || null;
    const listBullet = bulletOf(child(pPr, "numPr") || sp.numPr);
    if (!bullet && listBullet) {
      bullet = listBullet.char;
      runs.unshift({ text: `${bullet} `, ...defaults, color: listBullet.color });
      text = `${bullet} ${text}`;
    }
    return {
      text,
      runs,
      align: (attr(child(pPr, "jc"), "val") || sp.jc) === "center" ? "center" : "left",
      border: borderOf(pPr) || sp.border || null,
      shade: shadeOf(pPr),
      inTable: false,
      cells: null,
      bullet,
      ...extra,
    };
  };

  const lines = [];
  const walk = (node) => {
    for (const el of node.children) {
      if (el.tagName === "w:p") {
        const line = readParagraph(el);
        // A rule drawn as an empty bordered paragraph belongs to the heading above it.
        if (!line.text.trim() && line.border && lines.length && !lines[lines.length - 1].border) {
          lines[lines.length - 1].border = line.border;
        } else {
          lines.push(line);
        }
      } else if (el.tagName === "w:tbl") {
        for (const tr of el.getElementsByTagName("w:tr")) {
          const cells = [...tr.children].filter((c) => c.tagName === "w:tc");
          const cellLines = cells.map((tc) => [...tc.getElementsByTagName("w:p")].map((p) => readParagraph(p)));
          const cellTexts = cellLines.map((ls) => ls.map((l) => l.text).join(" ").trim());
          if (!cellTexts.some(Boolean)) continue;
          lines.push({
            text: cellTexts.filter(Boolean).join("\t"),
            runs: cellLines.flat().flatMap((l) => l.runs),
            align: "left",
            border: null,
            shade: shadeOf(child(cells[0], "tcPr")) || shadeOf(child(tr, "trPr")),
            inTable: cells.length >= 2,
            cells: cellTexts,
            bullet: null,
          });
        }
      } else if (["w:sdt", "w:sdtContent", "w:customXml", "w:smartTag", "w:ins"].includes(el.tagName)) {
        walk(el);
      }
    }
  };
  walk(doc.getElementsByTagName("w:body")[0]);
  // Single-column tables (often used for headers) read as ordinary lines.
  for (const l of lines) if (l.cells && l.cells.length < 2) l.cells = null;

  return { text: linesToText(lines.filter((l) => l.text.trim())), format: analyzeLayout(lines) };
}

// ---------- PDF ----------
// PDF has no style markup, so each page is also rendered to a canvas and the
// pixels are sampled for text colours, shaded rows and horizontal rules.

function quantize(r, g, b) {
  const q = (v) => Math.min(255, Math.round(v / 8) * 8);
  return (q(r) << 16) | (q(g) << 8) | q(b);
}
const toHex = (n) => `#${n.toString(16).padStart(6, "0").toUpperCase()}`;
// Near-white only: light tints such as #F1F5F9 table shading must still count as colour.
const isLight = (n) => ((n >> 16) & 255) >= 248 && ((n >> 8) & 255) >= 248 && (n & 255) >= 248;
const colorDist = (a, b) => Math.abs(((a >> 16) & 255) - ((b >> 16) & 255)) + Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) + Math.abs((a & 255) - (b & 255));

function sampleBox(img, x0, y0, x1, y1) {
  const { data, width, height } = img;
  const counts = new Map();
  const xs = Math.max(0, Math.floor(x0)), xe = Math.min(width - 1, Math.ceil(x1));
  const ys = Math.max(0, Math.floor(y0)), ye = Math.min(height - 1, Math.ceil(y1));
  const step = Math.max(1, Math.floor((xe - xs) / 300));
  for (let y = ys; y <= ye; y++) {
    for (let x = xs; x <= xe; x += step) {
      const i = (y * width + x) * 4;
      const k = quantize(data[i], data[i + 1], data[i + 2]);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  return counts;
}

function inkAndBackground(img, box) {
  const counts = sampleBox(img, ...box);
  let bg = null, bgN = -1;
  for (const [k, n] of counts) if (n > bgN) { bg = k; bgN = n; }
  // Ink = the strongest pixels (glyph cores, not anti-aliased edges) that differ from the background.
  const candidates = [...counts].filter(([k]) => colorDist(k, bg) > 140).sort((a, b) => colorDist(b[0], bg) - colorDist(a[0], bg));
  const total = candidates.reduce((s, [, n]) => s + n, 0);
  const core = new Map();
  let acc = 0;
  for (const [k, n] of candidates) {
    if (acc > total * 0.35) break;
    core.set(k, n);
    acc += n;
  }
  let ink = null, inkN = 0;
  for (const [k, n] of core) if (n > inkN) { ink = k; inkN = n; }
  return { ink: ink == null ? null : toHex(ink), background: bg == null || isLight(bg) ? null : toHex(bg) };
}

function findRules(img) {
  // Long thin horizontal runs of one colour that isn't white.
  const { data, width, height } = img;
  const rows = [];
  for (let y = 0; y < height; y++) {
    let best = 0, run = 0, prev = -1, color = null, bestColor = null;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const k = quantize(data[i], data[i + 1], data[i + 2]);
      if (!isLight(k) && k === prev) run++;
      else { run = isLight(k) ? 0 : 1; color = k; }
      prev = k;
      if (run > best) { best = run; bestColor = color; }
    }
    rows.push(best > width * 0.45 ? bestColor : null);
  }
  const rules = [];
  for (let y = 0; y < height; y++) {
    if (rows[y] == null) continue;
    let end = y;
    // Anti-aliased edges of a thick rule come out as slightly different shades: merge them.
    while (end + 1 < height && rows[end + 1] != null && colorDist(rows[end + 1], rows[y]) < 120) end++;
    if (end - y + 1 <= 5) rules.push({ y: (y + end) / 2, thickness: end - y + 1, color: toHex(rows[y]) });
    y = end;
  }
  return rules;
}

async function readPdf(buffer) {
  const pdfjs = await import(PDFJS_URL);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const lines = [];
  const SCALE = 1.5;

  for (let n = 1; n <= Math.min(pdf.numPages, 4); n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: SCALE });
    const content = await page.getTextContent();
    try { await page.getOperatorList(); } catch { /* font names stay unknown */ }
    const fontName = (id) => {
      try { return page.commonObjs.get(id)?.name || null; } catch { return null; }
    };

    let img = null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      await page.render({ canvasContext: ctx, viewport }).promise;
      img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch { /* colours stay unknown */ }

    const rows = [];
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const [a, b, , , x, y] = item.transform;
      const size = Math.round(Math.hypot(a, b) * 2) / 2;
      const real = fontName(item.fontName);
      let row = rows.find((r) => Math.abs(r.y - y) < Math.max(2, size * 0.3));
      if (!row) rows.push((row = { y, items: [] }));
      let color = null, background = null;
      if (img) {
        const [cx0, cy0] = viewport.convertToViewportPoint(x, y + size * 0.75);
        const [cx1, cy1] = viewport.convertToViewportPoint(x + item.width, y - size * 0.1);
        ({ ink: color, background } = inkAndBackground(img, [cx0, cy0, cx1, cy1]));
      }
      row.items.push({
        str: item.str, x, w: item.width, size, font: real, color, background,
        bold: /bold|black|heavy|semibold|demi/i.test(real || ""),
        italic: /italic|oblique/i.test(real || ""),
      });
    }
    rows.sort((p, q) => q.y - p.y);

    const pageLines = [];
    for (const r of rows) {
      r.items.sort((p, q) => p.x - q.x);
      let text = "";
      let lastEnd = null;
      let gap = false;
      const runs = [];
      for (const it of r.items) {
        let sep = "";
        if (lastEnd != null && it.x - lastEnd > it.size * 0.15 && !text.endsWith(" ")) {
          sep = it.x - lastEnd > it.size * 2 ? "\t" : " ";
          if (sep === "\t") gap = true;
        }
        text += sep + it.str;
        const prev = runs[runs.length - 1];
        if (prev && prev.bold === it.bold && prev.italic === it.italic && prev.color === it.color && !sep.includes("\t")) prev.text += sep + it.str;
        else runs.push({ text: sep + it.str, bold: it.bold, italic: it.italic, color: it.color, size: it.size, font: cleanFontName(it.font) });
        lastEnd = it.x + it.w;
      }
      const minX = r.items[0].x;
      const [lx] = viewport.convertToViewportPoint(minX, r.y);
      const [rx] = viewport.convertToViewportPoint(lastEnd, r.y);
      const shade = mode(r.items.map((i) => [i.background, i.str.length]));
      const t = text.trim();
      pageLines.push({
        text: t,
        runs,
        align: Math.abs((lx + rx) / 2 - viewport.width / 2) < viewport.width * 0.06 && rx - lx < viewport.width * 0.85 ? "center" : "left",
        border: null,
        shade,
        inTable: gap && !!shade,
        cells: gap ? t.split("\t").map((c) => c.trim()) : null,
        bullet: BULLET_RE.exec(t)?.[1] || null,
        _y: viewport.convertToViewportPoint(0, r.y)[1],
        _size: Math.max(...r.items.map((i) => i.size)) * SCALE,
      });
    }

    // Attach each horizontal rule to the line just above it.
    if (img) {
      for (const rule of findRules(img)) {
        const above = pageLines.filter((l) => l._y < rule.y && rule.y - l._y < l._size * 1.6);
        const target = above[above.length - 1];
        if (target && !target.border) target.border = { color: rule.color, width: Math.max(0.5, rule.thickness / SCALE) };
      }
    }
    lines.push(...pageLines, { text: "", runs: [], align: "left", border: null, shade: null, inTable: false, cells: null, bullet: null });
  }

  const content = lines.filter((l) => l.text);
  if (!content.length) throw new Error("No text found. Is this a scanned PDF? Try uploading the Word version instead.");
  for (const l of lines) if (l.cells && l.cells.length < 2) l.cells = null;
  return { text: linesToText(lines), format: analyzeLayout(lines) };
}

// ---------- TXT ----------

function readText(text) {
  const lines = text.split(/\r?\n/).map((t) => ({
    text: t.trim(), runs: [{ text: t }], align: "left", border: null, shade: null, inTable: false, cells: null,
    bullet: BULLET_RE.exec(t)?.[1] || null,
  }));
  const format = analyzeLayout(lines.filter((l) => l.text));
  return { text: text.trim(), format: { ...format, font: null, accent: null, headingRule: true, bodySize: 10.5, nameSize: 22, headingSize: 11 } };
}

export async function importResume(file) {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("That file is over 5 MB. Please upload a smaller one.");
  const name = file.name.toLowerCase();
  let result;
  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    result = await readPdf(new Uint8Array(await file.arrayBuffer()));
  } else if (name.endsWith(".docx")) {
    result = await readDocx(await file.arrayBuffer());
  } else if (name.endsWith(".txt") || name.endsWith(".md") || file.type.startsWith("text/")) {
    result = readText(await file.text());
  } else if (name.endsWith(".doc")) {
    throw new Error("Old .doc files aren't supported. In Word, use File → Save As → .docx, then upload that.");
  } else {
    throw new Error("Please upload a PDF, Word (.docx) or text file.");
  }
  if (result.text.length < 30) throw new Error("We couldn't read enough text from that file.");
  result.format.filename = file.name;
  result.format.source = name.split(".").pop();
  return result;
}

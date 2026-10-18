// Reads an uploaded resume (PDF, DOCX or TXT) in the browser and returns
// its plain text plus a "format" describing how it looks: fonts, sizes,
// accent colour, name alignment and the section headings in order.

const PDFJS_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs";
const PDFJS_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs";
const JSZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// Known section headings mapped to the resume JSON keys the AI fills in.
const HEADING_PATTERNS = [
  ["summary", /^(professional\s+|career\s+|executive\s+)?(summary|profile|objective|about( me)?|overview)$/],
  ["experience", /^(professional\s+|work\s+|relevant\s+|employment\s+)?(experience|employment( history)?|work history|career history)$/],
  ["skills", /^(technical\s+|key\s+|core\s+)?(skills|competencies|expertise|technologies|skills (&|and) tools|tech stack)$/],
  ["projects", /^(key\s+|personal\s+|academic\s+)?projects$/],
  ["education", /^(education|academic (background|qualifications)|qualifications|education (&|and) training)$/],
  ["certifications", /^(certifications?|certificates|licen[cs]es( (&|and) certifications)?|courses)$/],
];

export function classifyHeading(line) {
  const raw = line.trim().replace(/[:•|]+$/, "").trim();
  if (!raw || raw.length > 40 || raw.split(/\s+/).length > 5) return null;
  const norm = raw.toLowerCase().replace(/\s+/g, " ");
  for (const [key, re] of HEADING_PATTERNS) if (re.test(norm)) return key;
  // Short ALL-CAPS lines are almost always section headings (Awards, Languages…).
  if (/[A-Z]/.test(raw) && raw === raw.toUpperCase() && !/\d{3,}|@/.test(raw) && raw.length >= 4) return "custom";
  return null;
}

const SERIF_HINT = /times|georgia|garamond|cambria|book|serif|minion|palatino|baskerville|caslon|didot|merriweather|libre/i;

function cleanFontName(name) {
  if (!name) return null;
  const n = name.replace(/^[A-Z]{6}\+/, "").replace(/[-,](bold|italic|regular|light|medium|semibold|black|oblique|roman|mt|ps).*$/i, "")
    .replace(/(PSMT|MT|PS)$/,"").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  if (!n || /^(g_d|f\d|t\d|ff\d)/i.test(n)) return null;
  return n;
}

function mode(values) {
  const counts = new Map();
  for (const [v, w] of values) if (v != null) counts.set(v, (counts.get(v) || 0) + (w || 1));
  let best = null, bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
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

// ---------- DOCX ----------

async function readDocx(buffer) {
  const JSZip = await loadScript(JSZIP_URL, "JSZip");
  const zip = await JSZip.loadAsync(buffer);
  const read = async (path) => (zip.file(path) ? zip.file(path).async("string") : null);
  const parse = (xml) => (xml ? new DOMParser().parseFromString(xml, "application/xml") : null);

  const doc = parse(await read("word/document.xml"));
  if (!doc) throw new Error("This doesn't look like a Word document.");
  const styles = parse(await read("word/styles.xml"));
  const theme = parse(await read("word/theme/theme1.xml"));

  const W = "w:";
  const attr = (node, name) => node?.getAttribute(W + name) ?? null;
  const child = (node, name) => {
    if (!node) return null;
    for (const c of node.children) if (c.tagName === W + name) return c;
    return null;
  };

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
    const b = child(rPr, "b");
    return {
      font: fontFromRFonts(child(rPr, "rFonts")),
      size: sz ? Number(sz) / 2 : null,
      color: color && color !== "auto" ? `#${color}` : null,
      bold: b ? attr(b, "val") !== "0" && attr(b, "val") !== "false" : null,
      caps: !!child(rPr, "caps"),
    };
  };

  // Style table (with one level of basedOn inheritance is enough in practice).
  const styleMap = new Map();
  if (styles) {
    for (const s of styles.getElementsByTagName("w:style")) {
      const id = attr(s, "styleId");
      const pPr = child(s, "pPr");
      styleMap.set(id, {
        basedOn: attr(child(s, "basedOn"), "val"),
        run: runProps(child(s, "rPr")),
        jc: attr(child(pPr, "jc"), "val"),
        border: !!child(child(pPr, "pBdr"), "bottom"),
      });
    }
  }
  const styleProps = (id) => {
    const s = styleMap.get(id);
    if (!s) return { run: {} };
    const base = s.basedOn ? styleMap.get(s.basedOn) : null;
    return {
      run: { ...(base?.run || {}), ...Object.fromEntries(Object.entries(s.run).filter(([, v]) => v != null && v !== false)) },
      jc: s.jc || base?.jc,
      border: s.border || base?.border,
    };
  };
  const rDefault = styles?.getElementsByTagName("w:rPrDefault")[0];
  const defaults = runProps(rDefault ? child(rDefault, "rPr") : null);
  const normal = styleProps("Normal").run;

  const paragraphs = [];
  for (const p of doc.getElementsByTagName("w:p")) {
    const pPr = child(p, "pPr");
    const sp = styleProps(attr(child(pPr, "pStyle"), "val"));
    let text = "";
    const runs = [];
    for (const r of p.getElementsByTagName("w:r")) {
      let t = "";
      for (const c of r.children) {
        if (c.tagName === "w:t") t += c.textContent;
        else if (c.tagName === "w:tab") t += "\t";
        else if (c.tagName === "w:br") t += "\n";
      }
      if (!t) continue;
      text += t;
      runs.push({ len: t.trim().length, ...sp.run, ...Object.fromEntries(Object.entries(runProps(child(r, "rPr"))).filter(([, v]) => v != null && v !== false)) });
    }
    paragraphs.push({
      text,
      runs,
      jc: attr(child(pPr, "jc"), "val") || sp.jc,
      border: !!child(child(pPr, "pBdr"), "bottom") || sp.border,
    });
  }

  const nonEmpty = paragraphs.filter((p) => p.text.trim());
  const allRuns = nonEmpty.flatMap((p) => p.runs);
  const bodySize = mode(allRuns.map((r) => [r.size ?? normal.size ?? defaults.size, r.len])) || 11;
  const font = mode(allRuns.map((r) => [r.font ?? normal.font ?? defaults.font, r.len])) || normal.font || defaults.font;

  const first = nonEmpty[0];
  const nameSize = first ? Math.max(...first.runs.map((r) => r.size ?? bodySize), bodySize) : bodySize * 2;
  const nameColor = first?.runs.find((r) => r.color && !/^#(000000|auto)$/i.test(r.color))?.color || null;

  const headings = [];
  let accent = null, headingSize = null, headingRule = false, headingUpper = true;
  for (const p of nonEmpty.slice(1)) {
    const line = p.text.trim();
    const key = classifyHeading(line);
    // A non-vocabulary heading must at least look like one (bold or bigger than body text).
    const looksLikeHeading = p.runs.some((r) => r.bold || (r.size ?? bodySize) > bodySize + 0.5 || r.caps);
    if (!key || (key === "custom" && !looksLikeHeading)) continue;
    headings.push({ key, heading: line.replace(/[:]+$/, "") });
    if (headings.length === 1) {
      accent = p.runs.find((r) => r.color && !/^#(000000)$/i.test(r.color))?.color || null;
      headingSize = Math.max(...p.runs.map((r) => r.size ?? bodySize));
      headingRule = !!p.border;
      headingUpper = line === line.toUpperCase() || p.runs.some((r) => r.caps);
    }
  }

  return {
    text: paragraphs.map((p) => p.text).join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    format: {
      font: font || null,
      serif: SERIF_HINT.test(font || ""),
      bodySize: clamp(bodySize, 8, 14),
      nameSize: clamp(nameSize, 14, 36),
      headingSize: clamp(headingSize || bodySize + 1, 9, 18),
      accent,
      nameColor,
      nameAlign: first?.jc === "center" ? "center" : "left",
      headingUpper,
      headingRule,
      sections: sectionsFromHeadings(headings),
    },
  };
}

// ---------- PDF ----------

async function readPdf(buffer) {
  const pdfjs = await import(PDFJS_URL);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const lines = [];
  let pageWidth = 612;

  for (let n = 1; n <= Math.min(pdf.numPages, 6); n++) {
    const page = await pdf.getPage(n);
    if (n === 1) pageWidth = page.getViewport({ scale: 1 }).width;
    const content = await page.getTextContent();
    // Resolve real font names (e.g. "ABCDEF+Calibri-Bold") once fonts are loaded.
    try { await page.getOperatorList(); } catch { /* names stay unknown */ }
    const fontName = (id) => {
      try { return page.commonObjs.get(id)?.name || null; } catch { return null; }
    };

    const rows = [];
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const [a, b, , , x, y] = item.transform;
      const size = Math.round(Math.hypot(a, b) * 2) / 2;
      const real = fontName(item.fontName);
      let row = rows.find((r) => Math.abs(r.y - y) < Math.max(2, size * 0.3));
      if (!row) rows.push((row = { y, items: [] }));
      row.items.push({ str: item.str, x, w: item.width, size, font: real, bold: /bold|black|heavy|semibold/i.test(real || "") });
    }
    rows.sort((p, q) => q.y - p.y);
    for (const r of rows) {
      r.items.sort((p, q) => p.x - q.x);
      let text = "";
      let lastEnd = null;
      for (const it of r.items) {
        if (lastEnd != null && it.x - lastEnd > it.size * 0.15 && !text.endsWith(" ")) text += it.x - lastEnd > it.size * 2 ? "\t" : " ";
        text += it.str;
        lastEnd = it.x + it.w;
      }
      const minX = r.items[0].x;
      const maxX = lastEnd;
      lines.push({
        text: text.trim(),
        size: Math.max(...r.items.map((i) => i.size)),
        bold: r.items.every((i) => i.bold),
        font: mode(r.items.map((i) => [i.font, i.str.length])),
        center: (minX + maxX) / 2,
        page: n,
      });
    }
    lines.push({ text: "", size: 0, page: n });
  }

  const content = lines.filter((l) => l.text);
  if (!content.length) throw new Error("No text found. Is this a scanned PDF? Try uploading the Word version instead.");

  const bodySize = mode(content.map((l) => [l.size, l.text.length])) || 11;
  const font = cleanFontName(mode(content.map((l) => [cleanFontName(l.font), l.text.length])));
  const first = content[0];

  const headings = [];
  let headingSize = null, headingUpper = true;
  for (const l of content.slice(1)) {
    const key = classifyHeading(l.text);
    const looksLikeHeading = l.bold || l.size > bodySize + 0.5;
    if (!key || (key === "custom" && !looksLikeHeading)) continue;
    headings.push({ key, heading: l.text.replace(/[:]+$/, "") });
    if (headings.length === 1) {
      headingSize = l.size;
      headingUpper = l.text === l.text.toUpperCase();
    }
  }

  return {
    text: lines.map((l) => l.text).join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    format: {
      font,
      serif: SERIF_HINT.test(font || ""),
      bodySize: clamp(bodySize, 8, 14),
      nameSize: clamp(first.size, 14, 36),
      headingSize: clamp(headingSize || bodySize + 1, 9, 18),
      accent: null,
      nameColor: null,
      nameAlign: Math.abs(first.center - pageWidth / 2) < pageWidth * 0.08 ? "center" : "left",
      headingUpper,
      headingRule: true,
      sections: sectionsFromHeadings(headings),
    },
  };
}

// ---------- TXT ----------

function readText(text) {
  const headings = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(1)
    .map((l) => ({ key: classifyHeading(l), heading: l.replace(/[:]+$/, "") }))
    .filter((h) => h.key && h.key !== "custom");
  return {
    text: text.trim(),
    format: {
      font: null, serif: false, bodySize: 10.5, nameSize: 22, headingSize: 11, accent: null, nameColor: null,
      nameAlign: "left", headingUpper: true, headingRule: true, sections: sectionsFromHeadings(headings),
    },
  };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(n * 2) / 2));
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

// Templates are plain style objects. The preview (CSS variables in app.js),
// the PDF export and the Word export all read the same object, so the three
// always match. Downloads are built from the on-screen resume, so edits made
// in the preview are included, and both contain real text (ATS-friendly).

const JSPDF_URL = "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";
const DOCX_URL = "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js";

const BASE_STYLE = {
  font: "Calibri", serif: false, bodySize: 10.5, nameSize: 24, headingSize: 10.5,
  accent: "#1c1e21", nameColor: "#1c1e21", nameAlign: "left",
  headingUpper: true, headingRule: true, ruleColor: "#c9ced6", ruleWidth: 0.75,
  titleColor: "#3b4048", titleUpper: false, titleBold: false,
  textColor: "#1c1e21", mutedColor: "#4b515a",
  skillsTable: false, tableShade: null, skillLabelColor: null,
  bulletChar: "•", bulletColor: null, leadIns: false,
  roleLayout: "dash", roleColor: null, roleUpper: false,
  datesBelow: false, datesItalic: false, sideBar: false,
};

export const TEMPLATE_STYLES = {
  classic: { ...BASE_STYLE, font: "Georgia", serif: true, nameAlign: "center" },
  modern: {
    ...BASE_STYLE, accent: "#1e3fb8", nameColor: "#1e3fb8", ruleColor: "#1e3fb8", sideBar: true,
  },
  minimal: {
    ...BASE_STYLE, nameSize: 22, headingSize: 11.5, accent: "#6b7280", headingUpper: false, headingRule: false,
  },
  // Teal executive look: rules under headings, shaded skills table, bold lead-ins.
  executive: {
    ...BASE_STYLE, bodySize: 10, nameSize: 22, headingSize: 11, nameColor: "#0F172A", nameAlign: "center",
    accent: "#0E7490", ruleColor: "#0E7490", ruleWidth: 1.5,
    titleColor: "#0E7490", titleUpper: true, titleBold: true,
    textColor: "#334155", mutedColor: "#64748B",
    skillsTable: true, tableShade: "#F1F5F9", skillLabelColor: "#0E7490",
    bulletChar: "●", bulletColor: "#0E7490", leadIns: true,
    roleLayout: "pipe", roleColor: "#0E7490", roleUpper: true, datesBelow: true, datesItalic: true,
  },
};

// "My format": the detected upload format layered over sensible defaults.
export function resolveStyle(template, uploadFormat) {
  if (template !== "upload" || !uploadFormat) return TEMPLATE_STYLES[template] || TEMPLATE_STYLES.classic;
  const detected = Object.fromEntries(Object.entries(uploadFormat).filter(([, v]) => v != null));
  const st = { ...BASE_STYLE, ...detected };
  st.font = uploadFormat.font || (uploadFormat.serif ? "Georgia" : "Calibri");
  st.accent = uploadFormat.accent || BASE_STYLE.accent;
  st.ruleColor = uploadFormat.ruleColor || (uploadFormat.accent && uploadFormat.headingRule ? uploadFormat.accent : BASE_STYLE.ruleColor);
  st.titleColor = uploadFormat.titleColor || BASE_STYLE.titleColor;
  st.headingUpper = uploadFormat.headingUpper !== false;
  st.headingRule = uploadFormat.headingRule !== false;
  return st;
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

const text = (node) => (node?.innerText ?? node?.textContent ?? "").replace(/\s+/g, " ").trim();

// ---------- Read the preview DOM ----------

function readBullets(ul) {
  return [...ul.querySelectorAll(":scope > li")].map((li) => {
    const lead = li.querySelector(":scope > .r-lead");
    const all = text(li);
    if (!lead) return { lead: "", text: all };
    const l = text(lead);
    return { lead: l, text: all.startsWith(l) ? all.slice(l.length).trim() : all };
  }).filter((b) => b.lead || b.text);
}

export function readResumeDom(root) {
  const model = {
    name: text(root.querySelector(".r-header h1")),
    headline: text(root.querySelector(".r-headline")),
    contact: [...root.querySelectorAll(".r-contact > *")].map(text).filter(Boolean),
    sections: [],
  };
  for (const sec of root.querySelectorAll(".r-section")) {
    const section = { heading: text(sec.querySelector("h2")), blocks: [] };
    for (const node of sec.children) {
      if (node.tagName === "H2") continue;
      if (node.classList.contains("r-item")) {
        const head = node.querySelector(".r-item-head");
        section.blocks.push({
          type: "item",
          title: text(head?.querySelector(".r-role, .r-degree, strong")),
          org: text(head?.querySelector(".r-org")),
          dates: text(head?.querySelector(".r-dates")),
          isRole: !!head?.querySelector(".r-role"),
          paras: [...node.querySelectorAll(":scope > p")].map(text).filter(Boolean),
          bullets: [...node.querySelectorAll(":scope > ul")].flatMap(readBullets),
        });
      } else if (node.classList.contains("r-skills")) {
        section.blocks.push({
          type: "skills",
          rows: [...node.querySelectorAll(".r-skill-row")].map((row) => ({
            label: text(row.querySelector(".r-skill-label")),
            text: text(row.querySelector(".r-skill-items")),
          })).filter((r) => r.label || r.text),
        });
      } else if (node.tagName === "UL") {
        section.blocks.push({ type: "bullets", items: readBullets(node) });
      } else if (text(node)) {
        section.blocks.push({ type: "para", text: text(node) });
      }
    }
    model.sections.push(section);
  }
  return model;
}

export function fileBaseName(model, title) {
  const base = [model.name, title].filter(Boolean).join(" - ") || "Resume";
  return base.replace(/[\\/:*?"<>|]+/g, "").slice(0, 80);
}

function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

const roleText = (block, style) => (block.isRole && style.roleUpper ? block.title.toUpperCase() : block.title);
const orgSep = (style) => (style.roleLayout === "pipe" ? " | " : " — ");

// ---------- PDF (jsPDF, built-in fonts → selectable text) ----------

// The built-in PDF fonts only cover Windows-1252; swap the few common characters outside it.
function pdfSafe(s) {
  return s
    .replace(/[‐-‒−]/g, "-")
    .replace(/[→⇒]/g, "->")
    .replace(/₹/g, "Rs.")
    .replace(/[^\x00-\xff–—‘’“”•…€ŒœŠšŸŽžƒˆ˜†‡‰‹›™]/g, "");
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return [28, 30, 33];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export async function downloadPdf(model, style, filename) {
  await loadScript(JSPDF_URL, "jspdf");
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: "pt", format: "a4" });
  const family = style.serif ? "times" : "helvetica";
  const W = pdf.internal.pageSize.getWidth();
  const H = pdf.internal.pageSize.getHeight();
  const M = 46;
  const width = W - 2 * M;
  const body = style.bodySize;
  const lh = (size) => size * 1.3;
  const ink = hexToRgb(style.textColor);
  const muted = hexToRgb(style.mutedColor);
  const accent = hexToRgb(style.accent);
  let y = M;

  const set = (size, weight = "normal", color = ink) => {
    pdf.setFont(family, weight);
    pdf.setFontSize(size);
    pdf.setTextColor(...color);
  };
  const ensure = (h) => {
    if (y + h > H - M) {
      pdf.addPage();
      y = M;
    }
  };
  const write = (str, { size = body, weight = "normal", color = ink, x = M, w = width, align = "left", gap = 0 } = {}) => {
    if (!str) return;
    set(size, weight, color);
    for (const line of pdf.splitTextToSize(pdfSafe(str), w)) {
      ensure(lh(size));
      pdf.text(line, align === "center" ? W / 2 : x, y + size, { align: align === "center" ? "center" : undefined });
      y += lh(size);
    }
    y += gap;
  };
  // Writes a sequence of styled pieces as one wrapped paragraph.
  const writeRich = (pieces, { x = M, w = width, size = body } = {}) => {
    const words = [];
    for (const p of pieces) {
      for (const [i, word] of pdfSafe(p.text).split(/(\s+)/).entries()) {
        if (word) words.push({ ...p, text: word, space: i % 2 === 1 });
      }
    }
    let line = [];
    let lineW = 0;
    const flush = () => {
      ensure(lh(size));
      let cx = x;
      for (const wd of line) {
        set(size, wd.weight || "normal", wd.color || ink);
        pdf.text(wd.text, cx, y + size);
        cx += pdf.getTextWidth(wd.text);
      }
      y += lh(size);
      line = [];
      lineW = 0;
    };
    for (const wd of words) {
      set(size, wd.weight || "normal");
      const ww = pdf.getTextWidth(wd.text);
      if (wd.space && !line.length) continue;
      if (lineW + ww > w && line.length) {
        while (line.length && line[line.length - 1].space) line.pop();
        flush();
        if (wd.space) continue;
      }
      line.push(wd);
      lineW += ww;
    }
    while (line.length && line[line.length - 1].space) line.pop();
    if (line.length) flush();
  };

  // Header
  const align = style.nameAlign === "center" ? "center" : "left";
  write(model.name, { size: style.nameSize, weight: "bold", color: hexToRgb(style.nameColor), align, gap: 2 });
  write(style.titleUpper ? model.headline.toUpperCase() : model.headline, {
    size: body + 1.5, weight: style.titleBold ? "bold" : "normal", color: hexToRgb(style.titleColor), align, gap: 2,
  });
  write(model.contact.join("  |  "), { size: body - 1, color: muted, align, gap: 4 });
  if (style.sideBar) {
    pdf.setFillColor(...accent);
    pdf.rect(M - 12, M, 3, y - M - 4, "F");
  }

  const bullet = (b, indent = 12) => {
    const bx = M + indent - 9;
    ensure(lh(body));
    set(body, "bold", hexToRgb(style.bulletColor || style.textColor));
    // Use the round bullet glyph the built-in fonts have.
    pdf.text("•", bx, y + body);
    const pieces = [];
    if (b.lead) pieces.push({ text: `${b.lead} `, weight: "bold", color: hexToRgb(style.textColor === "#1c1e21" ? "#1c1e21" : "#0F172A") });
    pieces.push({ text: b.text });
    writeRich(pieces, { x: M + indent, w: width - indent });
  };

  for (const section of model.sections) {
    y += 9;
    ensure(lh(style.headingSize) + lh(body) * 3);
    write(style.headingUpper ? section.heading.toUpperCase() : section.heading, { size: style.headingSize, weight: "bold", color: accent });
    if (style.headingRule) {
      pdf.setDrawColor(...hexToRgb(style.ruleColor));
      pdf.setLineWidth(style.ruleWidth);
      pdf.line(M, y + 1, W - M, y + 1);
      y += 6;
    } else {
      y += 2;
    }

    for (const block of section.blocks) {
      if (block.type === "item") {
        ensure(lh(body) * 3);
        const title = roleText(block, style);
        const datesW = !style.datesBelow && block.dates ? (set(body - 1), pdf.getTextWidth(pdfSafe(block.dates)) + 12) : 0;
        if (datesW) {
          set(body - 1, style.datesItalic ? "italic" : "normal", muted);
          pdf.text(pdfSafe(block.dates), W - M, y + body, { align: "right" });
        }
        const pieces = [{ text: title, weight: "bold", color: hexToRgb(block.isRole ? style.roleColor || style.textColor : style.textColor) }];
        if (block.org) {
          pieces.push(style.roleLayout === "pipe"
            ? { text: ` | ${block.org}`, weight: "bold", color: hexToRgb("#0F172A") }
            : { text: ` — ${block.org}`, color: muted });
        }
        writeRich(pieces, { w: width - datesW });
        if (style.datesBelow && block.dates) write(block.dates, { size: body - 0.5, weight: style.datesItalic ? "italic" : "normal", color: muted, gap: 1 });
        for (const p of block.paras) write(p);
        for (const b of block.bullets) bullet(b);
        y += 4;
      } else if (block.type === "skills") {
        if (style.skillsTable) {
          const labelW = width * 0.3;
          const pad = 4;
          block.rows.forEach((row) => {
            set(body - 0.5);
            const lines = pdf.splitTextToSize(pdfSafe(row.text), width - labelW - pad * 2);
            set(body - 0.5, "bold");
            const labelLines = pdf.splitTextToSize(pdfSafe(`•  ${row.label}`), labelW - pad * 2);
            const h = Math.max(lines.length, labelLines.length) * lh(body - 0.5) + pad * 2;
            ensure(h + 2);
            if (style.tableShade) {
              pdf.setFillColor(...hexToRgb(style.tableShade));
              pdf.rect(M, y, width, h, "F");
            }
            set(body - 0.5, "bold", hexToRgb(style.skillLabelColor || style.textColor));
            labelLines.forEach((l, i) => pdf.text(l, M + pad, y + pad + (body - 0.5) + i * lh(body - 0.5)));
            set(body - 0.5, "normal", ink);
            lines.forEach((l, i) => pdf.text(l, M + labelW + pad, y + pad + (body - 0.5) + i * lh(body - 0.5)));
            y += h + 2;
          });
        } else {
          for (const row of block.rows) {
            writeRich(row.label ? [{ text: `${row.label}: `, weight: "bold" }, { text: row.text }] : [{ text: row.text }]);
          }
        }
      } else if (block.type === "bullets") {
        for (const b of block.items) bullet(b);
      } else {
        write(block.text, { gap: 2 });
      }
    }
  }

  download(pdf.output("blob"), `${filename}.pdf`);
}

// ---------- DOCX (docx library) ----------

export async function downloadDocx(model, style, filename) {
  await loadScript(DOCX_URL, "docx");
  const {
    Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle, TabStopType, LevelFormat,
    Table, TableRow, TableCell, WidthType, ShadingType,
  } = window.docx;

  const half = (pt) => Math.round(pt * 2);
  const c = (hex) => (hex || "#1c1e21").replace("#", "").toUpperCase();
  const pageWidth = 11906; // A4, twips
  const margin = 850;
  const textWidth = pageWidth - margin * 2;
  const align = style.nameAlign === "center" ? AlignmentType.CENTER : AlignmentType.LEFT;
  const strong = style.textColor === BASE_STYLE.textColor ? c(style.textColor) : "0F172A";
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };

  const bulletPara = (b) => new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { before: 20, after: 40 },
    children: [
      ...(b.lead ? [new TextRun({ text: `${b.lead} `, bold: true, color: strong })] : []),
      new TextRun({ text: b.text }),
    ],
  });

  const children = [];
  const sideBar = style.sideBar
    ? { left: { style: BorderStyle.SINGLE, size: 24, space: 8, color: c(style.accent) } }
    : undefined;
  children.push(new Paragraph({
    alignment: align, border: sideBar,
    children: [new TextRun({ text: model.name, bold: true, size: half(style.nameSize), color: c(style.nameColor) })],
  }));
  if (model.headline) {
    children.push(new Paragraph({
      alignment: align, border: sideBar, spacing: { before: 40 },
      children: [new TextRun({
        text: model.headline, allCaps: style.titleUpper, bold: style.titleBold,
        size: half(style.bodySize + 1.5), color: c(style.titleColor),
      })],
    }));
  }
  if (model.contact.length) {
    children.push(new Paragraph({
      alignment: align, border: sideBar, spacing: { before: 40, after: 120 },
      children: [new TextRun({ text: model.contact.join("  |  "), size: half(style.bodySize - 1), color: c(style.mutedColor) })],
    }));
  }

  for (const section of model.sections) {
    children.push(new Paragraph({
      spacing: { before: 240, after: 100 },
      keepNext: true,
      border: style.headingRule
        ? { bottom: { style: BorderStyle.SINGLE, size: Math.round(style.ruleWidth * 8), space: 2, color: c(style.ruleColor) } }
        : undefined,
      children: [new TextRun({
        text: section.heading, allCaps: style.headingUpper, bold: true,
        size: half(style.headingSize), color: c(style.accent),
      })],
    }));

    for (const block of section.blocks) {
      if (block.type === "item") {
        const runs = [new TextRun({
          text: block.title, bold: true, allCaps: block.isRole && style.roleUpper,
          color: c(block.isRole ? style.roleColor || style.textColor : style.textColor),
        })];
        if (block.org) {
          runs.push(style.roleLayout === "pipe"
            ? new TextRun({ text: ` | ${block.org}`, bold: true, color: strong })
            : new TextRun({ text: ` — ${block.org}`, color: c(style.mutedColor) }));
        }
        if (block.dates && !style.datesBelow) {
          runs.push(new TextRun({ text: `\t${block.dates}`, italics: style.datesItalic, color: c(style.mutedColor), size: half(style.bodySize - 1) }));
        }
        children.push(new Paragraph({
          spacing: { before: 120, after: 20 }, keepNext: true,
          tabStops: [{ type: TabStopType.RIGHT, position: textWidth }],
          children: runs,
        }));
        if (block.dates && style.datesBelow) {
          children.push(new Paragraph({
            spacing: { after: 60 }, keepNext: true,
            children: [new TextRun({ text: block.dates, italics: style.datesItalic, color: c(style.mutedColor), size: half(style.bodySize - 0.5) })],
          }));
        }
        for (const p of block.paras) children.push(new Paragraph({ text: p }));
        for (const b of block.bullets) children.push(bulletPara(b));
      } else if (block.type === "skills") {
        if (style.skillsTable) {
          const labelW = Math.round(textWidth * 0.3);
          const cell = (content, w) => new TableCell({
            width: { size: w, type: WidthType.DXA },
            shading: style.tableShade ? { type: ShadingType.CLEAR, color: "auto", fill: c(style.tableShade) } : undefined,
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            borders: { top: none, bottom: none, left: none, right: none },
            children: [content],
          });
          children.push(new Table({
            width: { size: textWidth, type: WidthType.DXA },
            columnWidths: [labelW, textWidth - labelW],
            borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: { style: BorderStyle.SINGLE, size: 12, color: "FFFFFF" }, insideVertical: none },
            rows: block.rows.map((row) => new TableRow({
              children: [
                cell(new Paragraph({ children: [new TextRun({ text: row.label ? `•  ${row.label}` : "", bold: true, color: c(style.skillLabelColor || style.textColor), size: half(style.bodySize - 0.5) })] }), labelW),
                cell(new Paragraph({ children: [new TextRun({ text: row.text, size: half(style.bodySize - 0.5) })] }), textWidth - labelW),
              ],
            })),
          }));
        } else {
          for (const row of block.rows) {
            children.push(new Paragraph({
              children: row.label ? [new TextRun({ text: `${row.label}: `, bold: true }), new TextRun(row.text)] : [new TextRun(row.text)],
            }));
          }
        }
      } else if (block.type === "bullets") {
        for (const b of block.items) children.push(bulletPara(b));
      } else {
        children.push(new Paragraph({ text: block.text, spacing: { after: 60 } }));
      }
    }
  }

  const doc = new Document({
    creator: "CVCraft",
    title: filename,
    styles: {
      default: {
        document: { run: { font: style.font, size: half(style.bodySize), color: c(style.textColor) }, paragraph: { spacing: { line: 264 } } },
      },
    },
    numbering: {
      config: [{
        reference: "bullets",
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: style.bulletChar || "•", alignment: AlignmentType.LEFT,
          style: {
            paragraph: { indent: { left: 400, hanging: 260 } },
            run: { color: c(style.bulletColor || style.textColor), bold: true },
          },
        }],
      }],
    },
    sections: [{
      properties: { page: { size: { width: pageWidth, height: 16838 }, margin: { top: margin, bottom: margin, left: margin, right: margin } } },
      children,
    }],
  });

  download(await Packer.toBlob(doc), `${filename}.docx`);
}

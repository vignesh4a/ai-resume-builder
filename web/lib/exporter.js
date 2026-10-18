// Builds downloadable PDF and DOCX files from the on-screen resume, so any
// edits made in the preview are included. Both outputs contain real text,
// which keeps them readable by applicant tracking systems.

const JSPDF_URL = "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";
const DOCX_URL = "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js";

export const TEMPLATE_STYLES = {
  classic: {
    font: "Georgia", serif: true, bodySize: 10.5, nameSize: 24, headingSize: 10.5,
    accent: "#1c1e21", nameColor: "#1c1e21", nameAlign: "center", headingUpper: true, headingRule: true,
  },
  modern: {
    font: "Calibri", serif: false, bodySize: 10.5, nameSize: 24, headingSize: 10.5,
    accent: "#1e3fb8", nameColor: "#1e3fb8", nameAlign: "left", headingUpper: true, headingRule: true,
  },
  minimal: {
    font: "Calibri", serif: false, bodySize: 10.5, nameSize: 22, headingSize: 11.5,
    accent: "#6b7280", nameColor: "#1c1e21", nameAlign: "left", headingUpper: false, headingRule: false,
  },
};

// Fill gaps in a detected upload format with sensible defaults.
export function resolveStyle(template, uploadFormat) {
  if (template !== "upload" || !uploadFormat) return TEMPLATE_STYLES[template] || TEMPLATE_STYLES.classic;
  const f = uploadFormat;
  return {
    font: f.font || (f.serif ? "Georgia" : "Calibri"),
    serif: !!f.serif,
    bodySize: f.bodySize || 10.5,
    nameSize: f.nameSize || 22,
    headingSize: f.headingSize || 11,
    accent: f.accent || "#1c1e21",
    nameColor: f.nameColor || "#1c1e21",
    nameAlign: f.nameAlign || "left",
    headingUpper: f.headingUpper !== false,
    headingRule: f.headingRule !== false,
  };
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
          title: text(head?.querySelector("strong")),
          org: text(head?.querySelector(".r-org")),
          dates: text(head?.querySelector(".r-dates")),
          paras: [...node.querySelectorAll(":scope > p")].map(text).filter(Boolean),
          bullets: [...node.querySelectorAll(":scope > ul > li")].map(text).filter(Boolean),
        });
      } else if (node.classList.contains("r-skills")) {
        for (const p of node.querySelectorAll("p")) {
          const label = text(p.querySelector("strong")).replace(/:\s*$/, "");
          const all = text(p);
          section.blocks.push({ type: "skill", label, text: label ? all.slice(all.indexOf(":") + 1).trim() : all });
        }
      } else if (node.tagName === "UL") {
        section.blocks.push({ type: "bullets", items: [...node.querySelectorAll("li")].map(text).filter(Boolean) });
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
  const M = 48;
  const width = W - 2 * M;
  const body = style.bodySize;
  const lh = (size) => size * 1.32;
  const ink = [28, 30, 33];
  const soft = [75, 81, 90];
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
      const tx = align === "center" ? W / 2 : x;
      pdf.text(line, tx, y + size, { align: align === "center" ? "center" : undefined });
      y += lh(size);
    }
    y += gap;
  };

  // Header
  const center = style.nameAlign === "center" ? "center" : "left";
  write(model.name, { size: style.nameSize, weight: "bold", color: hexToRgb(style.nameColor), align: center, gap: 2 });
  write(model.headline, { size: body + 1.5, color: soft, align: center, gap: 2 });
  write(model.contact.join("   |   "), { size: body - 1, color: soft, align: center, gap: 6 });

  for (const section of model.sections) {
    y += 8;
    ensure(lh(style.headingSize) + lh(body) * 2);
    const heading = style.headingUpper ? section.heading.toUpperCase() : section.heading;
    write(heading, { size: style.headingSize, weight: "bold", color: hexToRgb(style.accent) });
    if (style.headingRule) {
      pdf.setDrawColor(...hexToRgb(style.accent === "#1c1e21" ? "#c9ced6" : style.accent));
      pdf.setLineWidth(0.7);
      pdf.line(M, y + 1, W - M, y + 1);
      y += 5;
    } else {
      y += 2;
    }

    for (const block of section.blocks) {
      if (block.type === "item") {
        ensure(lh(body) * 2);
        set(body - 1, "normal", soft);
        const datesW = block.dates ? pdf.getTextWidth(pdfSafe(block.dates)) + 12 : 0;
        if (block.dates) pdf.text(pdfSafe(block.dates), W - M, y + body, { align: "right" });
        // Title (bold) and organisation on the left, wrapping before the dates column.
        set(body, "bold");
        const title = pdfSafe(block.title);
        const titleW = pdf.getTextWidth(title);
        if (titleW < width - datesW - 40 && block.org) {
          pdf.text(title, M, y + body);
          set(body, "normal", soft);
          const orgLines = pdf.splitTextToSize(pdfSafe(` — ${block.org}`), width - datesW - titleW);
          pdf.text(orgLines[0], M + titleW, y + body);
          y += lh(body);
          for (const extra of orgLines.slice(1)) write(extra.trim(), { color: soft });
        } else {
          write(block.title, { weight: "bold", w: width - datesW });
          if (block.org) write(block.org, { color: soft });
        }
        for (const p of block.paras) write(p);
        for (const b of block.bullets) bullet(b);
        y += 4;
      } else if (block.type === "skill") {
        ensure(lh(body));
        if (block.label) {
          set(body, "bold");
          const label = pdfSafe(`${block.label}: `);
          const lw = pdf.getTextWidth(label);
          pdf.text(label, M, y + body);
          set(body, "normal");
          const lines = pdf.splitTextToSize(pdfSafe(block.text), width - lw);
          pdf.text(lines[0] || "", M + lw, y + body);
          y += lh(body);
          for (const l of lines.slice(1)) write(l);
        } else {
          write(block.text);
        }
      } else if (block.type === "bullets") {
        for (const b of block.items) bullet(b);
      } else {
        write(block.text, { gap: 2 });
      }
    }
  }

  function bullet(str) {
    set(body);
    const lines = pdf.splitTextToSize(pdfSafe(str), width - 14);
    lines.forEach((line, i) => {
      ensure(lh(body));
      if (i === 0) pdf.text("•", M + 3, y + body);
      pdf.text(line, M + 14, y + body);
      y += lh(body);
    });
  }

  download(pdf.output("blob"), `${filename}.pdf`);
}

// ---------- DOCX (docx library) ----------

export async function downloadDocx(model, style, filename) {
  await loadScript(DOCX_URL, "docx");
  const {
    Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle, TabStopType, LevelFormat,
  } = window.docx;

  const half = (pt) => Math.round(pt * 2);
  const color = (hex) => (hex || "#1c1e21").replace("#", "");
  const soft = "4B515A";
  const pageWidth = 11906; // A4, twips
  const margin = 850;
  const textWidth = pageWidth - margin * 2;
  const align = style.nameAlign === "center" ? AlignmentType.CENTER : AlignmentType.LEFT;

  const children = [];
  children.push(new Paragraph({
    alignment: align,
    children: [new TextRun({ text: model.name, bold: true, size: half(style.nameSize), color: color(style.nameColor) })],
  }));
  if (model.headline) {
    children.push(new Paragraph({
      alignment: align,
      children: [new TextRun({ text: model.headline, size: half(style.bodySize + 1.5), color: soft })],
    }));
  }
  if (model.contact.length) {
    children.push(new Paragraph({
      alignment: align,
      spacing: { after: 120 },
      children: [new TextRun({ text: model.contact.join("  |  "), size: half(style.bodySize - 1), color: soft })],
    }));
  }

  for (const section of model.sections) {
    children.push(new Paragraph({
      spacing: { before: 220, after: 80 },
      keepNext: true,
      border: style.headingRule
        ? { bottom: { style: BorderStyle.SINGLE, size: 6, space: 2, color: style.accent === "#1c1e21" ? "C9CED6" : color(style.accent) } }
        : undefined,
      children: [new TextRun({
        text: style.headingUpper ? section.heading.toUpperCase() : section.heading,
        bold: true, size: half(style.headingSize), color: color(style.accent),
      })],
    }));

    for (const block of section.blocks) {
      if (block.type === "item") {
        const runs = [new TextRun({ text: block.title, bold: true })];
        if (block.org) runs.push(new TextRun({ text: ` — ${block.org}`, color: soft }));
        if (block.dates) runs.push(new TextRun({ text: `\t${block.dates}`, color: soft, size: half(style.bodySize - 1) }));
        children.push(new Paragraph({
          spacing: { before: 100 },
          keepNext: true,
          tabStops: [{ type: TabStopType.RIGHT, position: textWidth }],
          children: runs,
        }));
        for (const p of block.paras) children.push(new Paragraph({ text: p }));
        for (const b of block.bullets) children.push(new Paragraph({ text: b, numbering: { reference: "bullets", level: 0 } }));
      } else if (block.type === "skill") {
        children.push(new Paragraph({
          children: block.label
            ? [new TextRun({ text: `${block.label}: `, bold: true }), new TextRun(block.text)]
            : [new TextRun(block.text)],
        }));
      } else if (block.type === "bullets") {
        for (const b of block.items) children.push(new Paragraph({ text: b, numbering: { reference: "bullets", level: 0 } }));
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
        document: { run: { font: style.font, size: half(style.bodySize), color: "1C1E21" }, paragraph: { spacing: { line: 264 } } },
      },
    },
    numbering: {
      config: [{
        reference: "bullets",
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 360, hanging: 240 } } },
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

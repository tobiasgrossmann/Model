import fs from "node:fs";
import path from "node:path";

const RAG_DIR = process.env.RAG_DIR || "./rag";
const TARGETED_NOISY = process.argv.includes("--targeted-noisy");
const NOISY_THRESHOLD = Number(process.env.NOISY_THRESHOLD || "300");

const SINGLE_LINE_NOISE = [
  /^Zum Hauptinhalt springen$/i,
  /^Alle Schweizer Bundesbeh(ö|o)rden$/i,
  /^Sprach Dropdown/i,
  /^DE$/,
  /^FR$/,
  /^IT$/,
  /^EN$/,
  /^Suche$/i,
  /^Kontakt$/i,
  /^Medien$/i,
  /^Jobs$/i,
  /^Dashboard$/i,
  /^awisa$/i,
  /^Facebook$/i,
  /^Instagram$/i,
  /^YouTube$/i,
  /^LinkedIn$/i,
  /^Newsletter$/i,
  /^Rechtliches$/i,
  /^Barrierefreiheit$/i,
  /^Impressum$/i,
  /^Bleiben Sie informiert$/i,
  /^BLV$/,
  /^Bundesamt f(ü|u)r Lebensmittelsicherheit und Veterin(ä|a)rwesen$/i,
  /^2\.4\.1\.5 Jodiertes Salz$/i,
  /^Inhaltsverzeichnis$/i,
  /^Mehr erfahren$/i,
  /^Mehr Informationen:?$/i,
  /^Weitere Informationen:?$/i,
  /^Tipp$/i,
  /^Gesundheitstipp$/i,
  /^Nachhaltigkeitstipp$/i,
  /^Beispiele f(ü|u)r 1 Portion$/i,
  /^©\s*BLV\s*\|\s*OSAV\s*\|\s*USAV\s*\|\s*FSVO$/i,
  /^©\s*sge-ssn\.ch,\s*blv\.admin\.ch\s*\/\s*2024$/i,
];

const FOOTER_START = [
  /^\s*(Ü|U)ber uns\s*$/i,
  /^\s*Bleiben Sie informiert\s*$/i,
  /^\s*###\s*Home\b/i,
  /^\s*-\s*Home\b/i,
  /^\s*###\s*iMpuls Newsletter\b/i,
  /^\s*iMpuls Newsletter\b/i,
  /^\s*###\s*Das könnte dich interessieren:?\s*$/i,
  /^\s*Beschreibung\s+Mehr zum Thema\b/i,
  /^\s*###\s*Zum Dossier\s*$/i,
  /^\s*###\s*Zum Angebot\s*$/i,
  /^\s*###\s*Erfahre mehr zum\s*$/i,
];

const FILE_HEADER_NOISE = [
  /^BLV$/,
  /^Suche$/i,
  /^Kontakt$/i,
  /^Medien$/i,
  /^Jobs$/i,
  /^Dashboard$/i,
  /^awisa$/i,
  /^DE$/,
  /^FR$/,
  /^IT$/,
  /^EN$/,
  /^Bundesamt f(ü|u)r Lebensmittelsicherheit und Veterin(ä|a)rwesen$/i,
];

const LIST_INTRO_HINT = [
  /:$/,
  /^Tipps?$/i,
  /^Beteiligte Unternehmen$/i,
  /^Die wichtigsten Resultate$/i,
  /^Beispiele f(ü|u)r/i,
  /^Mehr Informationen$/i,
  /^Weitere Informationen$/i,
];

function isHeading(line) {
  return /^#{1,6}\s+/.test(line.trim());
}

function isBullet(line) {
  return /^\s*[-*+]\s+/.test(line);
}

function isNumbered(line) {
  return /^\s*\d+[.)]\s+/.test(line);
}

function isPdfMetaLine(text) {
  return /^PDF$/i.test(text) ||
    /^\d+(?:[.,]\d+)?\s*(?:kB|KB|MB|GB)$/i.test(text) ||
    /^\d{1,2}\.\s+[A-Za-zÄÖÜäöü]+\s+\d{4}$/i.test(text);
}

function isLikelySentence(text) {
  return /[a-zäöüàâçéèêëîïôûùüÿñæœ]{3,}/i.test(text) && /[.!?]$/.test(text);
}

function isLikelyHeaderText(text) {
  if (!text) return false;
  if (text.length < 4 || text.length > 90) return false;
  if (isLikelySentence(text)) return false;
  if (/[.!?]$/.test(text)) return false;
  if (isPdfMetaLine(text)) return false;
  if (/^\d+$/.test(text)) return false;
  if (/^\d+\s*(g|kg|ml|l|dl|kcal|prozent|%)\b/i.test(text)) return false;
  if (/^https?:\/\//i.test(text)) return false;
  return true;
}

function shouldBeBulletItem(text) {
  if (!text) return false;
  if (isPdfMetaLine(text)) return false;
  if (text.length > 120) return false;
  if (isLikelySentence(text) && text.length > 70) return false;
  if (/^\d+(?:[.,]\d+)?\s*(g|kg|ml|l|dl|kcal|%|prozent)\b/i.test(text)) return true;
  if (/^[A-ZÄÖÜ][A-Za-zÄÖÜäöüß\-\s,&().]+$/.test(text) && text.length <= 80) return true;
  return false;
}

function promoteHeadings(lines) {
  const out = [];
  let lastWasHeading = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = line.trim();
    const prev = i > 0 ? lines[i - 1].trim() : "";
    const next = i + 1 < lines.length ? lines[i + 1].trim() : "";

    if (!text || isHeading(text) || isBullet(text) || isNumbered(text)) {
      out.push(line);
      lastWasHeading = isHeading(text);
      continue;
    }

    const precededByBlank = prev === "";
    const followedByContent = !!next;
    const followedByParagraph = next.length > 60 || /[a-zäöüàâçéèêëîïôûùüÿñæœ]/i.test(next);

    if (isLikelyHeaderText(text) && precededByBlank && followedByContent && followedByParagraph) {
      const level = lastWasHeading ? "###" : "##";
      out.push(`${level} ${text}`);
      lastWasHeading = true;
      continue;
    }

    out.push(line);
    lastWasHeading = false;
  }

  return out;
}

function convertListLikeSequences(lines) {
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = line.trim();
    out.push(line);

    const intro = LIST_INTRO_HINT.some((re) => re.test(text));
    if (!intro) continue;

    const run = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const candidate = lines[j];
      const ctext = candidate.trim();
      if (!ctext) break;
      if (isHeading(ctext) || isBullet(ctext) || isNumbered(ctext)) break;
      if (ctext.length > 140) break;
      if (isPdfMetaLine(ctext)) {
        run.push({ line: candidate, bullet: false });
        continue;
      }
      run.push({ line: candidate, bullet: shouldBeBulletItem(ctext) });
    }

    const bulletCount = run.filter((x) => x.bullet).length;
    if (run.length >= 2 && bulletCount >= 2) {
      out.pop();
      out.push(line);
      for (const entry of run) {
        if (entry.bullet) {
          out.push(`- ${entry.line.trim()}`);
        } else {
          out.push(entry.line);
        }
      }
      i = j - 1;
    }
  }

  return out;
}

function splitInlineHeadings(line) {
  if (TARGETED_NOISY) return [line];
  if (line.length < 180) return [line];

  const transformed = line.replace(
    /([.!?])\s+([A-ZÄÖÜ][^.!?\n]{4,80}?)\s+(?=[A-ZÄÖÜ][a-zäöüàâçéèêëîïôûùüÿñæœ])/g,
    (match, endPunct, candidate) => {
      const text = String(candidate || "").trim();
      if (!isLikelyHeaderText(text)) return match;
      if (/[,:;()]/.test(text)) return match;
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < 2 || words.length > 9) return match;
      return `${endPunct}\n\n### ${text}\n`;
    }
  );

  return transformed.split("\n");
}

function normalizeHeadingNoise(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^[IVXLC]+$/i.test(trimmed)) {
      continue;
    }

    if (/^#{1,3}\s+Schweizer\s+Sportobservatorium:.*Forschungsbericht\s+\d+\s*$/i.test(trimmed)) {
      continue;
    }
    if (/^#{1,3}\s+[IVXLC]+\s*$/i.test(trimmed)) {
      continue;
    }

    const m3 = trimmed.match(/^###\s+(.+)$/);
    if (m3) {
      const heading = m3[1].trim();
      const next = i + 1 < lines.length ? lines[i + 1].trim() : "";
      const nextIsBody = next && !/^#{1,6}\s+/.test(next) && !/^[-*+]\s+/.test(next);

      if (TARGETED_NOISY) {
        if (/^(?:A|T)\s*\d+\.\d+[:\-]/.test(heading)) {
          out.push(`### ${heading}`);
        } else {
          out.push(heading);
        }
        continue;
      }

      if (heading.length > 85 || /[.!?]$/.test(heading)) {
        out.push(heading);
        continue;
      }

      if (heading.length < 42 && nextIsBody && /^[a-zäöüàâçéèêëîïôûùüÿñæœ]/i.test(next)) {
        out.push(`${heading} ${next}`);
        i += 1;
        continue;
      }
    }

    out.push(line);
  }
  return out;
}

function shouldJoinWrappedLine(previous, current) {
  if (!previous || !current) return false;
  if (previous.endsWith("-")) return true;
  if (/[.!?:]$/.test(previous)) return false;
  if (/^[a-zäöüàâçéèêëîïôûùüÿñæœ]/i.test(current) && previous.length <= 140) return true;
  if (previous.length < 55 && current.length < 110 && /^[A-Za-zÄÖÜäöü]/.test(current)) return true;
  return false;
}

function reflowParagraphs(lines) {
  const out = [];
  let paragraph = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    const joined = paragraph.reduce((acc, part) => {
      const chunk = part.trim();
      if (!chunk) return acc;
      if (!acc) return chunk;
      if (acc.endsWith("-") && /^[a-zäöüàâçéèêëîïôûùüÿñæœ]/i.test(chunk)) {
        return acc.slice(0, -1) + chunk;
      }
      return `${acc} ${chunk}`;
    }, "");
    if (joined) out.push(joined);
    paragraph = [];
  }

  const expanded = [];
  for (const line of lines) {
    expanded.push(...splitInlineHeadings(line));
  }

  for (const line of expanded) {
    const text = line.trim();
    if (!text) {
      flushParagraph();
      if (!out.length || out[out.length - 1] !== "") out.push("");
      continue;
    }

    if (isHeading(text) || isBullet(text) || isNumbered(text)) {
      flushParagraph();
      out.push(text);
      continue;
    }

    if (isPdfMetaLine(text)) {
      flushParagraph();
      out.push(text);
      continue;
    }

    if (isLikelyHeaderText(text) && text.length <= 80) {
      flushParagraph();
      out.push(`### ${text}`);
      continue;
    }

    if (paragraph.length) {
      const prev = paragraph[paragraph.length - 1];
      if (shouldJoinWrappedLine(prev, text)) {
        if (prev.endsWith("-") && /^[a-zäöüàâçéèêëîïôûùüÿñæœ]/i.test(text)) {
          paragraph[paragraph.length - 1] = prev.slice(0, -1) + text;
        } else {
          paragraph[paragraph.length - 1] = `${prev} ${text}`;
        }
        continue;
      }

      flushParagraph();
    }

    paragraph.push(text);
  }
  flushParagraph();

  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

function walkMdFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      out.push(...walkMdFiles(full));
      continue;
    }
    if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

function shouldDropLine(line, idx, firstContentLineSeen) {
  const text = line.trim();
  if (!text) return false;

  if (SINGLE_LINE_NOISE.some((re) => re.test(text))) return true;

  if (!firstContentLineSeen && idx < 80 && FILE_HEADER_NOISE.some((re) => re.test(text))) {
    return true;
  }

  return false;
}

function cleanLines(lines) {
  const cleaned = [];
  let stopAtFooter = false;
  let firstContentLineSeen = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\s+$/g, "");
    let text = raw.trim();

    // Trim inline share/recommendation tails that often survive OCR extraction.
    text = text
      .replace(/\s+Weiterlesen\b.*$/i, "")
      .replace(/\s+Teilen!?\s*$/i, "")
      .replace(/\s+iMpuls Newsletter\b.*$/i, "")
      .trim();

    if (FOOTER_START.some((re) => re.test(text))) {
      stopAtFooter = true;
    }
    if (stopAtFooter) break;

    if (shouldDropLine(text, i, firstContentLineSeen)) continue;

    if (text) firstContentLineSeen = true;
    cleaned.push(text);
  }

  const deduped = [];
  for (const line of cleaned) {
    if (deduped.length && deduped[deduped.length - 1] === line && line.trim()) {
      continue;
    }
    deduped.push(line);
  }

  const compact = [];
  for (const line of deduped) {
    if (line.trim() === "") {
      if (!compact.length || compact[compact.length - 1].trim() === "") continue;
    }
    compact.push(line);
  }

  while (compact.length && compact[compact.length - 1].trim() === "") {
    compact.pop();
  }

  return compact;
}

function ensureTitlePrefix(lines, filePath) {
  if (!lines.length) return lines;
  const first = lines[0].trim();
  if (first.startsWith("# ")) return lines;

  const base = path.basename(filePath, ".md");
  const title = base.replace(/[_-]+/g, " ");
  return [`# ${title}`, "", ...lines];
}

function normalizeContent(content, filePath) {
  const unix = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = unix.split("\n");
  const cleaned = cleanLines(lines);
  const withTitle = ensureTitlePrefix(cleaned, filePath);
  const promoted = promoteHeadings(withTitle);
  const withLists = convertListLikeSequences(promoted);
  const reflowed = reflowParagraphs(withLists);
  const normalizedHeadings = normalizeHeadingNoise(reflowed);
  return normalizedHeadings.join("\n") + "\n";
}

function noiseScore(content) {
  const lines = content.split("\n");
  let long = 0;
  let tabs = 0;
  let fig = 0;
  let numericDense = 0;
  let tocDots = 0;

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (line.length > 220) long += 1;
    if (/\t/.test(line)) tabs += 1;
    if (/^(?:A|T)\s*\d+\.\d+[:\-]/.test(t)) fig += 1;
    if (/\.{4,}/.test(t)) tocDots += 1;
    if (/^(?:\d+\s+){8,}\d*$/.test(t)) numericDense += 1;
  }

  return (long * 3) + (tabs * 2) + (fig * 2) + (numericDense * 4) + (tocDots * 3);
}

function aggressiveNoisyCleanup(content) {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out = [];

  for (const line of lines) {
    const t = line.trim();

    if (/^##?\s*Schweizer\s+Sportobservatorium:.*Forschungsbericht\s+\d+\s*$/i.test(t)) continue;
    if (/^##?\s*Seite\s+\d+\s*$/i.test(t)) continue;
    if (/^Inhalts(ü|u)bersicht$/i.test(t)) continue;
    if (/^\d+\.\s+.+\.{4,}\s*\d+\s*$/.test(t)) continue;
    if (/\.{8,}/.test(t)) continue;

    if (/^(?:A|T)\s*\d+\.\d+[:\-]/.test(t)) {
      out.push(`### ${t.replace(/\s+/g, " ")}`);
      continue;
    }

    if (/^(?:\d+\s+){8,}\d*$/.test(t)) continue;
    if ((t.match(/\d/g) || []).length > 40 && (t.match(/[A-Za-zÄÖÜäöü]/g) || []).length < 15) continue;

    out.push(line.replace(/\t+/g, " "));
  }

  return out.join("\n");
}

function main() {
  if (!fs.existsSync(RAG_DIR)) {
    throw new Error(`RAG directory not found: ${RAG_DIR}`);
  }

  const files = walkMdFiles(RAG_DIR);
  let changed = 0;
  let targeted = 0;

  for (const filePath of files) {
    const before = fs.readFileSync(filePath, "utf8");
    if (TARGETED_NOISY) {
      const score = noiseScore(before);
      if (score < NOISY_THRESHOLD) {
        continue;
      }
      targeted += 1;
    }

    const prepped = TARGETED_NOISY ? aggressiveNoisyCleanup(before) : before;
    const after = normalizeContent(prepped, filePath);
    if (before !== after) {
      fs.writeFileSync(filePath, after);
      changed += 1;
    }
  }

  if (TARGETED_NOISY) {
    console.log(`Targeted noisy pass touched ${changed}/${targeted} files (threshold=${NOISY_THRESHOLD}) in ${RAG_DIR}.`);
  } else {
    console.log(`Formatted ${changed}/${files.length} markdown files in ${RAG_DIR}.`);
  }
}

main();
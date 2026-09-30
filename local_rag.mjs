import fs from "node:fs";
import path from "node:path";

function normalize(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokens(text) {
  return normalize(text).split(/\s+/).filter((token) => token.length > 1);
}

function unique(array) {
  return [...new Set(array)];
}

function overlapScore(queryTokens, docTokens) {
  if (!queryTokens.length || !docTokens.length) return 0;
  const docSet = new Set(docTokens);
  let hits = 0;
  for (const token of queryTokens) {
    if (docSet.has(token)) hits += 1;
  }
  return hits / Math.sqrt(queryTokens.length * docSet.size);
}

function urlBasename(url) {
  try {
    const pathname = new URL(url).pathname;
    return path.basename(pathname);
  } catch {
    return path.basename(String(url || ""));
  }
}

function firstContentLine(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines[0] || "";
}

function splitIntoChunks(text, chunkChars = 900, overlapChars = 120) {
  const paragraphs = String(text || "")
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }
    if ((current + "\n\n" + paragraph).length <= chunkChars) {
      current += `\n\n${paragraph}`;
    } else {
      chunks.push(current);
      const tail = current.slice(Math.max(0, current.length - overlapChars)).trim();
      current = tail ? `${tail}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function mapCatalogToRag(ragDocs, catalogDocs) {
  const byId = new Map();
  for (const ragDoc of ragDocs) {
    const ragSignals = unique([
      ...tokens(ragDoc.fileName),
      ...tokens(ragDoc.header),
      ...tokens(ragDoc.preview),
    ]);

    let best = null;
    let bestScore = 0;
    for (const catalogDoc of catalogDocs) {
      const catalogSignals = unique([
        ...tokens(catalogDoc.title),
        ...tokens(urlBasename(catalogDoc.url)),
      ]);
      const score = overlapScore(catalogSignals, ragSignals);
      if (score > bestScore) {
        bestScore = score;
        best = catalogDoc;
      }
    }

    if (best && bestScore >= 0.18) {
      byId.set(best.id, {
        ...ragDoc,
        docId: best.id,
        title: best.title,
        url: best.url,
        tier: best.tier,
        category: best.category,
        organisation: best.organisation,
      });
    }
  }
  return byId;
}

function buildCoverageMap(guardrailsSpec) {
  const map = new Map();
  for (const entry of guardrailsSpec.kb_coverage_by_guardrail?.entries || []) {
    const key = String(entry.guardrail || "");
    const ids = key.split("/").map((part) => part.trim()).filter(Boolean);
    for (const id of ids) {
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(...(entry.related_docs || []));
    }
  }
  for (const [key, ids] of map.entries()) {
    map.set(key, unique(ids));
  }
  return map;
}

function buildSeedTopicHints(groundingSeeds) {
  return groundingSeeds.seeds.map((seed) => ({
    id: seed.id,
    prompt: seed.prompt,
    topic: seed.topic,
    docs: unique([...(seed.better_docs_in_catalog || []), ...(seed.cited_docs || [])]),
  }));
}

function deriveSeedDocHints(seedHints, queryText) {
  const query = tokens(queryText);
  const docs = [];
  for (const seed of seedHints) {
    const score = overlapScore(query, unique([...tokens(seed.prompt), ...tokens(seed.topic)]));
    if (score >= 0.22) docs.push(...seed.docs);
  }
  return unique(docs);
}

const SUPPLEMENTAL_GUARDRAIL_DOCS = {
  G1: ["G-01", "G-04", "N-09", "N-10"],
  G4: ["M-13", "M-14", "D-03"],
  G7: ["N-09", "N-10", "N-11", "G-01"],
  G17: ["F-02", "F-05", "M-06", "M-07"],
};

export function createLocalRag({ ragDir, specDir, snippetCount = 4 }) {
  const catalog = loadJson(path.join(specDir, "kb_source_catalog.json"));
  const guardrailsSpec = loadJson(path.join(specDir, "guardrails_spec.json"));
  const groundingSeeds = loadJson(path.join(specDir, "grounding_seed_prompts.json"));

  const ragDocs = fs.readdirSync(ragDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const filePath = path.join(ragDir, name);
      const content = fs.readFileSync(filePath, "utf8");
      return {
        fileName: name,
        filePath,
        header: firstContentLine(content),
        preview: content.slice(0, 1200),
        content,
      };
    });

  const catalogToRag = mapCatalogToRag(ragDocs, catalog.documents || []);
  const coverageMap = buildCoverageMap(guardrailsSpec);
  const seedHints = buildSeedTopicHints(groundingSeeds);

  const fallbackDocs = ragDocs
    .filter((doc) => ![...catalogToRag.values()].some((mapped) => mapped.filePath === doc.filePath))
    .map((doc) => ({
      ...doc,
      docId: null,
      title: doc.header.replace(/^#\s*/, "") || doc.fileName,
      url: null,
      tier: 8,
      category: "unknown",
      organisation: null,
    }));

  const allDocs = [...catalogToRag.values(), ...fallbackDocs];

  const chunks = [];
  for (const doc of allDocs) {
    const docChunks = splitIntoChunks(doc.content);
    docChunks.forEach((chunk, index) => {
      chunks.push({
        docId: doc.docId,
        title: doc.title,
        url: doc.url,
        tier: doc.tier ?? 8,
        category: doc.category,
        organisation: doc.organisation,
        fileName: doc.fileName,
        filePath: doc.filePath,
        chunkIndex: index,
        text: chunk,
        tokens: unique(tokens(chunk)),
      });
    });
  }

  function retrieve({ guardrail, lang, queryText }) {
    const coverageDocs = coverageMap.get(guardrail.id) || [];
    const seedDocs = deriveSeedDocHints(seedHints, queryText);
    const supplementalDocs = SUPPLEMENTAL_GUARDRAIL_DOCS[guardrail.id] || [];
    const preferredDocIds = new Set(unique([...coverageDocs, ...seedDocs, ...supplementalDocs]));
    const queryTokens = unique(tokens(`${queryText} ${guardrail.name} ${guardrail.hard_when_text || ""}`));

    const scored = chunks.map((chunk) => {
      const lexical = overlapScore(queryTokens, chunk.tokens);
      const tierBoost = Math.max(0, 5 - (chunk.tier || 8)) * 0.04;
      const preferredBoost = chunk.docId && preferredDocIds.has(chunk.docId) ? 0.18 : 0;
      const supplementalBoost = chunk.docId && supplementalDocs.includes(chunk.docId) ? 0.14 : 0;
      const categoryBoost = /nutrition|obesity|diabetes|movement|sleep|stress/i.test(chunk.category || "") ? 0.02 : 0;
      return {
        ...chunk,
        score: lexical + tierBoost + preferredBoost + supplementalBoost + categoryBoost,
      };
    })
      .filter((chunk) => chunk.score > 0.03)
      .sort((a, b) => b.score - a.score);

    const selected = [];
    const seenDocChunk = new Set();
    for (const chunk of scored) {
      const key = `${chunk.fileName}:${chunk.chunkIndex}`;
      if (seenDocChunk.has(key)) continue;
      selected.push(chunk);
      seenDocChunk.add(key);
      if (selected.length >= snippetCount) break;
    }

    return {
      query: queryText,
      lang,
      preferredDocIds: [...preferredDocIds],
      snippets: selected.map((chunk) => ({
        doc_id: chunk.docId,
        title: chunk.title,
        source_url: chunk.url,
        tier: chunk.tier,
        file_name: chunk.fileName,
        chunk_index: chunk.chunkIndex,
        excerpt: chunk.text.slice(0, 700).trim(),
        score: Number(chunk.score.toFixed(4)),
      })),
    };
  }

  return { retrieve };
}

import { getPool } from '../config/db.js';
import 'dotenv/config';
import TextPolish from './textPolish.js';

// Reuse common utilities from TextPolish
const { polish, f32ToBuf, bufToF32, cosine, firstH1 } = TextPolish;

export async function embed(text) {
    const useOllamaFlag = /^(true|1)$/i.test((process.env.USE_OLLAMA_EMBED || "true").split("#")[0].trim());
    const provider = useOllamaFlag ? 'ollama' : ((process.env.AI_PROVIDER || 'gemini').split("#")[0].trim());

    const ollamaUrl = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
    const ollamaModel = process.env.OLLAMA_EMBED_MODEL || 'bge-m3:latest';

    if (provider === 'gemini') {
        const apiKey = process.env.GEMINI_API_KEY;
        const model = "text-embedding-004";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;

        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                content: { parts: [{ text }] }
            })
        });

        if (!res.ok) throw new Error(`Gemini embed failed: ${res.status}`);
        const data = await res.json();
        const vec = data.embedding?.values;
        if (!vec) throw new Error("Gemini returned no embedding values");
        return Float32Array.from(vec);
    } else {
        const res = await fetch(`${ollamaUrl}/api/embeddings`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: ollamaModel, prompt: text }),
        });
        if (!res.ok) throw new Error(`Ollama embed failed: ${res.status}`);
        const data = await res.json();
        return Float32Array.from(data.embedding);
    }
}


export function chunkMarkdown(md, target = 900, overlap = 120) {
    const STYLE_POLISH_LOCAL = /^(true|1)$/i.test(process.env.STYLE_POLISH_LOCAL || "true");
    // Clean up text: fix broken lines, add missing spaces after punctuation, and remove double spaces.
    if (STYLE_POLISH_LOCAL) md = polish(md);

    // Split by double newline first, split by paragraph
    let rawParas = (md || "").split(/\n{2,}/);
    let paras = [];

    // If a single paragraph is still too big, split it by sentence (. or \n)
    for (const r of rawParas) {
        if (r.length <= target) {
            paras.push(r);
        } else {
            const sentences = r.match(/[^.!?\n]+[.!?\n]+/g) || [r];
            let temp = "";
            for (const s of sentences) {
                if ((temp + s).length > target && temp.length > 0) {
                    paras.push(temp.trim());
                    temp = s;
                } else {
                    temp += s;
                }
            }
            if (temp.trim()) paras.push(temp.trim());
        }
    }

    const out = [];
    let cur = "";

    for (const p of paras) {
        if ((cur + "\n\n" + p).length > target && cur.length > 0) {
            out.push(cur.trim());
            cur = p;
        } else {
            cur = cur ? cur + "\n\n" + p : p;
        }
    }
    if (cur.trim()) out.push(cur.trim());

    const withOverlap = [];
    for (let i = 0; i < out.length; i++) {
        const prevTail = i > 0 ? out[i - 1].slice(-overlap) : "";
        withOverlap.push((prevTail ? prevTail + "\n\n" : "") + out[i]);
    }
    return withOverlap;
}

export async function ingestMarkdown({
    tenant_id,
    title,
    markdown,
    lang = null,
    source_url = null,
    chunk_target,
    chunk_overlap,
}) {
    const safeMd = String(markdown || "").trim();
    if (!safeMd) throw new Error("markdown required");

    const safeTitle = (
        String(title || "").trim() ||
        firstH1(safeMd) ||
        `Markdown ${Date.now()}`
    ).slice(0, 255);

    const target = chunk_target || parseInt(process.env.chunk_target, 10) || 900;
    const overlap = chunk_overlap !== undefined ? chunk_overlap : parseInt(process.env.chunk_overlap, 10) || 120;

    const chunks = chunkMarkdown(safeMd, target, overlap);
    if (!chunks.length) throw new Error("no chunks generated");

    // 1) prepare embeddings first
    const preparedRows = [];
    for (const chunk of chunks) {
        const content = `Doc: ${safeTitle}\n\n${chunk}`;
        const emb = await embed(content);

        preparedRows.push({
            content,
            embedding: f32ToBuf(emb),
        });
    }

    // 2) save document + chunks in transaction
    const pool = await getPool();
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const [docResult] = await conn.query(
            `INSERT INTO documents (tenant_id, title, lang, source_url)
       VALUES (?,?,?,?)`,
            [tenant_id || 1, safeTitle, lang, source_url]
        );

        const docId = docResult.insertId;

        for (const row of preparedRows) {
            await conn.query(
                `INSERT INTO chunks (tenant_id, doc_id, content, embedding)
         VALUES (?,?,?,?)`,
                [tenant_id || 1, docId, row.content, row.embedding]
            );
        }

        await conn.commit();

        return {
            ok: true,
            doc_id: docId,
            title: safeTitle,
            chunks: chunks.length,
        };
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
}

/**
 * Ingests all markdown files from a directory.
 * Matches sample.js.
 */
export async function ingestFromDir(dir, tenant_id = 1) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const abs = path.resolve(dir);
    const files = fs.readdirSync(abs).filter((f) => f.toLowerCase().endsWith(".md"));
    const done = [];

    for (const f of files) {
        const p = path.join(abs, f);
        const raw = fs.readFileSync(p, "utf8");
        const title = firstH1(raw) || path.basename(f, path.extname(f)).replace(/_/g, " ").trim();

        const out = await ingestMarkdown({
            tenant_id,
            title,
            markdown: raw
        });

        done.push({ file: f, doc_id: out.doc_id });
    }

    return { ok: true, files: done, count: done.length };
}

/**
 * Ingests a single FAQ (Question/Answer pair).
 * Matches sample.js.
 */
export async function ingestFaq({ tenant_id, question, answer, lang = null }) {
    const safeQ = (question || "").trim();
    const safeA = (answer || "").trim();
    if (!safeQ || !safeA) throw new Error("question and answer required");

    const title = `FAQ: ${safeQ}`.slice(0, 255);
    const md = `# ${title}\n\n## Q\n${safeQ}\n\n## A\n${safeA}\n`;

    return await ingestMarkdown({
        tenant_id,
        title,
        markdown: md,
        lang
    });
}

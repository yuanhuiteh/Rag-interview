import crypto from "node:crypto";
import { q } from "../config/db.js";

class TextPolish {
    // --------------------------------------------------------
    // UI & GENERAL FORMATTING
    // --------------------------------------------------------

    static formatMoney(cents, currency = "MYR") {
        return `${currency} ${(cents / 100).toFixed(2)}`;
    }

    static buildMenuText(options, lineFn) {
        return options.map((opt, i) => `${i + 1}. ${lineFn(opt)}`).join("\n");
    }

    static safeJsonParse(s, fallback) {
        if (!s) return fallback;
        if (typeof s === "object") return s;
        try {
            return JSON.parse(s);
        } catch (e) {
            console.error("[JSON_PARSE_ERR]", String(e));
            return fallback;
        }
    }

    // --------------------------------------------------------
    // RAG & DATABASE OPERATIONS (VECTORS)
    // --------------------------------------------------------

    static bufToF32(buf) {
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        if (b.length % 4 !== 0) {
            throw new Error(`Invalid embedding bytes: ${b.length} (not divisible by 4). Re-ingest KB recommended.`);
        }
        const ab = new ArrayBuffer(b.length);
        new Uint8Array(ab).set(b);
        return new Float32Array(ab);
    }

    static f32ToBuf(f32) {
        return Buffer.from(new Uint8Array(f32.buffer));
    }

    static cosine(a, b) {
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) {
            const x = a[i], y = b[i];
            dot += x * y; na += x * x; nb += y * y;
        }
        return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
    }

    static hashText(x) {
        return crypto.createHash("sha256").update(x).digest("hex");
    }

    static firstH1(md) {
        const m = (md || "").match(/^#\s+(.+?)\s*$/m);
        return m ? m[1].trim() : null;
    }

    static polish(text) {
        return (text || "")
            .replace(/([a-zA-Z1-9,'"()])\n([a-zA-Z(])/g, "$1 $2")
            .replace(/([.!?,;])(?=\S)/g, "$1 ")
            .replace(/ {2,}/g, " ")
            .trim();
    }

    // --------------------------------------------------------
    // INCOMING USER TEXT & CHAT PROCESSING
    // --------------------------------------------------------

    static preprocessSlang(qText) {
        const slangDict = {
            // --- Malay particles ---
            lah: "", leh: "", meh: "", mah: "",
            // --- Hokkien/Cantonese particles ---
            lor: "", hor: "", sia: "", wor: "", geh: "",
            // --- English slang ---
            alr: "already", duno: "do not know", dunno: "do not know",
            wan: "want", kena: "affected by", idk: "I do not know",
            pls: "please", thx: "thanks", tq: "thank you",
            mc: "medical leave", wf: "work from home",
            // --- Malay SMS abbreviations ---
            nk: "nak", blh: "boleh", byr: "bayar", mcm: "macam",
            cmne: "macam mana", brp: "berapa",
            // --- Hokkien/Cantonese meaning words ---
            paiseh: "sorry", jialat: "serious problem",
            tapau: "takeaway", dabao: "takeaway",
            cincai: "anything", shiok: "great",
            // --- Manglish contractions ---
            ady: "already", dy: "already", oni: "only",
            oso: "also", summore: "some more", lidat: "like that",
        };
        return Object.entries(slangDict).reduce(
            (acc, [slang, formal]) => acc.replace(new RegExp(`\\b${slang}\\b`, "gi"), formal),
            qText
        );
    }

    static norm(s) {
        return (s || "").trim().toLowerCase();
    }

    static normalizeQuery(x) {
        return (x || "").toLowerCase().trim();
    }

    static normalizeQuestionForInbox(text) {
        return (text || "")
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]+/gu, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    static stripThinkingText(text) {
        if (!text) return text;
        text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
        // Remove reasoning preamble lines
        const lines = text.split("\n");
        const reasoningLine = /^\s*([-•*]\s+)?(okay[,!.]?\s|alright[,!.]?\s|sure[,!.]?\s|let me\s|let's\s|let's\s|first[,!.]?\s|so[,!.]?\s|now[,!.]?\s|首先|好的|我来|我需要|根据|让我|i need to|i will|i'll|the user|step \d|note:|however|to (translate|answer|respond|handle|tackle|complete)|the (message|text|request|translation|task|original)|here('s| is) (the|my)|reading|looking at|breaking|analyzing|start\s|introduce\s|translating)/i;
        const firstSig = lines.find(l => l.trim().length > 0);
        if (!firstSig || !reasoningLine.test(firstSig.trim())) return text.trim();
        const answerLines = [];
        let found = false;
        for (const line of lines) {
            const t = line.trim();
            if (!t) { if (found) answerLines.push(""); continue; }
            if (!found && reasoningLine.test(t)) continue;
            found = true;
            answerLines.push(line);
        }
        return answerLines.join("\n").trim() || text.trim();
    }
}

export default TextPolish;

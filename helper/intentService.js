import { readFileSync } from "fs";
import { getSmalltalkTemplates, getBotCapabilityTemplates } from "../llm/prompts.js";
import { BOT_NAME } from "../config/env.js";

// ── Do-Not-Translate Glossary (editable via data/glossary.json) ──
const glossary = JSON.parse(readFileSync(new URL("../data/glossary.json", import.meta.url), "utf-8"));
const glossaryRegex = new RegExp(
    glossary.do_not_translate
        .sort((a, b) => b.length - a.length) // longest first
        .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|"),
    "gi"
);

function stripGlossary(text) {
    return text.replace(glossaryRegex, " ").replace(/\d+/g, " ").replace(/\s+/g, " ").trim();
}

export function detectLangHeuristic(text, options = {}) {
    const allowLatinFallback = options.allowLatinFallback !== false;

    // Single punctuation / whitespace only → default English
    const stripped = text.replace(/[\s\p{P}\p{S}]/gu, "");
    if (stripped.length === 0) return "en";

    // Strip glossary terms + numbers before counting
    // "我要80gsm" → "我要" → ratio = 1.0 → Chinese
    const cleaned = stripGlossary(text);

    const zhChars = (cleaned.match(/[\u3400-\u9FBF]/g) || []).length;
    const latChars = (cleaned.match(/[a-zA-Z]/g) || []).length;
    const total = zhChars + latChars;
    const zhRatio = total > 0 ? zhChars / total : 0;

    if (zhChars >= 3) return "zh";
    if (zhChars >= 1 && zhRatio > 0.4) return "zh";

    const t = text.toLowerCase().trim();
    //if (/\b(lah?|leh|meh|mah|lor|hor|sia|wor|geh)\b/.test(t)) return "ms";

    const hasMalay = /\b(apa|bila|waktu|masa|tempoh|penghantaran|dihantar|hantaran|sampai|nak|tak|boleh|berapa|harga|bayar|akaun|macam|mana|saya|awak|selamat|pagi|petang|malam|brapa|byr|blh|nk|stok|jenama|servis|tolong|mau|ada|beli|jual|barang|bagus|murah|mahal|tambah|tolak|tukar|hantar|buang|tengok|cari|sudah|belum|lagi|sikit|banyak|semua|tapau|dabao|paiseh|cincai|yang|tu|bagi|kurang|ni|dah|je)\b/.test(t);
    if (hasMalay) return "ms";

    if (allowLatinFallback && /^[a-z0-9\s\!\?\.\,\'\"\/\(\)\-]+$/.test(t)) return "en";

    return null;
}

export function intentPresignals(text) {
    const t = text.toLowerCase();
    const signals = [];
    if (/how much|price|harga|berapa|brapa|多少钱|几多钱|报价|多少|价格|收费|\badd\b|\bremove\b|\bbuy\b|\bnak\b|nk bli|nak order|加|减|买|拿|去掉|删|换|tolak|tambah|beli|buang|hapus|kurang|\bwant to (buy|get|order)\b|\bneed to (buy|order)\b|想买|要买|我想买|我要买/i.test(t)) signals.push("pricing");
    if (/\bbank\b|akaun|transfer|\bbayar\b|\bbyr\b|\bpay\b(?!ment\s+plan)|receipt|resit|付款|转账|怎么给|汇款|银行|账号/i.test(t))
        signals.push("payment");
    if (/^(hi+|he+y+|hello+|hai|helo|yo+|morning|good\s*(morning|afternoon|evening|night))\b/i.test(t.trim()) ||
        /^(你好|您好|早安|晚安|午安|早)/i.test(t.trim()) ||
        /^(apa khabar|selamat\s*(pagi|petang|malam))/i.test(t.trim()))
        signals.push("smalltalk");
    if (/what can you do|你能做什么|bot capabilities|what are your features/i.test(t.trim()))
        signals.push("bot_capability");
    if (/\b(what|which)\b.{0,15}\b(product|item|thing)s?\b.*\b(sell|have|carry|offer|got|available|selling)\b|\b(sell|selling|jual)\b.{0,10}\b(what|apa)\b|\bproduct\s*(list|catalog|catalogue)\b|\bshow\s*(me\s+)?(your\s+)?(all\s+)?products\b|卖什么|有什么(产品|商品|东西|product|item)|什么product|什么item|产品(目录|列表)|你们(有|卖)(些?)什么|有什么.{0,3}(sell|卖|jual)|jual apa|produk apa|senarai produk/i.test(t))
        signals.push("catalog");
    if (/speak to (a |an )?(real |actual )?(human|person|agent|staff|someone)|talk to (a |an )?(real |actual )?(human|person|agent|staff|someone)|contact (your |the )?(team|staff|agent|support)|arrange (a )?demo|book (a )?demo|get (a )?callback|nak jumpa|nak cakap dengan|hubungi (team|staf)|我想联系|联系真人|真人服务|安排见面|安排demo/i.test(t))
        signals.push("handoff");

    return signals;
}

export async function generateSmalltalk(userText, lang) {
    return await getSmalltalkTemplates(lang);
}

function ensureBotName(text, lang) {
    if (new RegExp(BOT_NAME, "i").test(text)) return text;
    if (lang === "zh") return `${text} 我是 ${BOT_NAME}。`;
    if (lang === "ms") return `${text} Saya ialah ${BOT_NAME}.`;
    return `${text} I am ${BOT_NAME}.`;
}

export function generateBotCapability(lang) {
    return getBotCapabilityTemplates(lang);
}

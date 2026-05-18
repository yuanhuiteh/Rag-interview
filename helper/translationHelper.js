import aiHelper from "./aiHelper.js";

/**
 * Masks sensitive terms (product names, SKUs, etc.) in a string using __SECRET_ITEM_N__ tokens.
 */
export function maskSensitiveData(originalText, candidates) {
    if (!originalText || !candidates || candidates.length === 0) {
        return { maskedText: originalText, tokenMap: {} };
    }

    // Sort by length descending to match full names before partial words
    const sorted = [...new Set(candidates)]
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);

    const tokenMap = {};
    let maskedText = originalText;

    sorted.forEach((term, index) => {
        const token = `__SECRET_ITEM_${index}__`;
        tokenMap[token] = term;

        // Escape regex special characters
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'gi');

        maskedText = maskedText.replace(regex, token);
    });

    return { maskedText, tokenMap };
}

/**
 * Restores original terms from __SECRET_ITEM_N__ tokens.
 */
export function unmaskSensitiveData(text, tokenMap) {
    if (!text || !tokenMap) return text;

    let unmasked = text;
    for (const [token, originalValue] of Object.entries(tokenMap)) {
        const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escapedToken, 'g');
        unmasked = unmasked.replace(regex, originalValue);
    }
    return unmasked;
}

/**
 * Translates a response while preserving masked items.
 */
export async function translateResponse(text, targetLang, sensitiveTerms = []) {
    // 1. Skip if already English
    if (targetLang === "en" || !text) return text;

    const langMap = { "zh": "Simplified Chinese", "ms": "Malay (Bahasa Melayu)" };
    const langName = langMap[targetLang] || "English";

    // 2. MASKING
    const { maskedText, tokenMap } = maskSensitiveData(text, sensitiveTerms);
    
    // Check if there's actually anything to translate (mostly for non-Latin chars)
    // If text is just tokens, skip LLM
    if (!/[a-zA-Z]/.test(maskedText.replace(/__SECRET_ITEM_\d+__/g, ""))) {
         return unmaskSensitiveData(maskedText, tokenMap);
    }

    const system = `You are a Professional Translator. 
1. TARGET: ${langName}
2. INPUT: Contains secret placeholders like "__SECRET_ITEM_0__".
3. RULE: DO NOT TRANSLATE OR CHANGE THE PLACEHOLDERS. Keep them exactly as is.
4. Translate the surrounding text naturally and fluently.
5. Return JSON: {"translated": "..."}`;

    const user = `Text to translate:\n"${maskedText}"`;
    const schemaHint = `{"translated": "..."}`;

    try {
        const out = await aiHelper.aiJson({ system, user, schemaHint });
        const translated = out.translated || maskedText;

        // 3. UNMASKING
        return unmaskSensitiveData(translated, tokenMap);
    } catch (e) {
        console.error("[TRANSLATION_HELPER] Translation failed:", e);
        return text; // Fallback to original
    }
}

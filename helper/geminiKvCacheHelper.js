import 'dotenv/config';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Note: Context caching typically requires specific models like gemini-1.5-pro-001 or gemini-1.5-flash-001
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash-001";

class GeminiKvCacheHelper {

    static async getOrCreateCachedContent({ displayName, systemInstruction, contents, ttlSeconds = 3600 }) {
        if (!GEMINI_API_KEY) {
            throw new Error("GEMINI_API_KEY is missing in .env");
        }

        try {
            // 1. Try to find existing cache by listing cached contents
            // The Gemini API does not allow querying directly by displayName, so we list and filter.
            const listUrl = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${GEMINI_API_KEY}`;
            const listRes = await fetch(listUrl);

            if (listRes.ok) {
                const listData = await listRes.json();
                if (listData.cachedContents && Array.isArray(listData.cachedContents)) {
                    const existingCache = listData.cachedContents.find(c => c.displayName === displayName);
                    if (existingCache) {
                        console.log(`[GeminiKvCacheHelper] Found existing cache for: ${displayName}`);
                        return existingCache;
                    }
                }
            } else {
                console.warn(`[GeminiKvCacheHelper] Failed to list caches: ${listRes.statusText}`);
            }

            // 2. If not found, create a new cached content
            console.log(`[GeminiKvCacheHelper] Creating new cache for: ${displayName}`);
            const createUrl = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${GEMINI_API_KEY}`;

            const body = {
                // The model name needs a 'models/' prefix for the caching API
                model: GEMINI_MODEL.startsWith('models/') ? GEMINI_MODEL : `models/${GEMINI_MODEL}`,
                displayName: displayName,
                contents: contents || [],
                ttl: `${ttlSeconds}s`
            };

            if (systemInstruction) {
                body.systemInstruction = {
                    parts: [{ text: systemInstruction }]
                };
            }

            const createRes = await fetch(createUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!createRes.ok) {
                const errorText = await createRes.text();
                throw new Error(`Failed to create cache: ${createRes.status} ${errorText}`);
            }

            const newCache = await createRes.json();
            console.log(`[GeminiKvCacheHelper] Cache created successfully: ${newCache.name}`);
            return newCache;

        } catch (error) {
            console.error("[GeminiKvCacheHelper] Error in getOrCreateCachedContent:", error);
            throw error;
        }
    }
}

export default GeminiKvCacheHelper;

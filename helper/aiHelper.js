import 'dotenv/config';

const OLLAMA_HOST = process.env.OLLAMA_URL;
const OLLAMA_MODEL = process.env.OLLAMA_CHAT_MODEL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const AI_PROVIDER = process.env.AI_PROVIDER ? process.env.AI_PROVIDER.toLowerCase() : undefined;

function safeJsonParse(s, fallback) {
    if (!s) return fallback;
    if (typeof s === "object") return s;
    try { return JSON.parse(s); } catch { return fallback; }
}

function getGeminiText(data) {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) return "";

    return parts
        .map((part) => typeof part?.text === "string" ? part.text : "")
        .join("")
        .trim();
}

/**
 * Basic text generation helper designed for conversational responses.
 */
class aiHelper {
    static async generateAiResponse(prompt, options = {}) {
        if (AI_PROVIDER === 'gemini') {
            if (!GEMINI_API_KEY) {
                console.error("[Gemini] Error: GEMINI_API_KEY is missing in .env");
                return "AI provider is set to Gemini, but no API key was found.";
            }
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
                const body = {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: options.temperature ?? 0.5,
                        topP: options.top_p ?? 0.9,
                        topK: options.top_k ?? 40,
                        maxOutputTokens: 2048,
                    }
                };
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });

                if (!res.ok) {
                    console.error(`[Gemini] Error: ${res.statusText}`);
                    return "Sorry, I'm having a little trouble thinking right now. Please try again later.";
                }
                const data = await res.json();
                return getGeminiText(data) || "I couldn't process that.";
            } catch (error) {
                console.error(`[Gemini] Connection Failed:`, error.message);
                return "I seem to be offline. Make sure you have internet access.";
            }

        } else if (AI_PROVIDER === 'ollama') {
            try {
                const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: OLLAMA_MODEL,
                        prompt: prompt,
                        stream: false,
                        options: {
                            temperature: options.temperature ?? 0.5,
                            top_p: options.top_p ?? 0.9,
                            top_k: options.top_k ?? 40,
                            ...options
                        }
                    })
                });

                if (!res.ok) {
                    console.error(`[Ollama] Error: ${res.statusText}`);
                    return "Sorry, I'm having a little trouble thinking right now. Please try again later.";
                }

                const data = await res.json();
                return data.response.trim();
            } catch (error) {
                console.error(`[Ollama] Connection Failed:`, error.message);
                return "I seem to be offline. Make sure Ollama is running locally at " + OLLAMA_HOST;
            }
        } else if (AI_PROVIDER === 'openai') {
            if (!OPENAI_API_KEY) {
                console.error("[OpenAI] Error: OPENAI_API_KEY is missing in .env");
                return "AI provider is set to OpenAI, but no API key was found.";
            }
            try {
                const url = `${OPENAI_BASE_URL}/chat/completions`;
                const body = {
                    model: OPENAI_MODEL,
                    messages: [{ role: "user", content: prompt }],
                    temperature: options.temperature ?? 0.5,
                    top_p: options.top_p ?? 0.9,
                    max_tokens: 2048,
                };

                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${OPENAI_API_KEY}`
                    },
                    body: JSON.stringify(body)
                });

                if (!res.ok) {
                    const errText = await res.text().catch(() => "");
                    console.error(`[OpenAI] Error: ${res.statusText} ${errText}`);
                    return "Sorry, I'm having a little trouble thinking right now. Please try again later.";
                }
                const data = await res.json();
                return data.choices?.[0]?.message?.content?.trim() || "I couldn't process that.";
            } catch (error) {
                console.error(`[OpenAI] Connection Failed:`, error.message);
                return "I seem to be offline. Make sure you have internet access.";
            }
        } else {
            console.error(`[AI] Error: Unknown AI_PROVIDER '${AI_PROVIDER}'. Must be 'gemini', 'ollama', or 'openai'.`);
            return "Configuration error: Unknown AI Provider.";
        }
    }

    /**
     * Strict JSON extraction engine, perfect for Intent Classification or Router logic.
     * Supports both Gemini 2.5 Flash and local Ollama.
     */
    static async aiJson({ system, user, schemaHint, options = {} }) {
        if (AI_PROVIDER === 'gemini') {
            if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is missing in .env");
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
            const promptText = (schemaHint ? `${user}\n\nSchema:\n${schemaHint}` : user);
            const body = {
                contents: [{ parts: [{ text: promptText }] }],
                generationConfig: {
                    temperature: options.temperature ?? 0.2,
                    topP: options.top_p ?? 0.85,
                    topK: options.top_k ?? 15,
                    responseMimeType: "application/json",
                    maxOutputTokens: 2048,
                }
            };

            if (system) {
                body.systemInstruction = { parts: [{ text: system }] };
            }

            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(300000),
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => "");
                throw new Error(`Gemini API failed: ${response.status} ${errorText}`);
            }

            const data = await response.json();
            const rawContent = getGeminiText(data);
            const parsed = safeJsonParse(rawContent, null);
            if (parsed) return parsed;

            const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const extractedJson = safeJsonParse(jsonMatch[0], null);
                if (extractedJson) return extractedJson;
            }
            throw new Error(`Gemini did not return valid JSON: ${rawContent.slice(0, 200)}`);

        } else if (AI_PROVIDER === 'ollama') {
            const messages = [];
            if (system) {
                messages.push({ role: "system", content: system });
            }
            messages.push({ role: "user", content: schemaHint ? `${user}\n\nSchema:\n${schemaHint}` : user });

            const body = {
                model: OLLAMA_MODEL,
                stream: false,
                format: "json",
                options: {
                    temperature: 0.2,
                    top_p: 0.85,
                    top_k: 15,
                    seed: 42,
                    ...options
                },
                messages,
            };

            const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(300000),
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => "");
                throw new Error(`Ollama chat failed: ${response.status} ${errorText}`);
            }

            const data = await response.json();
            const rawContent = data?.message?.content || "";
            const parsed = safeJsonParse(rawContent, null);
            if (parsed) return parsed;

            const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const extractedJson = safeJsonParse(jsonMatch[0], null);
                if (extractedJson) return extractedJson;
            }
            throw new Error(`Ollama did not return valid JSON: ${rawContent.slice(0, 200)}`);

        } else if (AI_PROVIDER === 'openai') {
            if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing in .env");
            const url = `${OPENAI_BASE_URL}/chat/completions`;
            const messages = [];

            if (system) {
                messages.push({ role: "system", content: system });
            }
            const fullText = `${system || ""} ${user} ${schemaHint || ""}`.toLowerCase();
            const jsonReq = fullText.includes("json") ? "" : "\n\nCRITICAL: You MUST return a valid JSON object.";
            let userContent = user;
            if (schemaHint) userContent += `\n\nSchema:\n${schemaHint}`;
            userContent += jsonReq;

            messages.push({ role: "user", content: userContent });

            const body = {
                model: OPENAI_MODEL,
                messages,
                temperature: options.temperature ?? 0.2,
                top_p: options.top_p ?? 0.85,
                max_tokens: 2048,
                response_format: { type: "json_object" }
            };

            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${OPENAI_API_KEY}`
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(300000),
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => "");
                throw new Error(`OpenAI API failed: ${response.status} ${errorText}`);
            }

            const data = await response.json();
            const rawContent = data.choices?.[0]?.message?.content || "";
            const parsed = safeJsonParse(rawContent, null);
            if (parsed) return parsed;

            const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const extractedJson = safeJsonParse(jsonMatch[0], null);
                if (extractedJson) return extractedJson;
            }
            throw new Error(`OpenAI did not return valid JSON: ${rawContent.slice(0, 200)}`);

        } else {
            throw new Error(`Unknown AI_PROVIDER '${AI_PROVIDER}'. Must be 'gemini', 'ollama', or 'openai'.`);
        }
    }
}

export default aiHelper;

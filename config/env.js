import 'dotenv/config';

export const BOT_NAME = process.env.BOT_NAME || 'iBot';
export const PORT = process.env.PORT || 4000;
export const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
export const OLLAMA_CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || 'qwen2.5:7b-instruct';
export const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'bge-m3';

export const DB_HOST = process.env.DB_HOST || '127.0.0.1';
export const DB_USER = process.env.DB_USER || 'root';
export const DB_PASS = process.env.DB_PASS || '';
export const DB_NAME = process.env.DB_NAME || 'workflow-Ai';
export const ENABLE_WORKFLOW = process.env.ENABLE_WORKFLOW === 'true';

import express from "express";
import 'dotenv/config';

const PORT = process.env.PORT || 4000;
const OLLAMA_CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || 'qwen3:4b';
const BOT_NAME = process.env.BOT_NAME || 'iBot';
const REQUIRE_CLIENT_KEY = process.env.REQUIRE_CLIENT_KEY === 'true';
import { ensureSchema, q } from "./config/db.js";
import botRoutes from "./bot.js";

const app = express();
app.use(express.json());

// Main Chat Route
app.use("/", botRoutes);

// Placeholder for admin/client routes (pricebook, history, etc.)
// These can be modularized into src/routes/adminRoutes.js in the future.
app.get("/health", (req, res) => res.json({ ok: true, status: "ok", bot: BOT_NAME, model: OLLAMA_CHAT_MODEL }));

// Boot
process.on("unhandledRejection", (err) => console.error("UnhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("UncaughtException:", err));

async function ensureDefaultTenant() {
    const rows = await q(`SELECT * FROM tenants WHERE id=1 LIMIT 1`);
    if (!rows.length) {
        await q(`INSERT INTO tenants (id, tenant_key, name) VALUES (1, 'default', 'Default Tenant')`);
        console.log("[DB] Created default tenant ID 1");
    }
}

(async () => {
    try {
        await ensureSchema();
        await ensureDefaultTenant();

        app.listen(PORT, () => {
            console.log(`[ AI] up on :${PORT} | Model: ${OLLAMA_CHAT_MODEL} | Bot: ${BOT_NAME}`);
            console.log(`[Security] REQUIRE_CLIENT_KEY=${REQUIRE_CLIENT_KEY ? "true" : "false"}`);
            console.log(`[Status] Modular architecture fully loaded.`);
        });
    } catch (err) {
        console.error("[Boot Error]", err);
        process.exit(1);
    }
})();

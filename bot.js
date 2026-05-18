import express from 'express';
import { runGeneralGraph } from './generalGraph.js';
import ConversationHelper from './helper/conversationHelper.js';
import ChannelAdapter from './helper/channelAdapter.js';
import { ingestMarkdown } from './helper/chunking.js';
import aiHelper from './helper/aiHelper.js';
import { runRagWorkflow } from './nodes/workflowRag2.js';
import fs from 'fs';
import path from 'path';

const router = express.Router();

function buildChatResponse(graphResponsePayload, translatedPayload) {
    const { content, ...responsePayload } = translatedPayload || {};
    const responseBody = {
        answer: content || graphResponsePayload?.text || "",
        status: "success",
        lang: graphResponsePayload?.lang || "en",
        memory_type: graphResponsePayload?.memory_type || "none",
        response: responsePayload
    };

    if (graphResponsePayload?.rag_debug) {
        responseBody.rag_debug = graphResponsePayload.rag_debug;
    }

    return responseBody;
}

router.post("/chatwoot", async (req, res) => {
    return res.status(410).json({
        status: "disabled",
        error: "Chatwoot integration has been removed from this server."
    });
});

router.post("/chat", async (req, res) => {
    try {
        const { query, user_key } = req.body;

        // Ensure query and user_key are provided
        if (!query || !user_key) {
            return res.status(400).json({ error: "Missing 'query' or 'user_key' in request body" });
        }

        console.log(`🎨🎨🎨🎨🎨🎨🎨🎨[API /chat] Received request from ${user_key}: "${query}"`);

        // 1. Get or create the conversation record
        const dbConversation = await ConversationHelper.getOrCreateConversation({
            tenant_id: req.body?.tenant_id || 4, // Changed default from 1 to 4
            user_key: user_key,
            channel: "api"
        });

        // 2. Process directly via General Graph
        const graphResponsePayload = await runGeneralGraph(query, {
            tenantId: dbConversation.tenant_id,
            conversationId: dbConversation.id,
            userKey: dbConversation.user_key
        });

        // 3. Translate strictly for the API response format (using WhatsApp as baseline for tests)
        const translatedPayload = ChannelAdapter.translate(graphResponsePayload, "whatsapp");

        // Return the formatted response immediately to Postman/Client
        return res.json(buildChatResponse(graphResponsePayload, translatedPayload));

    } catch (err) {
        console.error("[API /chat] Error:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

router.post("/client/markdown", async (req, res) => {
    try {
        const tenant_id = req.body?.tenant_id || 1;
        let markdown = String(req.body?.markdown || "");
        const filename = String(req.body?.filename || "").trim();
        let title = String(req.body?.title || "").trim();
        const lang = String(req.body?.lang || "").trim() || null;
        const source_url = String(req.body?.source_url || "").trim() || null;

        // If filename is provided, read it from /markdown OR /data folder
        if (filename && !markdown) {
            let safePath = path.join(process.cwd(), "markdown", filename);
            
            // If not in markdown, check data/
            if (!fs.existsSync(safePath)) {
                safePath = path.join(process.cwd(), "data", filename);
            }

            if (!fs.existsSync(safePath)) {
                return res.status(404).json({ error: `File [${filename}] not found in /markdown or /data folder` });
            }
            markdown = fs.readFileSync(safePath, 'utf8');
            if (!title) title = filename.replace(/\.md$/i, '').replace(/_/g, ' ');
        }

        const chunk_target = req.body?.chunk_target
            ? Math.max(300, Math.min(parseInt(req.body.chunk_target, 10), 2000))
            : undefined;

        const chunk_overlap = req.body?.chunk_overlap
            ? Math.max(0, Math.min(parseInt(req.body.chunk_overlap, 10), 300))
            : undefined;

        if (!markdown.trim()) {
            return res.status(400).json({ error: "markdown OR filename required" });
        }

        const out = await ingestMarkdown({
            tenant_id,
            title,
            markdown,
            lang,
            source_url,
            chunk_target,
            chunk_overlap,
        });

        return res.json({
            ok: true,
            ...out,
        });
    } catch (e) {
        console.error("[API /client/markdown] Error:", e);
        return res.status(500).json({ error: String(e) });
    }
});

// --- RAG Test Endpoint ---
router.post("/client/rag-test", async (req, res) => {
    try {
        const question = String(req.body?.question || "").trim();
        const tenant_id = req.body?.tenant_id || 1;

        if (!question) return res.status(400).json({ error: "question required" });

        console.log(`[RAG-TEST] Inbound question: "${question}"`);

        // Mock state for the graph nodes
        let state = {
            userMsg: question,
            tenantId: tenant_id,
        };

        // Run the entire RAG workflow using the orchestrator
        state = await runRagWorkflow(state, aiHelper);

        return res.json({
            ok: true,
            question,
            answer: state.final_answer,
            rag_debug: state.rag_debug || []
        });
    } catch (err) {
        console.error("[API /client/rag-test] Error:", err);
        return res.status(500).json({ error: String(err) });
    }
});

export default router;

import dotenv from "dotenv";
import mysql from "mysql2/promise";
import aiHelper from "../helper/aiHelper.js";
import { translateResponse } from "../helper/translationHelper.js";
import { runRagWorkflow } from "./workflowRag2.js";

dotenv.config();

// -------------------- ENV --------------------
const DB_HOST = process.env.DB_HOST || "127.0.0.1";
const DB_USER = process.env.DB_USER || "root";
const DB_PASS = process.env.DB_PASS || "";
const DB_NAME = process.env.DB_NAME || "bot";

// -------------------- STAGES (ONLY THESE) --------------------
const STAGES = {
    READY: "READY",
    NEED_PRODUCT: "NEED_PRODUCT",
    NEED_VARIANT: "NEED_VARIANT",
    CONFIRM_RESET: "CONFIRM_RESET",
};

const END = "__END__";
const ACTION_CODES = Object.freeze({
    ADD: 1,
    REMOVE: 2,
    SET: 3,
});
const ACTION_CODE_GUIDE =
    `Action Codes:\n` +
    `${ACTION_CODES.ADD} = add | tambah | 加\n` +
    `${ACTION_CODES.REMOVE} = remove / reduce | kurangkan / tolak | 减\n` +
    `${ACTION_CODES.SET} = set exact quantity | tetapkan kuantiti | 设定准确数量`;

// -------------------- APP --------------------
// Removed express init.

// -------------------- DB --------------------
const pool = mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    connectTimeout: 60000, // 60 seconds
    acquireTimeout: 60000, // 60 seconds
    timeout: 60000,        // 60 seconds
});

async function q(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return rows;
}

async function loadStateRow(conversation_id) {
    const rows = await q(
        `SELECT id, pricing_stage, cart_json, pending_product_id
     FROM conversations
     WHERE id=?
     LIMIT 1`,
        [conversation_id]
    );
    return rows[0] || null;
}

async function saveStateRow(state) {
    // Zero Cart Snapshot: Only save IDs to DB (names rehydrated on load)
    const miniCart = {
        items: state.cart.items.map(it => ({
            product_id: it.product_id,
            variant_id: it.variant_id,
            _no_variants: it._no_variants,
            qty: it.qty,
            addons: it.addons, // [{addon_id, qty}]
        })),
        addons: state.cart.addons || [], // ROOT LEVEL ADDONS
    };

    await q(
        `UPDATE conversations
     SET pricing_stage=?, cart_json=?, pending_product_id=?, updated_at=NOW()
     WHERE id=?`,
        [
            state.pricing_stage,
            JSON.stringify(miniCart),
            state.pending_product_id || null,
            state.conversation_id
        ]
    );
}

// -------------------- UTILS --------------------
function safeJsonParse(s, fallback) {
    if (!s) return fallback;
    if (typeof s === "object") return s;
    try { return JSON.parse(s); } catch { return fallback; }
}

function norm(s) {
    return String(s || "").toLowerCase().trim().replace(/\s+/g, " ");
}

function inferCartActionHint(text) {
    const t = norm(text);
    if (/\b(remove|minus|deduct|delete|drop|decrease|reduce|kurang|kurangkan|tolak|buang|hapus|cancel)\b|减|删|去掉/i.test(t)) {
        return "remove";
    }
    if (/\b(set|change|update|ubah|tukar|jadikan)\b/i.test(t)) {
        return "set";
    }
    if (/\b(add|tambah|ambil|nak|want|buy)\b|加|买|要/i.test(t)) {
        return "add";
    }
    return null;
}

function formatMoney(cents, currency) {
    const c = currency || "MYR";
    const v = (Number(cents || 0) / 100).toFixed(2);
    if (c === "MYR") return `RM ${v}`;
    return `${c} ${v}`;
}

function buildMenuText(options, lineFn) {
    return options.map((o, i) => `${i + 1}. ${lineFn(o)}`).join("\n");
}

function ensureCart(cart) {
    const c = cart || {};

    // 1. New Multi-Item Format
    if (Array.isArray(c.items)) {
        return {
            items: c.items.map((it) => ({
                product_id: it.product_id ?? null,
                product_name: it.product_name || null, // SNAPSHOT
                product_sku: it.product_sku || null,   // SNAPSHOT
                variant_id: it.variant_id ?? null,
                variant_name: it.variant_name || null, // SNAPSHOT
                variant_key: it.variant_key || null,   // SNAPSHOT
                _no_variants: !!it._no_variants,       // PREVENT LOOP
                qty: Math.max(1, Number(it.qty || 1)),
                addons: Array.isArray(it.addons) ? it.addons : [], // [{addon_id, qty}]
            })),
            addons: Array.isArray(c.addons) ? c.addons : [], // ROOT LEVEL ADDONS
        };
    }

    // 2. Backward Compatibility (Migrate old single-item cart)
    if (c.product_id) {
        return {
            items: [
                {
                    product_id: c.product_id,
                    product_name: c.product_name || null,
                    product_sku: c.product_sku || null,
                    variant_id: c.variant_id ?? null,
                    variant_name: c.variant_name || null,
                    variant_key: c.variant_key || null,
                    _no_variants: !!c._no_variants,
                    qty: Math.max(1, Number(c.qty || 1)),
                    addons: [],
                },
            ],
            addons: Array.isArray(c.addons) ? c.addons : [], // MIGRATE ADDONS TO ROOT
        };
    }

    // 3. New Empty Cart
    return {
        items: [],
        addons: [],
    };
}

function applyCartLine(cart, line, action, qty) {
    const qn = Math.max(0, Math.floor(Number(qty || 0)));
    if (!["add", "set", "remove"].includes(action)) {
        return { ok: false, status: "invalid_action" };
    }

    const existing = cart.items.find(it =>
        it.product_id === line.product_id &&
        it.variant_id === line.variant_id
    );

    let nextQty = existing ? existing.qty : 0;
    let actualRemoved = 0;

    if (action === "add") nextQty += qn;
    else if (action === "set") nextQty = qn;
    else if (action === "remove") {
        if (!existing || existing.qty === 0) return { ok: true, status: "not_in_cart", actual_removed: 0, final_qty: 0 };
        actualRemoved = Math.min(qn, existing.qty);
        nextQty = existing.qty - qn;
    }

    if (nextQty <= 0) {
        if (existing) {
            cart.items = cart.items.filter(it =>
                !(it.product_id === line.product_id && it.variant_id === line.variant_id)
            );
            return { ok: true, status: "removed", actual_removed: actualRemoved || existing.qty, final_qty: 0 };
        }
        return { ok: true, status: "not_in_cart", actual_removed: 0, final_qty: 0 };
    }

    if (existing) {
        existing.qty = nextQty;
        return { ok: true, status: "updated", qty: nextQty, final_qty: nextQty };
    }

    cart.items.push({
        product_id: line.product_id,
        product_name: line.product_name || null,
        product_sku: line.product_sku || null,
        variant_id: line.variant_id ?? null,
        variant_name: line.variant_name || null,
        variant_key: line.variant_key || null,
        _no_variants: !!line._no_variants,
        qty: nextQty,
        addons: Array.isArray(line.addons) ? line.addons : [],
    });
    return { ok: true, status: "added", qty: nextQty, final_qty: nextQty };
}

// -------------------- DB QUERIES --------------------
async function dbListProducts(tenant_id) {
    return await q(
        `SELECT id, sku, name
     FROM products
     WHERE tenant_id=? AND active=1
     ORDER BY name
     LIMIT 200`, // Increased limit for full catalog matching
        [tenant_id]
    );
}

async function dbListAllProductsForMatching(tenant_id) {
    return await q(
        `SELECT id, sku, name
     FROM products
     WHERE tenant_id=? AND active=1
     ORDER BY name`,
        [tenant_id]
    );
}

async function dbListVariants(tenant_id, product_id) {
    return await q(
        `SELECT id, variant_key, variant_name, base_price_cents, currency
     FROM product_variants
     WHERE tenant_id=? AND product_id=? AND active=1
     ORDER BY variant_name`,
        [tenant_id, product_id]
    );
}

async function dbListTenantAddons(tenant_id) {
    return await q(
        `SELECT id, addon_sku, name, price_cents, currency
     FROM addons
     WHERE tenant_id=? AND active=1
     ORDER BY name`,
        [tenant_id]
    );
}

async function dbGetProduct(tenant_id, product_id) {
    const rows = await q(
        `SELECT id, sku, name
     FROM products
     WHERE tenant_id=? AND id=? LIMIT 1`,
        [tenant_id, product_id]
    );
    return rows[0] || null;
}

async function dbGetVariant(tenant_id, variant_id) {
    const rows = await q(
        `SELECT id, product_id, variant_key, variant_name, base_price_cents, currency
     FROM product_variants
     WHERE tenant_id=? AND id=? LIMIT 1`,
        [tenant_id, variant_id]
    );
    return rows[0] || null;
}

async function dbGetAddonsByIds(tenant_id, ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return await q(
        `SELECT id, addon_sku, name, price_cents, currency
     FROM addons
     WHERE tenant_id=? AND id IN (${placeholders}) AND active=1`,
        [tenant_id, ...ids]
    );
}

async function buildCartAndAddonView(state) {
    state.cart = ensureCart(state.cart);

    // 1. Fetch Tenant Addons (Per user request: General Addon List)
    const allowed = await dbListTenantAddons(state.tenant_id);
    const allowedMenuText = allowed.length
        ? buildMenuText(allowed, (a) => `${a.name} (${a.addon_sku}) - ${formatMoney(a.price_cents, a.currency)}`)
        : "(no add-ons available)";

    const hasItems = (state.cart.items && state.cart.items.length > 0) || (state.cart.addons && state.cart.addons.length > 0);
    const addonHelp = (allowed.length && hasItems)
        ? `\n\n🧩 Available add-ons:\n${allowedMenuText}`
        : "";

    // 2. Build Multi-Item Cart View
    const lines = [];
    lines.push("🛒 Cart Summary:");

    if (state.cart.items.length === 0) {
        lines.push("- Your cart is currently empty.");
    }

    let cartGrandTotal = 0;
    let mainCurrency = "MYR";

    for (let i = 0; i < state.cart.items.length; i++) {
        const item = state.cart.items[i];
        const product = await dbGetProduct(state.tenant_id, item.product_id);
        const variant = item.variant_id ? await dbGetVariant(state.tenant_id, item.variant_id) : null;

        if (variant) mainCurrency = variant.currency || "MYR";

        let itemLabel = `📦 Item #${i + 1}: `;
        if (product) itemLabel += `${product.name} (${product.sku})`;
        else itemLabel += `(unknown product)`;

        if (variant) itemLabel += ` - ${variant.variant_name}`;

        lines.push(itemLabel);

        let itemTotal = 0;
        if (variant) {
            const baseTotal = Number(variant.base_price_cents) * Number(item.qty);
            itemTotal += baseTotal;
            lines.push(`  • Base: ${formatMoney(variant.base_price_cents, variant.currency)} x ${item.qty} = ${formatMoney(baseTotal, variant.currency)}`);
        } else {
            lines.push(`  • Quantity: ${item.qty} (Variant not selected)`);
        }

        // Addons for this specific item
        if (item.addons.length > 0) {
            const addonIds = item.addons.map(a => a.addon_id);
            const addonRows = await dbGetAddonsByIds(state.tenant_id, addonIds);
            const addonMap = new Map(addonRows.map(a => [Number(a.id), a]));

            for (const ait of item.addons) {
                const row = addonMap.get(Number(ait.addon_id));
                if (!row) continue;
                const lineTotal = Number(row.price_cents) * Number(ait.qty);
                itemTotal += lineTotal;
                lines.push(`  • Add-on: ${row.name} x ${ait.qty} = ${formatMoney(lineTotal, row.currency)}`);
            }
        }

        if (variant) {
            lines.push(`  • Item Subtotal: ${formatMoney(itemTotal, variant.currency)}`);
        }
        cartGrandTotal += itemTotal;
    }

    // 3. Root-Level General Add-ons (Independent Items)
    if (state.cart.addons && state.cart.addons.length > 0) {
        lines.push("");
        lines.push("🛍️ General Shop Items:");
        const rootAddonIds = state.cart.addons.map(a => a.addon_id);
        const rootAddonRows = await dbGetAddonsByIds(state.tenant_id, rootAddonIds);
        const rootAddonMap = new Map(rootAddonRows.map(a => [Number(a.id), a]));

        for (const ait of state.cart.addons) {
            const row = rootAddonMap.get(Number(ait.addon_id));
            if (!row) continue;
            const lineTotal = Number(row.price_cents) * Number(ait.qty);
            cartGrandTotal += lineTotal;
            lines.push(`• ${row.name} x ${ait.qty} = ${formatMoney(lineTotal, row.currency)}`);
        }
    }

    if (state.cart.items.length > 0 || (state.cart.addons && state.cart.addons.length > 0)) {
        lines.push(`---------------------------`);
        lines.push(`💰 Grand Total: ${formatMoney(cartGrandTotal, mainCurrency)}`);
    }

    const cartText = lines.join("\n");

    // Restore menu object
    const menu = {
        options: allowed.map((a) => ({
            id: a.id,
            addon_sku: a.addon_sku,
            name: a.name,
            price_cents: a.price_cents,
            currency: a.currency || "MYR",
        })),
        context_text: allowedMenuText,
    };

    return { cartText, addonHelp, menu };
}

async function dbListAllAddons(tenant_id) {
    return await q(
        `SELECT id, addon_sku, name, price_cents, currency
     FROM addons
     WHERE tenant_id=? AND active=1
     ORDER BY name`,
        [tenant_id]
    );
}


// -------------------- OLLAMA JSON --------------------
async function ollamaJson({ system, user, schemaHint, options = {} }) {
    return await aiHelper.aiJson({ system, user, schemaHint, options });
}

async function tryAutoPickVariant(state, variants) {
    if (!variants || variants.length === 0) {
        console.log("[DEBUG] tryAutoPickVariant: No variants provided.");
        return [];
    }

    console.log(`[DEBUG] tryAutoPickVariant: Attempting match for "${state.userText}" against ${variants.length} options.`);

    const system =
        `You are a Product Variant Matcher.\n` +
        `List of Variants for the selected product:\n${variants.map(v => `- ${v.variant_name} (KEY: ${v.variant_key}) -> ID: ${v.id}`).join("\n")}\n\n` +
        `Task:\n` +
        `1. ANALYZE: Identify all mentioned variant attributes (size, weight, quantity per item, etc.) from user input.\n` +
        `2. DISTINGUISH: If the user mentions multiple different variants of the SAME product (e.g. "one box and two reams"), you MUST extract each one separately.\n` +
        `3. QUANTITY: Extract the specific quantity for each variant found. Default to 1 if not specified.\n` +
        `4. AMBIGUITY: If a mention is too vague to distinguish between variants (e.g. they say "Blue" but both a "Light Blue" and "Dark Blue" variant exist), you MUST set "is_ambiguous": true.\n\n` +
        `Return JSON: { "reasoning": "string", "is_ambiguous": boolean, "picks": [{ "variant_id": number, "qty": number }] }`;

    const user = `User Query: "${state.userText}"`;
    const schemaHint = `{"reasoning": "the user said blue but did not specify light or dark blue", "is_ambiguous": true, "picks": []}`;

    try {
        const out = await ollamaJson({ system, user, schemaHint });
        console.log(`[DEBUG] tryAutoPickVariant out:`, JSON.stringify(out));

        if (out.is_ambiguous) {
            console.log("[DEBUG] tryAutoPickVariant: LLM flagged as ambiguous.");
            return [];
        }

        if (Array.isArray(out.picks) && out.picks.length > 0) {
            const results = [];
            for (const p of out.picks) {
                const matched = variants.find(v => v.id === p.variant_id);
                if (matched) {
                    results.push({ ...matched, qty: p.qty || 1 });
                }
            }
            if (results.length > 0) return results;
        }
    } catch (e) {
        console.error("tryAutoPickVariant error:", e);
    }
    console.log("[DEBUG] tryAutoPickVariant: No clear matches found.");
    return [];
}

// -------------------- CART APPLY --------------------
function applyAddonToCart(cart, addonRow, action, qty) {
    const aId = Number(addonRow.id);
    const qn = Math.floor(Number(qty || 0));

    // FIX: Allow 0 only if action is "set" (implies remove)
    if (!Number.isFinite(qn) || qn < 0) return { ok: false };
    if (qn === 0 && action !== "set") return { ok: false };

    const idx = cart.addons.findIndex((x) => Number(x.addon_id) === aId);
    if (idx === -1) {
        if (action === "remove") return { ok: true }; // removing non-existing is ok
        cart.addons.push({ addon_id: aId, qty: 0 });
    }

    const item = cart.addons.find((x) => Number(x.addon_id) === aId);
    const prevQty = item.qty;
    let actualRemoved = 0;

    if (action === "add") item.qty += qn;
    else if (action === "set") item.qty = qn;
    else if (action === "remove") {
        actualRemoved = Math.min(qn, prevQty);
        item.qty -= qn;
    }
    else return { ok: false };

    const finalQty = Math.max(0, item.qty);

    // If set to 0 or results in <= 0, remove it
    if (item.qty <= 0) {
        cart.addons = cart.addons.filter((x) => Number(x.addon_id) !== aId);
        return { ok: true, status: "removed", actual_removed: actualRemoved || prevQty, final_qty: 0 };
    }

    return { ok: true, status: action === "add" ? "added" : "updated", final_qty: finalQty };
}

function clearPendingProductState(state, resetMenu = false) {
    state.pending_product_id = null;
    state._matched_product = null;
    state._variant_candidates = null;
    if (resetMenu) {
        state.menu = { options: [], context_text: "" };
    }
}

// -------------------- STATE DEFAULT --------------------
function defaultState({ tenant_id, conversation_id, userText }) {
    return {
        tenant_id,
        conversation_id,
        userText: userText || "",
        pricing_stage: STAGES.READY,
        pending_product_id: null,
        cart: ensureCart({ product_id: null, variant_id: null, qty: 1, addons: [] }),
        menu: { options: [], context_text: "" },
        sensitive_terms: [],

        final_answer: "",
        _next_after_save: END,
    };
}

// -------------------- NODES --------------------

// Node 0 — LOAD_STATE_NODE
async function LOAD_STATE_NODE(state) {
    console.log("[NODE] LOAD_STATE_NODE");
    const row = await loadStateRow(state.conversation_id);

    if (!row) {
        console.error("Critical Error: Conversation missing from database.");
        return { state: defaultState(state), next: "INTENT_ROUTER_NODE" };
    }

    // If pricing_stage is missing, it's a new conversation's first pricing request
    if (!row.pricing_stage || !row.cart_json) {
        const initialState = defaultState(state);
        await saveStateRow(initialState);
        console.log("[NODE] LOAD_STATE_NODE (init default)");
        return { state: initialState, next: "INTENT_ROUTER_NODE" };
    }

    const rawCart = safeJsonParse(row.cart_json, {});
    const legacyPendingProductId = rawCart?.pending_product_id ?? null;

    const recoveredState = {
        ...state,
        pricing_stage: Object.values(STAGES).includes(row.pricing_stage) ? row.pricing_stage : STAGES.READY,
        pending_product_id: row.pending_product_id ?? legacyPendingProductId,
        cart: ensureCart(rawCart),
        menu: { options: [], context_text: "" }, // Ignore row.menu_json
        final_answer: "",
        _next_after_save: END,
    };

    // --- REHYDRATE CART (Zero Snapshot) ---
    for (let item of recoveredState.cart.items) {
        if (item.product_id) {
            const product = await dbGetProduct(state.tenant_id, item.product_id);
            if (product) {
                item.product_name = product.name;
                item.product_sku = product.sku;
            }
        }
        if (item.variant_id) {
            const variant = await dbGetVariant(state.tenant_id, item.variant_id);
            if (variant) {
                item.variant_name = variant.variant_name;
                item.variant_key = variant.variant_key;
            }
        }
    }

    console.log("[LOAD_STATE] Rehydrated Cart Items:", recoveredState.cart.items.length);

    // --- REHYDRATE MENU (Stage-Based Persistence) ---
    const stage = recoveredState.pricing_stage;

    if (stage === STAGES.NEED_PRODUCT) {
        // Stage says: We need a product. Load Product Menu.
        const products = await dbListProducts(state.tenant_id);
        recoveredState.menu = {
            options: products.map((product) => ({ id: product.id, sku: product.sku, name: product.name })),
            context_text: buildMenuText(products, (product) => `${product.name} (${product.sku})`),
        };
    }
    else if (stage === STAGES.NEED_VARIANT) {
        if (recoveredState.pending_product_id) {
            const variants = await dbListVariants(state.tenant_id, recoveredState.pending_product_id);
            recoveredState.menu = {
                options: variants.map((variant) => ({
                    id: variant.id,
                    variant_key: variant.variant_key,
                    variant_name: variant.variant_name,
                    base_price_cents: variant.base_price_cents,
                    currency: variant.currency || "MYR",
                })),
                context_text: buildMenuText(variants, (variant) => `${variant.variant_name} (${variant.variant_key}) - ${formatMoney(variant.base_price_cents, variant.currency)}`),
            };
        } else {
            // Data inconsistency? Fallback to Products
            recoveredState.pricing_stage = STAGES.NEED_PRODUCT;
            console.warn("[LOAD_STATE] Found NEED_VARIANT but no pending_product_id. Resetting.");

            // FIX: Must load Product Menu so LLM works!
            const products = await dbListProducts(state.tenant_id);
            recoveredState.menu = {
                options: products.map((product) => ({ id: product.id, sku: product.sku, name: product.name })),
                context_text: buildMenuText(products, (product) => `${product.name} (${product.sku})`),
            };
        }
    }

    // hard-enforce menu object shape
    recoveredState.menu = {
        options: Array.isArray(recoveredState.menu?.options) ? recoveredState.menu.options : [],
        context_text: String(recoveredState.menu?.context_text || ""),
    };

    console.log(`[NODE] LOAD_STATE_NODE Rehydrated Menu: Stage=${stage}, Options=${recoveredState.menu.options.length}`);
    console.log("[LOAD_STATE] Full Menu:", JSON.stringify(recoveredState.menu, null, 2));

    return { state: recoveredState, next: "INTENT_ROUTER_NODE" };
}

// Node 0.5 — INTENT_ROUTER_NODE (Adapter)
async function INTENT_ROUTER_NODE(state) {
    console.log("[NODE] INTENT_ROUTER_NODE");

    if (!state.userText || state.userText.length < 2) {
        return { state, next: "ENTRY_NODE" };
    }

    const allowedStages = [
        STAGES.READY,
        STAGES.NEED_PRODUCT,
        STAGES.NEED_VARIANT
    ];
    const hasPendingSelection = !!state.pending_product_id;
    const isSelectionStage = hasPendingSelection ||
        state.pricing_stage === STAGES.NEED_PRODUCT ||
        state.pricing_stage === STAGES.NEED_VARIANT;

    if (!allowedStages.includes(state.pricing_stage)) {
        console.log(`[INTENT_ROUTER] Skipping router because stage is ${state.pricing_stage}`);
        return { state, next: "ENTRY_NODE" };
    }

    const system = "You classify user intent. Return JSON.";
    const user =
        `Current Stage: ${state.pricing_stage}\n` +
        `Cart Size: ${state.cart.items.length} unique items.\n\n` +
        `Intents:\n` +
        `- SHOW_CART: User wants to see current items or total price.\n` +
        `- RESET: User wants to wipe the ENTIRE session, clear EVERY item, or start from scratch.\n` +
        `- CONTINUE: User is managing items (adding, removing, changing quantity) OR choosing an option from a menu. Examples: "Add a chair", "Saya nak kerusi", "我要椅子", "yang hitam tu", "the black one", "give me 5".\n` +
        `- CHECK_PRICE: User is asking for pricing or availability. Examples: "How much is the chair?", "Berapa harga meja?", "这张桌子多少钱？", "Price of table?".\n` +
        `- PRODUCT_DETAIL: User is asking for information from the knowledge base, including product details, specifications, shipping policies, how to edit an order, or general help. Examples: "tell me about the chair", "what is the specification of table?", "how can i edit my order?", "when is delivery?", "what is your return policy?", "几时可以送到?", "可以修改订单吗?", "送货要多久?", "bila boleh sampai?", "boleh tukar order?", "delivery berapa lama?".\n\n` +
        `CRITICAL RULE: If the user says "nak [X]", "want [X]", or "我要 [X]", it is ALWAYS CONTINUE (intent to buy).\n` +
        `If the user is ONLY asking for a price or if we sell something without expressing intent to buy/add yet, it is CHECK_PRICE.\n\n` +
        `User Input: "${state.userText}"`;
    const schemaHint = `{"intent": "SHOW_CART | RESET | CONTINUE | CHECK_PRICE | PRODUCT_DETAIL"}`;

    try {
        const out = await ollamaJson({ system, user, schemaHint });
        console.log("[INTENT_ROUTER] Raw LLM Output:", JSON.stringify(out));
        const intent = (out.intent || "CONTINUE").toUpperCase();
        console.log(`[INTENT_ROUTER] Classified: ${intent}`);

        state.sub_intent = intent;

        if (intent === "SHOW_CART") return { state, next: "RESOLVE_QUOTE_NODE" };
        if (intent === "RESET") return { state, next: "ASK_CONFIRM_RESET_NODE" };
        if (intent === "CHECK_PRICE" || intent === "PRODUCT_DETAIL") return { state, next: "CHECK_PRICE_PRODUCT_NODE" };

        if (isSelectionStage) {
            if (hasPendingSelection && state.pricing_stage === STAGES.READY) {
                state.pricing_stage = STAGES.NEED_VARIANT;
            }
            console.log(`[INTENT_ROUTER] Selection stage active (${state.pricing_stage}); bypassing ${intent} and continuing current selection flow.`);
            return { state, next: "ENTRY_NODE" };
        }

        return { state, next: "ENTRY_NODE" };
    }
    catch (error) {
        console.error("[INTENT_ROUTER] Error:", error);
        return { state, next: "ENTRY_NODE" };
    }
}

/**
 * Node: CHECK_PRICE_PRODUCT_NODE
 * Specifically searches for products and variants.
 */
async function CHECK_PRICE_PRODUCT_NODE(state) {
    console.log("[NODE] CHECK_PRICE_PRODUCT_NODE");

    // 1. Load All Products & Variants for fuzzy matching
    const allProducts = await dbListProducts(state.tenant_id);
    const productIds = allProducts.map(p => p.id);

    // Get all variants for these products
    let allVariants = [];
    if (productIds.length > 0) {
        const placeholders = productIds.map(() => "?").join(",");
        allVariants = await q(
            `SELECT v.id, v.product_id, v.variant_name, v.variant_key, v.base_price_cents, v.currency, p.name as product_name
             FROM product_variants v
             JOIN products p ON p.id = v.product_id
             WHERE v.tenant_id=? AND v.product_id IN (${placeholders}) AND v.active=1`,
            [state.tenant_id, ...productIds]
        );
    }

    // 2. Build Vocabulary for LLM Fuzzy Match
    const vocabulary = [];
    allProducts.forEach(p => {
        vocabulary.push({ type: 'product', id: p.id, label: `${p.name} (${p.sku})`, rawName: p.name });
    });
    allVariants.forEach(v => {
        vocabulary.push({ type: 'variant', id: v.id, product_id: v.product_id, label: `${v.product_name} - ${v.variant_name} (${v.variant_key})`, rawName: v.variant_name });
    });

    const vocabText = vocabulary.map((v, i) => `${i + 1}. [${v.type.toUpperCase()}] ${v.label}`).join("\n");

    const system =
        `You are a Price Search Assistant. Identify which product or variant the user is asking about from the menu.\n` +
        `Return JSON: {"reasoning": "string", "matched_index": number | null, "is_addon": boolean}`;

    const user =
        `Menu:\n${vocabText}\n\n` +
        `Task:\n` +
        `1. Find the best match. If the user mentions a specific variant, match that variant.\n` +
        `2. Semantic Matching: If the user describes a product (e.g., "wooden chair") and the menu only lists a generic product (e.g., "Chair"), match the generic product as the user likely refers to one of its variants.\n` +
        `3. If no product or variant matches, set matched_index to null and is_addon to true.\n` +
        `4. Provide the 1-based index from the menu if matched.\n\n` +
        `User Input: "${state.userText}"`;

    const schemaHint = `{"reasoning": "...", "matched_index": 1, "is_addon": false}`;
    console.log("[NODE] CHECK_PRICE_PRODUCT_NODE Prompt -> System:", system, "\nUser:", user);

    let match = { matched_index: null, is_addon: false };
    try {
        match = await ollamaJson({ system, user, schemaHint });
        console.log("[NODE] CHECK_PRICE_PRODUCT_NODE LLM Match:", JSON.stringify(match));
    } catch (e) {
        console.error("[CHECK_PRICE_PRODUCT_NODE] LLM Error:", e);
    }

    if (match.matched_index !== null && match.matched_index > 0 && match.matched_index <= vocabulary.length) {
        const picked = vocabulary[match.matched_index - 1];
        let resultText = "";
        if (!state.sensitive_terms) state.sensitive_terms = [];

        if (picked.type === 'product') {
            const productVariants = allVariants.filter(v => v.product_id === picked.id);
            resultText = `The price for **${picked.rawName}** is as follows:\n`;
            state.sensitive_terms.push(picked.rawName);

            if (productVariants.length > 0) {
                resultText += productVariants.map(v => {
                    state.sensitive_terms.push(v.variant_name);
                    return `• ${v.variant_name}: ${formatMoney(v.base_price_cents, v.currency)}`;
                }).join("\n");
            } else {
                resultText += "No variants found for this product.";
            }
        } else {
            const variant = allVariants.find(v => v.id === picked.id);
            resultText = `The price for **${variant.product_name} (${variant.variant_name})** is **${formatMoney(variant.base_price_cents, variant.currency)}**.`;
            state.sensitive_terms.push(variant.product_name, variant.variant_name);

            // Also show other variants for the same product for better UX
            const otherVariants = allVariants.filter(v => v.product_id === variant.product_id && v.id !== variant.id);
            if (otherVariants.length > 0) {
                resultText += `\n\nOther options for ${variant.product_name}:\n`;
                resultText += otherVariants.map(v => {
                    state.sensitive_terms.push(v.variant_name);
                    return `• ${v.variant_name}: ${formatMoney(v.base_price_cents, v.currency)}`;
                }).join("\n");
            }
        }

        if (state.sub_intent === "PRODUCT_DETAIL") {
            const searchName = picked.type === 'product' ? picked.rawName : allVariants.find(v => v.id === picked.id).product_name;
            console.log(`[CHECK_PRICE_PRODUCT_NODE] Details requested for ${searchName}, invoking RAG.`);
            try {
                let ragState = {
                    userMsg: state.userText,
                    tenantId: state.tenant_id,
                    lang: state.lang || 'en'
                };
                ragState = await runRagWorkflow(ragState, aiHelper);
                const ragDetails = ragState.final_answer || "";

                // Capture RAG debug info
                if (Array.isArray(ragState.rag_debug)) {
                    state.rag_debug = ragState.rag_debug;
                }

                if (ragDetails && !ragDetails.includes("couldn't find any information") && !ragDetails.includes("I'm sorry")) {
                    resultText = `**Details for ${searchName}:**\n${ragDetails}\n\n**Pricing Info:**\n${resultText}`;
                }
            } catch (err) {
                console.error("[CHECK_PRICE_PRODUCT_NODE] RAG error:", err);
            }
        }

        state.final_answer = resultText;
        return { state, next: "RESOLVE_QUOTE_NODE" };
    } else {
        // No Product Match -> If sub_intent is PRODUCT_DETAIL, try general RAG
        if (state.sub_intent === "PRODUCT_DETAIL") {
            try {
                let ragState = {
                    userMsg: state.userText,
                    tenantId: state.tenant_id,
                    lang: state.lang || 'en'
                };
                ragState = await runRagWorkflow(ragState, aiHelper);

                // Capture RAG debug info
                if (Array.isArray(ragState.rag_debug)) {
                    state.rag_debug = ragState.rag_debug;
                }

                state.final_answer = ragState.final_answer || "I'm sorry, I couldn't find an answer to that.";
                return { state, next: "RESOLVE_QUOTE_NODE" };
            } catch (err) {
                console.error("[CHECK_PRICE_PRODUCT_NODE] General RAG error:", err);
            }
        }

        // Default: Move to Addon Node
        return { state, next: "CHECK_PRICE_ADDON_NODE" };
    }
}

/**
 * Node: CHECK_PRICE_ADDON_NODE
 * Specifically extracts keyword and searches in the addons table.
 */
async function CHECK_PRICE_ADDON_NODE(state) { //todo got prompt bias 
    console.log("[NODE] CHECK_PRICE_ADDON_NODE");

    // 1. Extract KEYWORD from user sentence
    const system =
        `You are a Keyword Extraction Assistant. Extract the primary product/item name the user is asking about.\n` +
        `Return JSON only: {"keyword": "string"}`;
    const user = `Task: Extract just the item name. (e.g. "price of tape" -> "tape")\nUser Input: "${state.userText}"`;
    const schemaHint = `{"keyword": "tape"}`;
    console.log(system, user, schemaHint);
    let keyword = "";
    try {
        const out = await ollamaJson({ system, user, schemaHint });
        keyword = out.keyword || state.userText;
        console.log(`[CHECK_PRICE_ADDON_NODE] Extracted Keyword: "${keyword}"`);
    } catch (e) {
        console.error("[CHECK_PRICE_ADDON_NODE] Extraction Error:", e);
        keyword = state.userText;
    }

    // 2. Search Database with Keyword
    const addons = await q(
        `SELECT name, price_cents, currency FROM addons 
         WHERE tenant_id = ? AND active = 1 
         AND (name LIKE ? OR addon_sku LIKE ?) 
         LIMIT 5`,
        [state.tenant_id, `%${keyword}%`, `%${keyword}%`]
    );

    if (addons.length > 0) {
        if (!state.sensitive_terms) state.sensitive_terms = [];
        state.final_answer = `I found these add-ons matching your request:\n` +
            addons.map(a => {
                state.sensitive_terms.push(a.name);
                return `• ${a.name}: ${formatMoney(a.price_cents, a.currency)}`;
            }).join("\n");
    } else {
        // Step 3: Sorry Fallback
        state.final_answer = `I'm sorry, I couldn't find any products or add-ons matching "${state.userText}" in our price list.`;
    }

    state._next_after_save = END;
    return { state, next: "SAVE_STATE_NODE" };
}

// Node 1 — ENTRY_NODE (order matters)
async function ENTRY_NODE(state) {
    console.log("[NODE] ENTRY_NODE stage:", state.pricing_stage);

    if (state.pricing_stage === STAGES.CONFIRM_RESET) {
        return { state, next: "CONFIRM_RESET_REPLY_NODE" };
    }

    console.log(`[NODE] ENTRY_NODE. Stage: ${state.pricing_stage}`);

    if (state.pending_product_id && state.pricing_stage === STAGES.READY) {
        state.pricing_stage = STAGES.NEED_VARIANT;
        console.log(" -> Routing to: LLM_PRE_CHECK_NODE (Pending Variant Recovery)");
        return { state, next: "LLM_PRE_CHECK_NODE" };
    }

    if (state.pricing_stage === STAGES.NEED_VARIANT) {
        console.log(" -> Routing to: LLM_PRE_CHECK_NODE (Variant Flow)");
        return { state, next: "LLM_PRE_CHECK_NODE" };
    }

    if (state.pricing_stage === STAGES.NEED_PRODUCT) {
        console.log(" -> Routing to: FUZZY_MATCH_PRODUCT_NODE (Manual Product Pick)");
        return { state, next: "FUZZY_MATCH_PRODUCT_NODE" };
    }

    console.log(" -> Routing to: FUZZY_MATCH_PRODUCT_NODE (Product Retrieval)");
    return { state, next: "FUZZY_MATCH_PRODUCT_NODE" };
}

// Node 2 — CART_STAGE_NODE (no LLM) 
// to do dead code
async function CART_STAGE_NODE(state) {
    console.log("[NODE] CART_STAGE_NODE");
    state.cart = ensureCart(state.cart);

    if (state.pending_product_id) {
        return { state, next: "SHOW_VARIANTS_MENU_NODE" };
    }

    if (state.cart.items.length === 0) {
        return { state, next: "SHOW_PRODUCTS_MENU_NODE" };
    }

    state.pricing_stage = STAGES.READY;
    return { state, next: "FUZZY_MATCH_PRODUCT_NODE" };
}

// Node 3 — SHOW_PRODUCTS_MENU_NODE (DB) (todo with greeting n shop name)
async function SHOW_PRODUCTS_MENU_NODE(state) {
    const products = await dbListProducts(state.tenant_id);
    const contextText = buildMenuText(products, (product) => `${product.name} (${product.sku})`);

    clearPendingProductState(state);
    state.menu = {
        options: products.map((product) => ({ id: product.id, sku: product.sku, name: product.name })),
        context_text: contextText
    };
    state.pricing_stage = STAGES.NEED_PRODUCT;

    const view = await buildCartAndAddonView(state);
    const prefix = state.final_answer ? (state.final_answer + "\n\n") : "";
    state.final_answer =
        prefix +
        view.cartText + "\n\n" +
        `Please choose a product:\n` +
        (contextText || "(no products)");

    state._next_after_save = END;
    console.log("[NODE] SHOW_PRODUCTS_MENU_NODE set stage: NEED_PRODUCT");
    return { state, next: "SAVE_STATE_NODE" };
}

// Node 4 — SHOW_VARIANTS_MENU_NODE (DB)
async function SHOW_VARIANTS_MENU_NODE(state) {
    console.log("[NODE] SHOW_VARIANTS_MENU_NODE");
    const productId = state.pending_product_id;

    if (!productId) {
        state.pricing_stage = STAGES.READY;
        return { state, next: "RESOLVE_QUOTE_NODE" };
    }

    const variants = await dbListVariants(state.tenant_id, productId);

    if (!variants || variants.length === 0) {
        console.log("[NODE] SHOW_VARIANTS_MENU_NODE: No variants found.");
        const product = await dbGetProduct(state.tenant_id, productId);
        clearPendingProductState(state, true);
        state.final_answer = product
            ? `I couldn't find any variants for ${product.name}. Please choose another product.`
            : "I couldn't find any variants for that product. Please choose another product.";
        state.pricing_stage = STAGES.READY;
        return { state, next: "FUZZY_MATCH_PRODUCT_NODE" };
    }

    // Clear the flag if there are variants
    state.cart._no_variants = false;
    const product = await dbGetProduct(state.tenant_id, productId);
    const productLabel = product
        ? `${product.name} (${product.sku})`
        : "this product";

    const contextText = buildMenuText(variants, (variant) => `${variant.variant_name} (${variant.variant_key}) - ${formatMoney(variant.base_price_cents, variant.currency)}`);

    state.menu = {
        options: variants.map((variant) => ({
            id: variant.id,
            variant_key: variant.variant_key,
            variant_name: variant.variant_name,
            base_price_cents: variant.base_price_cents,
            currency: variant.currency || "MYR",
        })),
        context_text: contextText
    };
    const view = await buildCartAndAddonView(state);
    state.pricing_stage = STAGES.NEED_VARIANT;
    if (!Array.isArray(state.sensitive_terms)) state.sensitive_terms = [];
    if (product) {
        state.sensitive_terms.push(product.name, product.sku, productLabel);
    }

    const prefix = state.final_answer ? (state.final_answer + "\n\n") : "";
    state.final_answer =
        prefix +
        view.cartText + "\n\n" +
        `Please choose a variant for ${productLabel} and quantity:\n` +
        (contextText || "(no variants)");

    state._next_after_save = END;
    console.log("[NODE] SHOW_VARIANTS_MENU_NODE set stage: NEED_VARIANT");
    return { state, next: "SAVE_STATE_NODE" };
}


// Removed VARIANT_PICK_LLM_NODE (obsolete)


// Unclear fallback
async function GENERATE_UNCLEAR_REPLY_NODE(state) {
    console.log("[NODE] GENERATE_UNCLEAR_REPLY_NODE");

    let type = "item";
    if (state.pricing_stage === STAGES.NEED_PRODUCT) type = "product";
    else if (state.pricing_stage === STAGES.NEED_VARIANT) type = "variant";

    const system =
        `You are a helpful, lively customer service bot. The user's input was unclear or ambiguous. Generate a short, friendly message asking for clarification.\n` +
        `Return JSON only: { "reply": "Your message here" }`;

    const user =
        `Available Menu:\n${state.menu.context_text}\n\n` +
        `Context: We are trying to pick a ${type} from this menu.\n` +
        `Task: Check if the User Input relates to the Menu.\n` +
        `- CASE 1 (Off-Topic/Not Sold): If they ask for something clearly NOT in the menu (e.g. "Airplane" but we sell Car Parts), say "Sorry, we don't have that."\n` +
        `- CASE 2 (Ambiguous): If they ask for a keyword present in multiple items (e.g. "light"), ask specifically "Which one did you mean?"\n` +
        `- Be conversational and helpful.\n\n` +
        `User Input: "${state.userText}"`;

    const schemaHint = `{"reply": ""}`;
    console.log("[NODE] GENERATE_UNCLEAR_REPLY_NODE system:", system, user, schemaHint);
    try {
        const out = await ollamaJson({ system, user, schemaHint });
        state.final_answer = out.reply || "I didn't understand. Please try again.";
    }
    catch (err) {
        console.error("[NODE] GENERATE_UNCLEAR_REPLY_NODE error:", err);
    }

    // Append proper menu if available so user can see options again
    if (state.menu && state.menu.context_text) {
        state.final_answer += "\n\n" + state.menu.context_text;
    }

    state._next_after_save = END;
    return { state, next: "SAVE_STATE_NODE" };
}
function buildProductMenuFromCandidates(products) {
    const options = products.map((product) => ({
        id: product.id,
        sku: product.sku,
        name: product.name,
    }));

    return {
        options,
        context_text: buildMenuText(options, (product) => `${product.name} (${product.sku})`),
    };
}

function buildVariantMenuFromVocabulary(vocabulary) {
    const options = vocabulary.map((item) => ({
        id: item.variant_id ?? item.product_id,
        variant_key: item.variant_key || null,
        variant_name: item.variant_name || item.product_name,
        base_price_cents: item.base_price_cents ?? null,
        currency: item.currency || "MYR",
    }));

    return {
        options,
        context_text: buildMenuText(vocabulary, (item) => {
            if (item.type === "product_default") {
                return `${item.product_name} (${item.product_sku})`;
            }
            const priceText = item.base_price_cents != null
                ? ` - ${formatMoney(item.base_price_cents, item.currency)}`
                : "";
            return `${item.variant_name} (${item.variant_key})${priceText}`;
        }),
    };
}

async function buildProductMatchCandidates(state) {
    const allProducts = await dbListAllProductsForMatching(state.tenant_id);
    const menuIndexById = new Map();

    if (state.pricing_stage === STAGES.NEED_PRODUCT && Array.isArray(state.menu?.options) && state.menu.options.length > 0) {
        state.menu.options.forEach((option, index) => {
            if (option?.id) {
                menuIndexById.set(Number(option.id), index + 1);
            }
        });
    }

    return allProducts.map((product) => ({
        id: Number(product.id),
        sku: product.sku || "",
        name: product.name,
        menu_no: menuIndexById.get(Number(product.id)) || null,
    }));
}

async function buildFallbackActionVocabulary(state) {
    const vocabulary = [];

    const addons = await dbListAllAddons(state.tenant_id);

    addons.forEach((addon) => {
        vocabulary.push({
            id: `addon_${addon.id}`,
            label: `Add-on: ${addon.name} (${addon.addon_sku})`,
            type: "addon",
            name: addon.name,
            sku: addon.addon_sku,
        });
    });

    return vocabulary;
}

async function getVariantFlowProduct(state) {
    if (state._matched_product?.id) {
        return state._matched_product;
    }
    if (state.pending_product_id) {
        return await dbGetProduct(state.tenant_id, state.pending_product_id);
    }
    return null;
}

async function buildVariantVocabulary(state) {
    const product = await getVariantFlowProduct(state);
    if (!product) {
        return { product: null, vocabulary: [] };
    }

    let variants = [];
    if (state.pricing_stage === STAGES.NEED_VARIANT && Array.isArray(state.menu?.options) && state.menu.options.length > 0) {
        variants = state.menu.options.map((option) => ({
            id: Number(option.id),
            variant_key: option.variant_key || "",
            variant_name: option.variant_name || "",
            base_price_cents: option.base_price_cents ?? null,
            currency: option.currency || "MYR",
        }));
    } else {
        const allVariants = await dbListVariants(state.tenant_id, product.id);
        variants = allVariants;
    }

    if (!variants.length) {
        return {
            product,
            vocabulary: [{
                id: `product_default_${product.id}`,
                label: `Default option for ${product.name} (${product.sku})`,
                type: "product_default",
                product_id: product.id,
                product_name: product.name,
                product_sku: product.sku,
                variant_id: null,
                variant_name: null,
                variant_key: null,
                _no_variants: true,
                base_price_cents: null,
                currency: "MYR",
            }],
        };
    }

    return {
        product,
        vocabulary: variants.map((variant) => ({
            id: `variant_${variant.id}`,
            label: `Variant for ${product.name}: ${variant.variant_name} (${variant.variant_key})`,
            type: "variant",
            product_id: product.id,
            product_name: product.name,
            product_sku: product.sku,
            variant_id: variant.id,
            variant_name: variant.variant_name,
            variant_key: variant.variant_key,
            _no_variants: false,
            base_price_cents: variant.base_price_cents ?? null,
            currency: variant.currency || "MYR",
        })),
    };
}

async function FUZZY_MATCH_PRODUCT_NODE(state) {
    console.log("[NODE] FUZZY_MATCH_PRODUCT_NODE");
    const candidates = await buildProductMatchCandidates(state);
    state._product_candidates = candidates;

    if (!candidates.length) {
        return { state, next: "FALLBACK_CART_ADDON_NODE" };
    }

    const candidateText = candidates
        .map((product) => {
            const menuNoText = product.menu_no ? ` | MENU_NO: ${product.menu_no}` : "";
            return `- PRODUCT_ID: ${product.id}${menuNoText} | ${product.name} (${product.sku})`;
        })
        .join("\n");

    const system =
        `You are a Catalog Matching Engine. Your task is to identify which product the user wants from the FULL catalog provided below.\n` +
        `Return JSON only: { "reasoning": "string", "matched_product_id": number | null }`;

    const user =
        `Candidate Products:\n${candidateText}\n\n` +
        `Current Stage: ${state.pricing_stage}\n` +
        `Task:\n` +
        `1. Pick the single best matching product from the list.\n` +
        `2. Return the exact PRODUCT_ID from the list, never the list position.\n` +
        `3. If a candidate has MENU_NO and the user says things like "first one", "number 2", or "yang kedua", use MENU_NO to resolve it.\n` +
        `4. Semantic matching across languages is allowed. Example: "kerusi" can refer to "chair" if the catalog supports that meaning.\n` +
        `5. If the user mentions a specific product keyword or category (e.g. "table", "chair", "water"), match it to the corresponding product even if the user doesn't use the full catalog name.\n` +
        `6. If the user ONLY mentions a generic attribute (e.g. "black", "2 units", "large") without any product keywords, and that attribute could apply to multiple items, return matched_product_id as null.\n` +
        `7. DO NOT overreach. If no product keyword is present and attributes are ambiguous, return matched_product_id as null.\n` +
        `8. Never invent a product outside the list.\n\n` +
        `User Input: "${state.userText}"`;

    const schemaHint = `{"reasoning":"product id 101 is the closest candidate based on the user request","matched_product_id":101}`;

    let out = { matched_product_id: null };
    try {
        out = await ollamaJson({ system, user, schemaHint });
    } catch (error) {
        console.error("[FUZZY_MATCH_PRODUCT_NODE] Error:", error);
    }

    console.log("[NODE] FUZZY_MATCH_PRODUCT_NODE raw:", JSON.stringify(out));
    console.log(`[DEBUG] Searching in ${candidates.length} candidates: ${JSON.stringify(candidates.map(c => ({ id: c.id, name: c.name })))}`);

    //take number from llm out
    const productId = Number(out?.matched_product_id);
    const picked = Number.isInteger(productId)
        ? candidates.find((candidate) => Number(candidate.id) === productId) || null
        : null;
    console.log(`[DEBUG] Final matched product: ${picked ? picked.name : "NONE (No match found in candidates list)"}`);

    if (!picked) {
        return { state, next: "FALLBACK_CART_ADDON_NODE" };
    }

    console.log(`[NODE] FUZZY_MATCH_PRODUCT_NODE 2 picked: ${picked.name} (${picked.sku}) [${picked.id}]`);
    clearPendingProductState(state);
    state._matched_product = picked;
    return { state, next: "PREPARE_VARIANT_FLOW_NODE" };
}

async function PREPARE_VARIANT_FLOW_NODE(state) {
    console.log("[NODE] PREPARE_VARIANT_FLOW_NODE");
    const { product, vocabulary } = await buildVariantVocabulary(state);

    if (!product || !vocabulary.length) {
        return { state, next: "FALLBACK_CART_ADDON_NODE" };
    }

    state._matched_product = product;
    state._variant_candidates = vocabulary;
    state.menu = buildVariantMenuFromVocabulary(vocabulary);

    return { state, next: "LLM_PRE_CHECK_NODE" };
}

async function FALLBACK_CART_ADDON_NODE(state) {
    console.log("[NODE] FALLBACK_CART_ADDON_NODE");
    const vocabulary = await buildFallbackActionVocabulary(state);

    if (!vocabulary.length) {
        if (state.pricing_stage === STAGES.NEED_PRODUCT && state.menu?.context_text) {
            return { state, next: "GENERATE_UNCLEAR_REPLY_NODE" };
        }

        if ((state._product_candidates || []).length > 1) {
            state.menu = buildProductMenuFromCandidates(state._product_candidates);
            state.pricing_stage = STAGES.NEED_PRODUCT;
            return { state, next: "GENERATE_UNCLEAR_REPLY_NODE" };
        }

        state._not_found_items = [state.userText];
        return { state, next: "GENERATE_NOT_FOUND_ITEM_REPLY_NODE" };
    }

    const vocabText = vocabulary.map((item) => `[ID: "${item.id}"] ${item.label}`).join("\n");
    const system =
        `You are a strict Extraction Engine for shop add-ons only.\n` +
        `${ACTION_CODE_GUIDE}\n` +
        `Return JSON only: { "reasoning": "string", "actions": [{ "id": "string", "action_code": 1 | 2 | 3, "qty": number, "action_desc": "string" }] }`;

    const user =
        `Vocabulary:\n${vocabText}\n\n` +
        `Task:\n` +
        `1. Identify which Vocabulary items the user wants to manage.\n` +
        `2. Match partial words logically (e.g., "table" strongly matches "Wooden Dining Table").\n` +
        `3. Use the Action Codes exactly as defined above.\n` +
        `4. Only use IDs that appear in the Vocabulary.\n` +
        `5. If the request is completely unrelated or no match exists, return an empty actions array [].\n\n` +
        `User Input: "${state.userText}"`;

    const schemaHint = `{"reasoning":"User wants table, which matches Wooden Dining Table.", "actions":[{"id":"addon_99","action_code":1,"qty":1,"action_desc":"add one unit"}]}`;
    console.log(user);
    let extracted = { actions: [] };
    try {
        extracted = await ollamaJson({ system, user, schemaHint });
    } catch (error) {
        console.error("[FALLBACK_CART_ADDON_NODE] Error:", error);
    }

    console.log("[NODE] FALLBACK_CART_ADDON_NODE raw:", JSON.stringify(extracted));

    if (!Array.isArray(extracted.actions) || extracted.actions.length === 0) {
        if (state.pricing_stage === STAGES.NEED_PRODUCT && state.menu?.context_text) {
            return { state, next: "GENERATE_UNCLEAR_REPLY_NODE" };
        }

        if ((state._product_candidates || []).length > 1) {
            state.menu = buildProductMenuFromCandidates(state._product_candidates);
            state.pricing_stage = STAGES.NEED_PRODUCT;
            return { state, next: "GENERATE_UNCLEAR_REPLY_NODE" };
        }

        state._not_found_items = [state.userText];
        return { state, next: "GENERATE_NOT_FOUND_ITEM_REPLY_NODE" };
    }

    state._work_items = extracted.actions
        .map((action) => {
            const matched = vocabulary.find((item) => item.id === action.id);
            const normalizedAction =
                action.action_code === ACTION_CODES.ADD || action.action_code === String(ACTION_CODES.ADD) ? "add" :
                    action.action_code === ACTION_CODES.REMOVE || action.action_code === String(ACTION_CODES.REMOVE) ? "remove" :
                        action.action_code === ACTION_CODES.SET || action.action_code === String(ACTION_CODES.SET) ? "set" :
                            inferCartActionHint(state.userText) || "add";
            return matched
                ? {
                    ...matched,
                    action: normalizedAction,
                    qty: action.qty || 1,
                }
                : null;
        })
        .filter(Boolean);

    return { state, next: "VALIDATE_ITEMS_NODE" };
}

/**
 * Node: LLM_PRE_CHECK_NODE (LLM 0.5)
 * Variant-only ambiguity check after product resolution.
 */
async function LLM_PRE_CHECK_NODE(state) {
    console.log("[NODE] LLM_PRE_CHECK_NODE (Variant Flow)");

    if (!Array.isArray(state._variant_candidates) || state._variant_candidates.length === 0) {
        const prepared = await buildVariantVocabulary(state);
        state._matched_product = prepared.product;
        state._variant_candidates = prepared.vocabulary;
        if (prepared.vocabulary.length > 0) {
            state.menu = buildVariantMenuFromVocabulary(prepared.vocabulary);
        }
    }

    const vocabulary = state._variant_candidates || [];
    if (!vocabulary.length) {
        state._not_found_items = [state.userText];
        return { state, next: "GENERATE_NOT_FOUND_ITEM_REPLY_NODE" };
    }

    const vocabText = vocabulary.map((item) => `[ID: "${item.id}"] ${item.label}`).join("\n");
    const system =
        `You are a strict variant ambiguity detector.\n` +
        `Return JSON only: { "reasoning": "string", "match_count": number, "is_ambiguous": boolean }\n\n` +
        `Rules:\n` +
        `1. Decide only from the provided Variant Candidates.\n` +
        `2. Use direct attribute matching, not broad semantic similarity.\n` +
        `3. Support multilingual matching and simple translation of the user's words.\n` +
        `4. If the user states a specific attribute such as color, size, weight, pack count, code, or menu number, count only candidates that directly contain that attribute.\n` +
        `5. Do NOT count combo, mixed, assorted, bundle, or multi-option variants unless the user explicitly asks for combo, mixed, assorted, bundle, or all options.\n` +
        `6. If exactly one candidate directly matches, return match_count = 1 and is_ambiguous = false.\n` +
        `7. If two or more candidates directly match the same stated attribute, return the true count and is_ambiguous = true.\n` +
        `8. If no candidate directly matches, return match_count = 0 and is_ambiguous = false.\n` +
        `9. SEPARATE QUANTITY FROM VARIANT MATCH: If the user asks for "2 boxes" but the candidate says "(1 Box)", this IS A PERFECT MATCH. The "2" is the quantity to purchase, while the "(1 Box)" is just the packing format. Do NOT reject matches over quantity numbers.\n` +
        `10. Be strict about the core attribute (like color or GSM). Do not invent weak matches.`;

    const user =
        `Variant Candidates:\n${vocabText}\n\n` +
        `Task:\n` +
        `1. Count how many candidates directly match the user's words.\n` +
        `2. Prefer exact or clearly translated attribute matches.\n` +
        `3. Ignore weak, indirect, or "maybe included" matches.\n` +
        `4. Return 0 if nothing directly matches.\n\n` +
        `User Input: "${state.userText}"`;

    const schemaHint = `{"reasoning":"the user directly asked for one attribute and only one candidate matches","match_count":1,"is_ambiguous":false}`;

    try {
        const out = await ollamaJson({ system, user, schemaHint });
        console.log("[NODE] LLM_PRE_CHECK_NODE raw:", JSON.stringify(out));

        if (Number(out.match_count || 0) === 0 && state.pricing_stage === STAGES.NEED_VARIANT) {
            console.log("[LLM_PRE_CHECK_NODE] No variant match while pending. Clearing pending product and falling back to product search.");
            clearPendingProductState(state, true);
            state.pricing_stage = STAGES.READY;
            return { state, next: "FUZZY_MATCH_PRODUCT_NODE" };
        }

        if (out.is_ambiguous || out.match_count > 1) {
            const product = await getVariantFlowProduct(state);
            if (product && !state.pending_product_id) {
                state.pending_product_id = product.id;
                state.pricing_stage = STAGES.NEED_VARIANT;
                return { state, next: "SHOW_VARIANTS_MENU_NODE" };
            }
            return { state, next: "GENERATE_UNCLEAR_REPLY_NODE" };
        }

        return { state, next: "LLM1_HELPER_NODE" };
    } catch (error) {
        console.error("LLM 0.5 Error:", error);
        return { state, next: "LLM1_HELPER_NODE" };
    }
}

// -------------------- LLM 1 HELPER (Variant Extractor) --------------------

async function LLM1_HELPER_NODE(state) {
    state.cart = ensureCart(state.cart); //to do dead code
    console.log("[NODE] LLM1_HELPER_NODE (Variant Flow)");

    if (!Array.isArray(state._variant_candidates) || state._variant_candidates.length === 0) {
        const prepared = await buildVariantVocabulary(state);
        state._matched_product = prepared.product;
        state._variant_candidates = prepared.vocabulary;
        if (prepared.vocabulary.length > 0) {
            state.menu = buildVariantMenuFromVocabulary(prepared.vocabulary);
        }
    }

    const vocabulary = state._variant_candidates || [];
    console.log(`[DEBUG] Variant Candidates available: ${JSON.stringify(vocabulary.map(v => ({ id: v.id, label: v.label })))}`);
    if (!vocabulary.length) {
        state._not_found_items = [state.userText];
        return { state, next: "GENERATE_NOT_FOUND_ITEM_REPLY_NODE" };
    }
    const vocabText = vocabulary.map((item) => `[ID: "${item.id}"] ${item.label}`).join("\n");

    const system =
        `You are a strict Extraction Engine for product variants only.\n` +
        `${ACTION_CODE_GUIDE}\n` +
        `Return JSON only: { "reasoning": "string", "actions": [{ "id": "string", "action_code": 1 | 2 | 3, "qty": number, "action_desc": "string" }] }\n\n` +
        `Rules:\n` +
        `1. Use only IDs from the Variant Candidates list.\n` +
        `2. Support multilingual matching and simple translation of the user's words.\n` +
        `3. Prefer direct attribute matches (color, size) to pick the variant. Ignore packing quantities (e.g. 'Box of 12') when matching against user requested quantities like '18'.\n` +
        `4. Do NOT map a single attribute to combo, mixed, assorted, bundle, or multi-option variants unless the user explicitly asks for that.\n` +
        `5. If exactly one candidate directly matches the color/size/type requested, return one action for that ID.\n` +
        `6. Use Action Code 2 for remove words like minus, kurangan, kurangkan, tolak, remove, or 减.\n` +
        `7. SEPARATE QUANTITY FROM VARIANT MATCH: If the user asks for "2 boxes" but the variant label says "(1 Box)", it IS A PERFECT MATCH. The "2" goes into 'qty', and you use that variant ID. Do NOT reject it over quantity numbers.\n` +
        `8. Always match the requested product/variant ID regardless of whether the user wants to ADD, REMOVE, or SET it. The action code (1, 2, or 3) must be extracted correctly based on the user's intent, but the product/variant matching logic remains exactly the same.\n` +
        `9. If ambiguous or no direct match, return an empty actions array [].`;

    const user =
        `Variant Candidates:\n${vocabText}\n\n` +
        `Task:\n` +
        `1. Identify the single best direct match.\n` +
        `2. Extract the action using Action Codes and the requested quantity.\n` +
        `3. Only use IDs that appear in the candidate list.\n` +
        `4. If no direct match or more than one direct match, return an empty actions array [].\n\n` +
        `User Input: "${state.userText}"`;

    const schemaHint = `{"reasoning":"User wants to remove a black table, which directly matches variant_55. Action code is 2.","actions":[{"id":"variant_55","action_code":2,"qty":1,"action_desc":"remove one unit"}]}`;

    let extracted = { actions: [] };
    try {
        extracted = await ollamaJson({ system, user, schemaHint });
    } catch (error) {
        console.error("LLM1_HELPER error:", error);
    }

    console.log("[NODE] LLM1_HELPER_NODE raw:", JSON.stringify(extracted));

    if (!Array.isArray(extracted.actions) || extracted.actions.length === 0) {
        //get prodcut by pending or user msg
        const product = await getVariantFlowProduct(state);
        //detech got variant or not
        const onlyDefaultProduct = vocabulary.length === 1 && vocabulary[0]?.type === "product_default";

        if (state.pricing_stage === STAGES.NEED_VARIANT) {
            console.log("[LLM1_HELPER_NODE] Could not resolve pending variant. Clearing pending product and falling back to product search.");
            clearPendingProductState(state, true);
            state.pricing_stage = STAGES.READY;
            return { state, next: "FUZZY_MATCH_PRODUCT_NODE" };
        }

        if (product && !onlyDefaultProduct) {
            state.pending_product_id = product.id;
            state.pricing_stage = STAGES.NEED_VARIANT;
            return { state, next: "SHOW_VARIANTS_MENU_NODE" };
        }
        return { state, next: "GENERATE_UNCLEAR_REPLY_NODE" };
    }

    state._work_items = extracted.actions
        .map((action) => {
            const matched = vocabulary.find((item) => item.id === action.id);
            const normalizedAction =
                action.action_code === ACTION_CODES.ADD || action.action_code === String(ACTION_CODES.ADD) ? "add" :
                    action.action_code === ACTION_CODES.REMOVE || action.action_code === String(ACTION_CODES.REMOVE) ? "remove" :
                        action.action_code === ACTION_CODES.SET || action.action_code === String(ACTION_CODES.SET) ? "set" :
                            inferCartActionHint(state.userText) || "add";
            return matched
                ? {
                    ...matched,
                    action: normalizedAction,
                    qty: action.qty || 1,
                }
                : null;
        })
        .filter(Boolean);

    console.log(`[DEBUG] Finalized Work Items: ${JSON.stringify(state._work_items.map(i => ({ id: i.id, sku: i.sku, name: i.variant_name || i.name, action: i.action, qty: i.qty })))}`);

    return { state, next: "VALIDATE_ITEMS_NODE" };
}

// Validation Node (Between LLM1 and Confirm)
async function VALIDATE_ITEMS_NODE(state) {
    console.log("[NODE] VALIDATE_ITEMS_NODE (Multi-Item)");
    const workItems = state._work_items || [];
    state._work_items = null;

    if (workItems.length === 0) {
        return { state, next: "GENERATE_UNCLEAR_REPLY_NODE" };
    }

    const successMessages = [];

    for (const item of workItems) {
        const action = item.action || "add";
        const qty = Math.max(0, Number(item.qty || 1));

        if (item.type === "cart_item") {
            const cartIdx = parseInt(item.id.replace("cart_", ""));
            const cartItem = state.cart.items[cartIdx];
            if (!cartItem) continue;

            if (action === "remove") {
                if (!cartItem || cartItem.qty === 0) {
                    successMessages.push(`⚠️ ${cartItem?.product_name || "Item"} is not in your cart.`);
                    continue;
                }
                const actualRemoved = Math.min(qty, cartItem.qty);
                cartItem.qty -= qty;
                if (cartItem.qty <= 0) {
                    state.cart.items.splice(cartIdx, 1);
                    successMessages.push(`🗑️ Removed ${cartItem.product_name} (all units).`);
                } else {
                    successMessages.push(`🧩 Removed ${actualRemoved} ${cartItem.product_name} (${cartItem.qty} left).`);
                }
            } else {
                if (action === "add") cartItem.qty += qty;
                else if (action === "set") cartItem.qty = qty;
                successMessages.push(`✅ Updated ${cartItem.product_name} quantity to ${cartItem.qty}.`);
            }
        }
        else if (item.type === "addon") {
            const addonId = parseInt(item.id.replace("addon_", ""));
            const res = applyAddonToCart(state.cart, { id: addonId }, action, qty);
            if (res.ok) {
                const label = item.name || "General Item";
                if (res.status === "removed") {
                    successMessages.push(`🧩 Removed ${res.actual_removed} ${label} (all units).`);
                } else if (res.status === "not_in_cart") {
                    successMessages.push(`⚠️ ${label} is not in your cart.`);
                } else {
                    const verb = action === "set" ? "Set" : "Updated";
                    successMessages.push(`✅ ${verb} ${label} (now ${res.final_qty}).`);
                }
            }
        }
        else if (item.type === "variant" || item.type === "product_default") {
            const res = applyCartLine(state.cart, {
                product_id: item.product_id,
                product_name: item.product_name,
                product_sku: item.product_sku,
                variant_id: item.variant_id,
                variant_name: item.variant_name,
                variant_key: item.variant_key,
                _no_variants: !!item._no_variants,
                addons: [],
            }, action, qty);

            const label = item.type === "product_default"
                ? item.product_name
                : `${item.product_name} (${item.variant_name})`;

            if (res.status === "removed") {
                successMessages.push(`🗑️ Removed ${res.actual_removed} ${label} (all units).`);
            } else if (res.status === "not_in_cart") {
                successMessages.push(`⚠️ ${label} is not in your cart.`);
            } else if (res.status === "updated") {
                successMessages.push(`✅ Updated ${label} quantity to ${res.final_qty}.`);
            } else if (res.status === "added") {
                successMessages.push(`✅ Added ${label} x ${res.final_qty}.`);
            }

            clearPendingProductState(state);
        }
    }

    state._matched_product = null;
    state._product_candidates = null;
    state._variant_candidates = null;
    state.final_answer = successMessages.join("\n");
    state.pricing_stage = STAGES.READY;
    return { state, next: "RESOLVE_QUOTE_NODE" };
}

// GENERATE LLM REPLY FOR MISSING ITEMS
async function GENERATE_NOT_FOUND_ITEM_REPLY_NODE(state) {
    console.log("[NODE] GENERATE_NOT_FOUND_ITEM_REPLY_NODE");
    const missing = state._not_found_items || [];
    state._not_found_items = null;

    const system = "You are a helpful assistant. Generate a polite, short apology for missing items. Return JSON only.";
    const user =
        `We could not find these items in our inventory: ${missing.join(", ")}\n` +
        `Instruction: Apologize. Ask if they want to try again OR if they want to "reset" to choose a different product or product variant.\n` +
        `Return: {"reply": "I couldn't find that item. Would you like to reset to choose a different product?"}\n` +
        `User asked for: "${state.userText}"`;

    const schemaHint = `{"reply":"..."}`;

    const out = await ollamaJson({ system, user, schemaHint });
    state.final_answer = out.reply || `I couldn't find "${missing.join(", ")}". Please check the menu below.`;
    state.pricing_stage = STAGES.READY;
    state._next_after_save = END;
    return { state, next: "RESOLVE_QUOTE_NODE" };
}

// -------------------- DOUBLE CONFIRMATION --------------------

// Generate a summary and ask for confirmation


// confirm reset ask node

// Confirm reset ask node
async function ASK_CONFIRM_RESET_NODE(state) {
    console.log("[NODE] ASK_CONFIRM_RESET_NODE");

    const view = await buildCartAndAddonView(state);
    state.menu = view.menu;
    state.pricing_stage = STAGES.CONFIRM_RESET;

    const system = "You are a helpful customer service assistant. The user wants to reset/clear their shopping cart. Generate a polite, friendly confirmation question asking if they are sure.";
    const user = `Current Cart Context:\n${view.cartText}\n\nTask: Ask the user to confirm they want to reset (Yes or No).`;
    const schemaHint = `{"message":"Are you sure you want to clear your cart?"}`;

    const out = await ollamaJson({ system, user, schemaHint });

    // Use LLM message + Cart Summary. NO addonHelp.
    state.final_answer = (out.message || "Are you sure you want to reset your cart?") + "\n\n" + view.cartText;

    state._next_after_save = END;
    return { state, next: "SAVE_STATE_NODE" };
}

// Confirm reset reply node (YES resets cart+menu properly)
async function CONFIRM_RESET_REPLY_NODE(state) {
    console.log("[NODE] CONFIRM_RESET_REPLY_NODE text:", state.userText);

    const system = "You classify user intent as 'yes', 'no', or 'unclear' for a confirmation question. Return JSON only.";
    const user =
        `Context: The bot asked the user to confirm a reset (Yes/No).\n` +
        `Task: Classify user intent as "yes", "no", or "unclear".\n\n` +

        `### 1. RULES FOR "YES" (Affirmative):\n` +
        `- English: "yes", "y", "okay", "ok", "sure", "correct", "right", "accept", "yea", "yeah", "yup"\n` +
        `- Malay: "ya", "y", "betul", "boleh", "setuju", "ngam", "okay"\n` +
        `- Chinese: "对", "是", "可以", "行", "确定", "好", "没问题"\n\n` +

        `### 2. RULES FOR "NO" (Negative):\n` +
        `- English: "no", "n", "cancel", "stop", "wrong", "reject", "not right"\n` +
        `- Malay: "tidak", "tak", "bukan", "tak betul", "salah", "jangan", "tak mahu"\n` +
        `- Chinese: "不", "不对", "不是", "不行", "不要", "错了", "取消"\n\n` +

        `### 3. CRITICAL LINGUISTIC RULE:\n` +
        `- Never ignore the prefix negation.\n\n` +
        `Return JSON only.\n` +
        `User Input: "${state.userText}"`;

    const schemaHint = `{"decision":"yes"}`;

    const out = await ollamaJson({ system, user, schemaHint });
    const decision = out.decision || "unclear";
    console.log("[NODE] CONFIRM_RESET_REPLY_NODE decision:", decision);

    const yes = decision === "yes";
    if (yes) {

        state.cart = ensureCart({ product_id: null, variant_id: null, qty: 1, addons: [] });
        clearPendingProductState(state, true);
        state.pricing_stage = STAGES.READY;
        return { state, next: "SHOW_PRODUCTS_MENU_NODE" };
    }

    if (state.pending_product_id) {
        state.pricing_stage = STAGES.NEED_VARIANT;
    } else if (state.cart.items.length > 0 || state.cart.addons.length > 0) {
        state.pricing_stage = STAGES.READY;
    } else {
        state.pricing_stage = STAGES.NEED_PRODUCT;
    }
    return { state, next: "RESOLVE_QUOTE_NODE" };
}

// Quote node
export async function RESOLVE_QUOTE_NODE(state) {
    console.log("[NODE] RESOLVE_QUOTE_NODE (Multi-Item)");
    state.cart = ensureCart(state.cart);

    // If we have a pending product selection, we MUST go to variant pick stage
    if (state.pending_product_id) {
        state.pricing_stage = STAGES.NEED_VARIANT;
        return { state, next: "SHOW_VARIANTS_MENU_NODE" };
    }

    // build cart + addons menu view
    const view = await buildCartAndAddonView(state);

    state.menu = view.menu;
    const prefix = state.final_answer ? (state.final_answer + "\n\n") : "";

    state.final_answer =
        prefix +
        view.cartText +
        view.addonHelp;

    state.pricing_stage = STAGES.READY;
    state._next_after_save = END;
    return { state, next: "SAVE_STATE_NODE" };
}

// SAVE node
async function SAVE_STATE_NODE(state) {
    console.log("[NODE] SAVE_STATE_NODE");
    // enforce allowed stages
    if (!Object.values(STAGES).includes(state.pricing_stage)) {
        state.pricing_stage = STAGES.READY; // Fixed: Use READY
    }
    await saveStateRow(state);
    return { state, next: state._next_after_save || END };
}

// -------------------- GRAPH RUNNER --------------------
const nodes = {
    LOAD_STATE_NODE,
    ENTRY_NODE,
    CART_STAGE_NODE,
    SHOW_PRODUCTS_MENU_NODE,
    SHOW_VARIANTS_MENU_NODE,
    FUZZY_MATCH_PRODUCT_NODE,
    PREPARE_VARIANT_FLOW_NODE,
    FALLBACK_CART_ADDON_NODE,

    LLM_PRE_CHECK_NODE,
    LLM1_HELPER_NODE,
    VALIDATE_ITEMS_NODE,

    GENERATE_NOT_FOUND_ITEM_REPLY_NODE,

    ASK_CONFIRM_RESET_NODE,
    CONFIRM_RESET_REPLY_NODE,

    GENERATE_UNCLEAR_REPLY_NODE,
    RESOLVE_QUOTE_NODE,
    INTENT_ROUTER_NODE,
    CHECK_PRICE_PRODUCT_NODE,
    CHECK_PRICE_ADDON_NODE,
    SAVE_STATE_NODE,
    PRICING_ROUTER_NODE: (state) => ({ state, next: "LOAD_STATE_NODE" }) // Safety Alias
};

async function runGraph(input) {
    let state = defaultState(input);
    let current = "LOAD_STATE_NODE";

    for (let i = 0; i < 60; i++) {
        if (current === END) break;
        const fn = nodes[current];
        if (!fn) throw new Error(`Unknown node: ${current}`);
        const out = await fn(state);
        state = out.state;
        current = out.next;
    }
    return state;
}

async function detectLanguage(text) {
    if (!text || text.trim().length < 2) return "en";

    const system = `Identify the language. Return JSON with key "code".
Rules:
- Default to "en" (English) if unsure or mixed.
- IGNORE Numbers: "123", "3,5,7" -> "en".
- Manglish: "wan", "can", "got", "ok", "meh" -> "en".
- "ms" (Malay): Only if text contains generic Malay words (e.g. "saya", "nak", "berapa").
- "zh" (Chinese): Only if text contains Chinese characters.`;

    const user = `Text: "${text}"`;
    const schemaHint = `{"code": "zh | en | ms"}`;

    try {
        // Reusing your existing ollamaJson function
        const out = await ollamaJson({ system, user, schemaHint, });

        const code = out?.code?.toLowerCase() || "en";
        if (["zh", "ms", "en"].includes(code)) return code;
        return "en";
    }
    catch (e) {
        console.error("[DETECT_LANG] Error:", e);
        return "en";
    }
}

// -------------------- TRANSLATION LAYER (Moved to translationHelper.js) --------------------


// -------------------- TRANSLATION LAYER --------------------

async function translateOutput(text, detectedLang, state) {
    if (detectedLang === "en") return text;

    // 1. Collect Sensitive Terms from DB/State
    let sensitiveTerms = [];
    if (state && state.tenant_id && state.cart) {
        try {
            // Product Name - Try Snapshot First
            if (Array.isArray(state.cart.items)) {
                for (const item of state.cart.items) {
                    if (item.product_name) sensitiveTerms.push(item.product_name);
                    if (item.product_sku) sensitiveTerms.push(item.product_sku);
                    if (item.variant_name) sensitiveTerms.push(item.variant_name);
                    if (item.variant_key) sensitiveTerms.push(item.variant_key);
                    // Combo names often generated in cart view
                    if (item.product_name && item.product_sku) sensitiveTerms.push(`${item.product_name} (${item.product_sku})`);
                    if (item.variant_name && item.variant_key) sensitiveTerms.push(`${item.variant_name} (${item.variant_key})`);
                }
            }

            // Pending items
            if (state.pending_product_id) {
                const product = await dbGetProduct(state.tenant_id, state.pending_product_id);
                if (product) {
                    sensitiveTerms.push(product.name, product.sku);
                    sensitiveTerms.push(`${product.name} (${product.sku})`);
                }
            }

            // Node-level explicit protections
            if (Array.isArray(state.sensitive_terms)) {
                sensitiveTerms.push(...state.sensitive_terms);
            }

            // Menu Options (The user sees these now)
            if (state.menu && state.menu.options && state.menu.options.length > 0) {
                state.menu.options.forEach(option => {
                    if (option.name) sensitiveTerms.push(option.name);
                    if (option.sku) sensitiveTerms.push(option.sku);
                    if (option.name && option.sku) sensitiveTerms.push(`${option.name} (${option.sku})`);
                    if (option.addon_sku) sensitiveTerms.push(option.addon_sku);
                    if (option.variant_name) sensitiveTerms.push(option.variant_name);
                    if (option.variant_key) sensitiveTerms.push(option.variant_key);
                    if (option.name && option.addon_sku) sensitiveTerms.push(`${option.name} (${option.addon_sku})`);
                    if (option.variant_name && option.variant_key) sensitiveTerms.push(`${option.variant_name} (${option.variant_key})`);
                });
            }

            // Global Addons (Protect from translation)
            const allAddons = await dbListAllAddons(state.tenant_id);
            if (allAddons) {
                allAddons.forEach(a => {
                    if (a.name) sensitiveTerms.push(a.name);
                    if (a.addon_sku) sensitiveTerms.push(a.addon_sku);
                    if (a.name && a.addon_sku) sensitiveTerms.push(`${a.name} (${a.addon_sku})`);
                });
            }
        } catch (err) {
            console.warn("[TRANSLATE] Info gather failed:", err);
        }
    }

    return await translateResponse(text, detectedLang, sensitiveTerms);
}


// -------------------- API HANDLER --------------------
export async function handlePricingRequest({ tenant_id, conversation_id, userText, lang }) {
    try {
        // STRICT: Caller must provide valid IDs. No defaults here.
        const tenantIdNum = Number(tenant_id);
        const conversationIdNum = Number(conversation_id);
        const text = String(userText || "").trim();

        if (!tenantIdNum || !conversationIdNum) {
            throw new Error("Missing tenant_id or conversation_id in handlePricingRequest");
        }

        console.log("🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿🌿", text);

        // 1. Run Logic (English)
        const finalState = await runGraph({ tenant_id: tenantIdNum, conversation_id: conversationIdNum, userText: text });

        // 2. Translate Output & Update Language Logic
        let detectedLang = lang;

        if (!detectedLang) {
            const wordCount = text.split(/\s+/).filter(Boolean).length;
            detectedLang = "en";

            // Fetch existing conversation lang
            const convRows = await q("SELECT lang FROM conversations WHERE id=? LIMIT 1", [conversationIdNum]);
            const existingLang = convRows[0]?.lang || null;

            const isChinese = /[\u3400-\u9FBF]/.test(text);
            const isQuickReply = isChinese
                ? text.length < 4
                : wordCount < 3 && text.length < 15;

            if (isQuickReply) {
                if (existingLang) {
                    console.log(`[LANG] Quick Reply (Words:${wordCount}, Len:${text.length}, CJK:${isChinese}). Reusing: ${existingLang}`);
                    detectedLang = existingLang;
                } else {
                    console.log(`[LANG] Quick Reply (No History). Defaulting to 'en'.`);
                    detectedLang = "en";
                }
            } else {
                console.log(`[LANG] Complex Text (Words:${wordCount}, Len:${text.length}, CJK:${isChinese}). Running detection...`);
                detectedLang = await detectLanguage(text);

                if (detectedLang !== existingLang) {
                    await q("UPDATE conversations SET lang=? WHERE id=?", [detectedLang, conversationIdNum]);
                }
            }
        }

        console.log("🎯 Using Language:", detectedLang);

        let finalAnswer = finalState.final_answer;
        if (finalAnswer && text) {
            finalAnswer = await translateOutput(finalAnswer, detectedLang, finalState);
        }

        return {
            success: true,
            tenant_id: tenantIdNum,
            conversation_id: conversationIdNum,
            pricing_stage: finalState.pricing_stage,
            answer: finalAnswer, // Translated
            cart: finalState.cart,
            rag_debug: finalState.rag_debug || []
        };
    } catch (err) {
        console.error("handlePricingRequest Error:", err);
        return {
            success: false,
            error: String(err?.message || err),
        };
    }
}

// End of pricing module.

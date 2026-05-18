import aiHelper from "../helper/aiHelper.js";
import { q } from "../config/db.js";

const END = "__END__";
const PAYMENT_DETAIL = "CIMB BANK 7074252854";

const LABELS = {
    en: {
        cartTitle: "Cart Summary:",
        emptyCart: "- Your cart is currently empty.",
        item: "Item",
        unknownProduct: "(unknown product)",
        base: "Base",
        quantity: "Quantity",
        variantNotSelected: "Variant not selected",
        addon: "Add-on",
        generalItems: "General Shop Items:",
        grandTotal: "Grand Total",
    },
    ms: {
        cartTitle: "Ringkasan Troli:",
        emptyCart: "- Troli anda masih kosong.",
        item: "Item",
        unknownProduct: "(produk tidak diketahui)",
        base: "Harga asas",
        quantity: "Kuantiti",
        variantNotSelected: "Varian belum dipilih",
        addon: "Tambahan",
        generalItems: "Item Kedai Umum:",
        grandTotal: "Jumlah Keseluruhan",
    },
    zh: {
        cartTitle: "购物车摘要：",
        emptyCart: "- 您的购物车目前是空的。",
        item: "商品",
        unknownProduct: "（未知产品）",
        base: "基础价格",
        quantity: "数量",
        variantNotSelected: "尚未选择规格",
        addon: "附加项",
        generalItems: "一般商店商品：",
        grandTotal: "总计",
    },
};

function labelsFor(lang) {
    return LABELS[lang] || LABELS.en;
}

function langName(lang) {
    if (lang === "zh") return "Simplified Chinese";
    if (lang === "ms") return "Malay";
    return "English";
}

function safeJsonParse(value, fallback) {
    if (!value) return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function normalizeAddons(addons) {
    if (!Array.isArray(addons)) return [];
    return addons
        .map((addon) => ({
            addon_id: addon.addon_id ?? addon.id ?? null,
            qty: Math.max(1, Number(addon.qty || 1)),
        }))
        .filter((addon) => addon.addon_id);
}

function ensureCart(cart) {
    const c = cart || {};

    if (Array.isArray(c.items)) {
        return {
            items: c.items.map((item) => ({
                product_id: item.product_id ?? null,
                product_name: item.product_name || null,
                product_sku: item.product_sku || null,
                variant_id: item.variant_id ?? null,
                variant_name: item.variant_name || null,
                variant_key: item.variant_key || null,
                _no_variants: !!item._no_variants,
                qty: Math.max(1, Number(item.qty || 1)),
                addons: normalizeAddons(item.addons),
            })),
            addons: normalizeAddons(c.addons),
        };
    }

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
                    addons: normalizeAddons(c.item_addons),
                },
            ],
            addons: normalizeAddons(c.addons),
        };
    }

    return { items: [], addons: [] };
}

function formatMoney(cents, currency) {
    const c = currency || "MYR";
    const value = (Number(cents || 0) / 100).toFixed(2);
    if (c === "MYR") return `RM ${value}`;
    return `${c} ${value}`;
}

async function dbGetProduct(tenantId, productId) {
    if (!productId) return null;
    const rows = await q(
        `SELECT id, sku, name
         FROM products
         WHERE tenant_id=? AND id=? LIMIT 1`,
        [tenantId, productId]
    );
    return rows[0] || null;
}

async function dbGetVariant(tenantId, variantId) {
    if (!variantId) return null;
    const rows = await q(
        `SELECT id, product_id, variant_key, variant_name, base_price_cents, currency
         FROM product_variants
         WHERE tenant_id=? AND id=? LIMIT 1`,
        [tenantId, variantId]
    );
    return rows[0] || null;
}

async function dbGetAddonsByIds(tenantId, ids) {
    const uniqueIds = [...new Set(ids.map((id) => Number(id)).filter(Boolean))];
    if (uniqueIds.length === 0) return [];

    const placeholders = uniqueIds.map(() => "?").join(",");
    return await q(
        `SELECT id, addon_sku, name, price_cents, currency
         FROM addons
         WHERE tenant_id=? AND id IN (${placeholders}) AND active=1`,
        [tenantId, ...uniqueIds]
    );
}

async function loadCartFromConversations(conversationId) {
    try {
        const rows = await q(
            `SELECT cart_json
             FROM conversations
             WHERE id=?
             LIMIT 1`,
            [conversationId]
        );
        if (!rows[0]?.cart_json) return null;
        return safeJsonParse(rows[0].cart_json, null);
    } catch (err) {
        console.warn("[PAYMENT_NODE] Unable to load cart_json from conversations:", err.message);
        return null;
    }
}

async function loadSavedCart(conversationId) {
    if (!conversationId) return ensureCart(null);
    return ensureCart(await loadCartFromConversations(conversationId));
}

function productLabel(product, item, l) {
    const name = product?.name || item.product_name;
    const sku = product?.sku || item.product_sku;
    if (!name) return l.unknownProduct;
    return sku ? `${name} (${sku})` : name;
}

async function buildCartSummary({ tenantId, cart, lang }) {
    const l = labelsFor(lang);
    const lines = [l.cartTitle];

    if (cart.items.length === 0) {
        lines.push(l.emptyCart);
    }

    let grandTotal = 0;
    let mainCurrency = "MYR";

    for (let index = 0; index < cart.items.length; index++) {
        const item = cart.items[index];
        const product = await dbGetProduct(tenantId, item.product_id);
        const variant = await dbGetVariant(tenantId, item.variant_id);

        if (product) {
            item.product_name = product.name;
            item.product_sku = product.sku;
        }
        if (variant) {
            item.variant_name = variant.variant_name;
            item.variant_key = variant.variant_key;
        }

        if (variant?.currency) mainCurrency = variant.currency;

        let line = `${l.item} #${index + 1}: ${productLabel(product, item, l)}`;
        if (variant) line += ` - ${variant.variant_name}`;
        else if (item.variant_name) line += ` - ${item.variant_name}`;
        lines.push(line);

        let itemTotal = 0;
        if (variant) {
            const baseTotal = Number(variant.base_price_cents) * Number(item.qty);
            itemTotal += baseTotal;
            lines.push(`  • ${l.base}: ${formatMoney(variant.base_price_cents, variant.currency)} x ${item.qty} = ${formatMoney(baseTotal, variant.currency)}`);
        } else {
            lines.push(`  • ${l.quantity}: ${item.qty} (${l.variantNotSelected})`);
        }

        if (item.addons.length > 0) {
            const addonRows = await dbGetAddonsByIds(tenantId, item.addons.map((addon) => addon.addon_id));
            const addonMap = new Map(addonRows.map((addon) => [Number(addon.id), addon]));

            for (const selectedAddon of item.addons) {
                const row = addonMap.get(Number(selectedAddon.addon_id));
                if (!row) continue;

                const lineTotal = Number(row.price_cents) * Number(selectedAddon.qty);
                itemTotal += lineTotal;
                lines.push(`  • ${l.addon}: ${row.name} x ${selectedAddon.qty} = ${formatMoney(lineTotal, row.currency)}`);
            }
        }

        grandTotal += itemTotal;
    }

    if (cart.addons.length > 0) {
        lines.push("");
        lines.push(l.generalItems);

        const addonRows = await dbGetAddonsByIds(tenantId, cart.addons.map((addon) => addon.addon_id));
        const addonMap = new Map(addonRows.map((addon) => [Number(addon.id), addon]));

        for (const selectedAddon of cart.addons) {
            const row = addonMap.get(Number(selectedAddon.addon_id));
            if (!row) continue;

            const lineTotal = Number(row.price_cents) * Number(selectedAddon.qty);
            grandTotal += lineTotal;
            mainCurrency = row.currency || mainCurrency;
            lines.push(`• ${row.name} x ${selectedAddon.qty} = ${formatMoney(lineTotal, row.currency)}`);
        }
    }

    if (cart.items.length > 0 || cart.addons.length > 0) {
        lines.push("---------------------------");
        lines.push(`${l.grandTotal}: ${formatMoney(grandTotal, mainCurrency)}`);
    }

    return lines.join("\n");
}

function fallbackPaymentIntro(lang) {
    if (lang === "zh") {
        return `请转账至：${PAYMENT_DETAIL}。付款后，请在这里上传收据。`;
    }
    if (lang === "ms") {
        return `Sila buat bayaran ke: ${PAYMENT_DETAIL}. Selepas bayaran, sila muat naik resit di sini.`;
    }
    return `Please transfer to: ${PAYMENT_DETAIL}. After payment, please upload the receipt here.`;
}

async function generatePaymentIntro({ userText, lang }) {
    const system =
        `You are the PAYMENT_NODE for an ordering bot. Return JSON only.\n` +
        `Reply language must be ${langName(lang)}.\n` +
        `Payment detail must appear exactly as: ${PAYMENT_DETAIL}\n` +
        `Do not translate, rewrite, space out, or localize "${PAYMENT_DETAIL}".\n` +
        `Keep the message short. Tell the user how to pay and ask them to upload/send the receipt after payment.\n` +
        `Do not include the cart summary.`;

    const user =
        `User input: "${userText}"\n` +
        `Task: Generate the payment instruction in the required language.`;
    const schemaHint = `{"message":"..."}`;

    try {
        const out = await aiHelper.aiJson({
            system,
            user,
            schemaHint,
            options: { temperature: 0.2 },
        });
        const message = String(out?.message || "").trim();
        if (message.includes(PAYMENT_DETAIL)) return message;
    } catch (err) {
        console.warn("[PAYMENT_NODE] LLM payment intro failed:", err.message);
    }

    return fallbackPaymentIntro(lang);
}

export async function PAYMENT_NODE(state) {
    console.log("[NODE] PAYMENT_NODE");

    const tenantId = Number(state.tenantId || state.tenant_id || 1);
    const conversationId = Number(state.conversationId || state.conversation_id || 0);
    const lang = ["en", "ms", "zh"].includes(state.lang) ? state.lang : "en";

    const cart = await loadSavedCart(conversationId);
    const cartText = await buildCartSummary({ tenantId, cart, lang });
    const intro = await generatePaymentIntro({ userText: state.userMsg || "", lang });

    state.detected_intent = "payment";
    state.final_answer = `${intro}\n\n${cartText}`;
    state.graph_response = { ui_type: "text", text: state.final_answer, cart };
    state._next_after_save = END;

    return { state, next: "SAVE_STATE_NODE" };
}

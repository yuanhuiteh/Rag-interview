import { q } from '../config/db.js';
import aiHelper from '../helper/aiHelper.js';
import { translateResponse } from '../helper/translationHelper.js';

export async function CATALOG_NODE(state) {
    console.log(`[NODE] CATALOG_NODE | Searching for: "${state.userMsg}"`);

    const tenantId = state.tenantId || 4;
    const searchTerm = state.userMsg || "";

    if (!searchTerm || searchTerm.length < 2) {
        const greeting = "Could you tell me more about what you're looking for? I'd be happy to show you our catalog.";
        state.final_answer = await translateResponse(greeting, state.lang || "en");
        state._next_after_save = "__END__";
        return { state, next: "SAVE_STATE_NODE" };
    }

    // 0. Detect Broad/General Inquiry (e.g. "what products do you have?")
    const isGeneralInquiry = /what|list|show|have|all|product|menu|sell|available/i.test(searchTerm) && searchTerm.split(' ').length < 7;

    let catalogResult = "";
    let resultType = "search_result";
    let sensitiveTerms = [];

    // 1. Try Specific Products (Fuzzy Search) - Skip if it looks like a very broad inquiry
    if (!isGeneralInquiry) {
        const products = await q(
            `SELECT id, sku, name FROM products 
             WHERE tenant_id = ? AND active = 1 
             AND (name LIKE ? OR sku LIKE ?) 
             LIMIT 3`,
            [tenantId, `%${searchTerm}%`, `%${searchTerm}%`]
        );

        if (products.length > 0) {
            const topProduct = products[0];
            const variants = await q(
                `SELECT variant_name, variant_key, base_price_cents, currency 
                 FROM product_variants 
                 WHERE tenant_id = ? AND product_id = ? AND active = 1 
                 LIMIT 10`,
                [tenantId, topProduct.id]
            );

            catalogResult = `MATCHING PRODUCT:\n- ${topProduct.name} (SKU: ${topProduct.sku})\n\n`;
            sensitiveTerms.push(topProduct.name, topProduct.sku);

            if (variants.length > 0) {
                catalogResult += `VARIANTS:\n` +
                    variants.map(v => {
                        sensitiveTerms.push(v.variant_name, v.variant_key);
                        return `  • ${v.variant_name} (${v.variant_key}) - price: ${v.currency || "MYR"} ${(v.base_price_cents / 100).toFixed(2)}`;
                    }).join('\n');
                if (variants.length >= 10) catalogResult += "\n  (Note: showing top 10 variants only)";
            } else {
                catalogResult += `(No variants listed for this product)`;
            }

            if (products.length > 1) {
                catalogResult += `\n\nOTHER RELATED PRODUCTS:\n` + products.slice(1).map(p => {
                    sensitiveTerms.push(p.name, p.sku);
                    return `- ${p.name} (${p.sku})`;
                }).join('\n');
            }
        } else {
            // 2. If no products, search for general Add-ons
            const addons = await q(
                `SELECT addon_sku, name, price_cents, currency FROM addons 
                 WHERE tenant_id = ? AND active = 1 
                 AND (name LIKE ? OR addon_sku LIKE ?) 
                 LIMIT 10`,
                [tenantId, `%${searchTerm}%`, `%${searchTerm}%`]
            );

            if (addons.length > 0) {
                catalogResult = `GENERAL ADD-ONS:\n` +
                    addons.map(a => {
                        sensitiveTerms.push(a.name, a.addon_sku);
                        return `- ${a.name} (${a.addon_sku}) - price: ${a.currency || "MYR"} ${(a.price_cents / 100).toFixed(2)}`;
                    }).join('\n');
            }
        }
    }

    // 3. FALLBACK: General Menu if search failed or was broad
    if (!catalogResult) {
        const mainMenu = await q(
            `SELECT name FROM products WHERE tenant_id = ? AND active = 1 ORDER BY name LIMIT 12`,
            [tenantId]
        );
        if (mainMenu.length > 0) {
            catalogResult = `OUR MAIN MENU:\n` + mainMenu.map(p => {
                sensitiveTerms.push(p.name);
                return `- ${p.name}`;
            }).join('\n');
            resultType = "main_menu";
        }
    }

    // --- Standalone Response Generation (No RAG Mixing) ---
    if (catalogResult) {
        // Build the hardcoded response directly like pricingNode.js (skip LLM text generation)
        const rawAnswer = (resultType === "main_menu"
            ? "Here is our menu:\n"
            : "I found these for you:\n") + catalogResult;

        state.final_answer = await translateResponse(rawAnswer, state.lang, sensitiveTerms);
    } else {
        // All failed - "cant find"
        const failedMsg = `I'm sorry, I couldn't find any products or general add-ons matching "${searchTerm}" in our catalog.`;
        state.final_answer = await translateResponse(failedMsg, state.lang);
    }

    state.stage = "catalog_browse";
    state._next_after_save = "__END__";
    return { state, next: "SAVE_STATE_NODE" };
}

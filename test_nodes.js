import { runGeneralGraph } from './generalGraph.js';
import { q } from './config/db.js';

async function testFlow() {
    try {
        console.log("=== SEEDING DB ===");
        // Dummy tenant & menu for test
        await q(`INSERT IGNORE INTO tenants (id, tenant_key, name) VALUES (1, 'default', 'Test Tenant')`);
        
        // Clean up any old test sessions for the user to ensure they pick up the correct tenant
        await q(`DELETE FROM conversations WHERE (user_key = 'user:24/2/26' OR user_key = 'test_user') AND tenant_id = 1`);
        
        await q(`DELETE FROM tenant_main_menus WHERE id = 999`);
        await q(`
            INSERT INTO tenant_main_menus (id, tenant_id, menu_name, menu_key, workflow_schema, active) 
            VALUES (
                999, 1, 'Workflow Alpha', 'workflow_alpha',
                '[{"key":"item_name","question":"What item are you looking for?","required":true},{"key":"quantity","question":"How many do you need?","required":true}]',
                1
            )
        `);
        
        const convoId = 999123;
        // Setup initial Conversation State matching "Extracting Phase"
        await q(`DELETE FROM conversations WHERE id = ?`, [convoId]);
        await q(`
            INSERT INTO conversations (id, tenant_id, stage, menu_stage, user_key, collected_data, short_memory) 
            VALUES (?, 1, 'intent_processing', '999|extracting', 'test_user', '{}', '[]')
        `, [convoId]);

        console.log("\n=== TEST 1: Simple Answer (Item Name) ===");
        const res1 = await runGeneralGraph("i need some blue pens", { conversationId: convoId, tenantId: 1 });
        console.log("Response 1:", res1.text);
        
        console.log("\n=== TEST 2: Simple Answer (Quantity) ===");
        const res2 = await runGeneralGraph("about 10", { conversationId: convoId, tenantId: 1 });
        console.log("Response 2:", res2.text);

        console.log("\n=== TEST 3: Correction & RAG ===");
        const convoId2 = 999456;
        await q(`DELETE FROM conversations WHERE id = ?`, [convoId2]);
        await q(`
            INSERT INTO conversations (id, tenant_id, stage, menu_stage, user_key, collected_data, short_memory) 
            VALUES (?, 1, 'intent_processing', '999|extracting', 'test_user', '{"item_name":"blue pens"}', '[]')
        `, [convoId2]);
        
        const res3 = await runGeneralGraph("actually i want black pens, and do you have red ones too?", { conversationId: convoId2, tenantId: 1 });
        console.log("Response 3:", res3.text);

    } catch (err) {
        console.error("Test error:", err);
    } finally {
        process.exit(0);
    }
}

testFlow();

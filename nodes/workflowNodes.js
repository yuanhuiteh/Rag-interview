// ============================================================
// workflowNodes.js
// Handles: Workflow Entry, Form Extraction, Data Correction,
//          RAG Bridging, Synthesis, and Completion
// ============================================================

import { q } from '../config/db.js';

// -------------------------------------------------------
// NODE 1: WORKFLOW_GREETING_NODE
// Purpose: Local intent classification — decide what to do
//          after a user enters a department.
// Local Intents:
//   - start_workflow: User explicitly wants to start the form
//   - ask_question:   User is asking / stating a problem (→ RAG answer)
//   - main_menu:      User wants to go back
//   - unknown:        Default — treat as ask_question
// Input:   state.userMsg, state.menu_stage
// Output:  routes to INTENT_PROCESSING_NODE, UNKNOWN_NODE, or SAVE_STATE_NODE
// -------------------------------------------------------
export async function WORKFLOW_GREETING_NODE(state, aiHelper, END) {
    console.log(`[NODE] WORKFLOW_GREETING_NODE`);

    const [menuIdStr] = (state.menu_stage || "").split('|');
    const menuId = parseInt(menuIdStr, 10);
    const matchedMenu = state.availableMenus.find(m => m.id === menuId);

    if (!matchedMenu) {
        state.stage = 'main_menu';
        state.menu_stage = 'ready';
        return { state, next: "UNKNOWN_NODE" };
    }

    // --- Local Intent Classification ---
    const system = `You are a local intent router for the "${matchedMenu.menu_name}" department of a customer service chatbot.
Your job is to understand what the user WANTS TO DO — not to match keywords.
Return JSON only.`;

    const user = `Department: "${matchedMenu.menu_name}"
User Message: "${state.userMsg}"

Classify the user's intent into ONE of these categories:

- "start_workflow": The user is READY to take action and wants to formally submit, report, or register something. 
  This includes: expressing readiness ("ok let's do it", "I want to report this", "help me file this", "go ahead"), 
  agreeing to proceed after being asked ("yes", "sure", "proceed"), 
  or clearly requesting to start ANY process (form, submission, application, registration).

- "ask_question": The user is describing a situation, asking for information, expressing a problem/concern, 
  or venting — but has NOT yet shown a clear desire to take formal action.

- "main_menu": The user wants to go back, leave, or cancel.

- "unknown": A greeting or completely unclear message with no context.

Focus on the user's READINESS AND INTENT, not their exact words.
When in doubt, choose "ask_question" — it is ALWAYS safer to answer first.`;

    const schemaHint = `{"local_intent": "start_workflow | ask_question | main_menu | unknown"}`;

    let localIntent = "unknown";
    try {
        const result = await aiHelper.aiJson({ system, user, schemaHint });
        localIntent = result.local_intent || "unknown";
        console.log(`[WORKFLOW_GREETING_NODE] Local Intent: ${localIntent}`);
    } catch (e) {
        console.error("[WORKFLOW_GREETING_NODE] Local Intent classification failed:", e);
    }

    // --- Routing based on local intent ---

    if (localIntent === "main_menu") {
        state.stage = 'main_menu';
        state.menu_stage = 'ready';
        return { state, next: "UNKNOWN_NODE" };
    }

    if (localIntent === "start_workflow") {
        state.menu_stage = `${menuId}|extracting`;
        return { state, next: "INTENT_PROCESSING_NODE" };
    }

    // ask_question or unknown → answer the user and stay in the greeting area
    const ragPrompt = `
You are a helpful customer service AI handling the ${matchedMenu.menu_name} department.
${state.memoryContext || ""}
The user said/asked: "${state.userMsg}"

Instructions:
1. Greet the user or acknowledge their interest in ${matchedMenu.menu_name}.
2. If they asked a question or described a problem, provide a concise and helpful response based on general knowledge of ${matchedMenu.menu_name}.
3. Keep it brief (2-3 sentences).
4. Do NOT tell them to click the button or start the workflow (the UI will handle that).
5. If the user's message is just about wanting to ${matchedMenu.menu_name.toLowerCase()}, simply acknowledge and say you are ready to assist.
`;

    const aiResponse = await aiHelper.generateAiResponse(ragPrompt);

    state.final_answer = state._isFirstGreeting
        ? `👋 You've reached the **${matchedMenu.menu_name}** department!\n\n${aiResponse}`
        : aiResponse;
    state._isFirstGreeting = false;

    state.graph_response = {
        ui_type: "quick_buttons",
        text: state.final_answer + `\n\nWhen you're ready, click below to start the formal process.`,
        options: [
            { id: "start workflow", title: "Start Workflow" },
            { id: "main_menu", title: "Main Menu" }
        ]
    };
    state._next_after_save = END;
    return { state, next: "SAVE_STATE_NODE" };
}

// -------------------------------------------------------
// NODE 2: INTENT_PROCESSING_NODE
// Purpose: Main form-filling engine. Handles the "extracting" phase.
//          Also handles department switch confirmations.
// Sub-phases: confirm_switch | extracting
// Input:   state.menu_stage, state.collected_data, state._currentSchema
// Output:  routes to EXTRACT_DATA_NODE or SAVE_STATE_NODE
// -------------------------------------------------------
export async function INTENT_PROCESSING_NODE(state, aiHelper, END) {
    console.log(`[NODE] INTENT_PROCESSING_NODE (menu_stage: ${state.menu_stage})`);

    const [menuIdStr, phase] = (state.menu_stage || "").split('|');
    const menuId = parseInt(menuIdStr, 10);

    const matchedMenu = state.availableMenus.find(m => m.id === menuId);
    if (!matchedMenu) {
        state.stage = 'main_menu';
        state.menu_stage = 'ready';
        return { state, next: "UNKNOWN_NODE" };
    }

    // --- Phase: Confirm Department Switch ---
    if (phase === "confirm_switch") {
        const targetMenuId = parseInt(state.menu_stage.split('|')[2], 10);
        const targetMenu = state.availableMenus.find(m => m.id === targetMenuId);

        // Handle direct button clicks first (fast path)
        if (state.userMsg === 'yes_switch') {
            state.menu_stage = `${targetMenuId}|greeting`;
            state.collected_data = {};
            return { state, next: "WORKFLOW_GREETING_NODE" };
        } else if (state.userMsg === 'no_cancel') {
            state.menu_stage = `${menuId}|extracting`;
            state._justReturned = true;
            return { state, next: "INTENT_PROCESSING_NODE" };
        }

        // Use LLM to detect yes/no from natural language or short memory context
        const recentContext = (state.short_memory || [])
            .slice(-4)
            .map(m => `${m.role}: ${m.content}`)
            .join('\n');

        const switchSystem = `You are a yes/no intent detector. Given the conversation context and the user's latest message, determine if the user is AGREEING to switch departments or DECLINING. Return JSON only.`;
        const switchUser = `Context: The bot just asked: "You are filling out a ${matchedMenu.menu_name} form. Switch to ${targetMenu?.menu_name || 'a new topic'} and lose your progress?"

Recent conversation:
${recentContext}

User's latest message: "${state.userMsg}"

Is the user agreeing to switch (yes) or declining (no)?`;
        const switchHint = `{"decision": "yes | no | unclear"}`;

        let decision = "unclear";
        try {
            const res = await aiHelper.aiJson({ system: switchSystem, user: switchUser, schemaHint: switchHint });
            decision = res.decision || "unclear";
            console.log(`[INTENT_PROCESSING_NODE] Switch decision: ${decision}`);
        } catch (e) {
            console.error("[INTENT_PROCESSING_NODE] Switch decision failed:", e);
        }

        if (decision === "yes") {
            state.menu_stage = `${targetMenuId}|greeting`;
            state.collected_data = {};
            return { state, next: "WORKFLOW_GREETING_NODE" };
        } else if (decision === "no") {
            state.menu_stage = `${menuId}|extracting`;
            state._justReturned = true;
            return { state, next: "INTENT_PROCESSING_NODE" };
        }

        // Unclear — re-ask the confirmation question
        state.final_answer = `Just to confirm — do you want to switch from your **${matchedMenu.menu_name}** form to **${targetMenu?.menu_name || 'a new topic'}**? Your current progress will be lost.`;
        state.graph_response = {
            ui_type: "quick_buttons",
            text: state.final_answer,
            options: [
                { id: "yes_switch", title: "Yes, switch" },
                { id: "no_cancel", title: "No, continue" }
            ]
        };
        state._next_after_save = END;
        return { state, next: "SAVE_STATE_NODE" };
    }

    // --- Phase: Extracting (Active Form Filling) ---
    if (phase === "extracting") {
        let schema = [];
        try {
            schema = typeof matchedMenu.workflow_schema === 'string'
                ? JSON.parse(matchedMenu.workflow_schema)
                : (matchedMenu.workflow_schema || []);
        } catch (e) { }

        state._currentSchema = schema;
        const missingRequired = schema.filter(item => item.required && !state.collected_data[item.key]);

        // User has answered something — run it through the GOD SCHEMA evaluator
        if (missingRequired.length > 0 && state.userMsg && state.userMsg !== "start workflow") {
            const currentQuestion = missingRequired[0].question;

            const godSystem = `You are a form data evaluator for a customer service workflow.
Currently asking: "${currentQuestion}"
Collected so far: ${JSON.stringify(state.collected_data)}
All form fields: ${JSON.stringify(schema, null, 2)}

Fill THREE independent buckets simultaneously:
- Bucket A (Answer):     Extract the answer to the CURRENT question. Key: "${missingRequired[0].key}". Null if not answered.
- Bucket B (Correction): Only include keys the user is correcting from previous answers. Empty {} if none.
- Bucket C (Question):   If the user asked a knowledge/policy question, capture its exact text. Null if none.

Return JSON ONLY.`;

            const godSchemaHint = `{
  "bucket_a": { "${missingRequired[0].key}": "extracted value or null" },
  "bucket_b": {},
  "bucket_c": { "question": "the user's question text or null" }
}`;

            try {
                const godResult = await aiHelper.aiJson({ system: godSystem, user: `User says: "${state.userMsg}"`, schemaHint: godSchemaHint });
                console.log("[GOD SCHEMA]", JSON.stringify(godResult));

                state._godResult = {
                    bucketA: godResult.bucket_a || null,
                    bucketB: godResult.bucket_b || null,
                    bucketC: godResult.bucket_c || null,
                    missingRequiredKey: missingRequired[0].key
                };
            } catch (e) {
                console.error("[GOD SCHEMA] Failed:", e);
                state._godResult = null;
            }
            return { state, next: "EXTRACT_DATA_NODE" };
        }

        // No user input yet — ask the next question
        const stillMissing = schema.filter(item => item.required && !state.collected_data[item.key]);
        if (stillMissing.length > 0) {
            state.final_answer = stillMissing[0].question;
            state.graph_response = { ui_type: "text", text: state.final_answer };
            state._next_after_save = END;
            return { state, next: "SAVE_STATE_NODE" };
        }

        // All fields collected — complete
        state._completionMenuId = menuId;
        state._completionMenuName = matchedMenu.menu_name;
        return { state, next: "WORKFLOW_COMPLETION_NODE" };
    }

    // Fallback
    state.stage = 'main_menu';
    state.menu_stage = 'ready';
    return { state, next: "UNKNOWN_NODE" };
}

// -------------------------------------------------------
// NODE 3: EXTRACT_DATA_NODE
// Purpose: Save Bucket A (user's answer to the current question) into collected_data.
// Input:   state._godResult.bucketA
// Output:  state.collected_data → routes to CORRECTION_NODE
// -------------------------------------------------------
export async function EXTRACT_DATA_NODE(state) {
    console.log(`[NODE] EXTRACT_DATA_NODE`);

    const godResult = state._godResult;
    if (godResult?.bucketA) {
        const key = godResult.missingRequiredKey;
        const val = godResult.bucketA[key];
        if (val && val !== "null" && val !== "") {
            state.collected_data[key] = val;
            console.log(`[EXTRACT_DATA_NODE] Saved "${key}" = "${val}"`);
        }
    }
    return { state, next: "CORRECTION_NODE" };
}

// -------------------------------------------------------
// NODE 4: CORRECTION_NODE
// Purpose: Apply any user corrections to previously collected data (Bucket B).
// Input:   state._godResult.bucketB, state._currentSchema
// Output:  state.collected_data updated → routes to RAG_QUERY_NODE
// -------------------------------------------------------
export async function CORRECTION_NODE(state) {
    console.log(`[NODE] CORRECTION_NODE`);

    const bucketB = state._godResult?.bucketB;
    if (bucketB && state._currentSchema) {
        for (const field of state._currentSchema) {
            const correctedVal = bucketB[field.key];
            if (correctedVal && correctedVal !== "null" && correctedVal !== "") {
                const oldVal = state.collected_data[field.key];
                state.collected_data[field.key] = correctedVal;
                state._hasCorrection = true;
                console.log(`[CORRECTION_NODE] Corrected "${field.key}": "${oldVal}" -> "${correctedVal}"`);
            }
        }
    }
    return { state, next: "RAG_RETRIEVE_NODE" };
}

// -------------------------------------------------------
// NODE 5: WORKFLOW_COMPLETION_NODE
// Purpose: Save the completed form as a support ticket and reset state.
// Input:   state._completionMenuId, state.collected_data
// Output:  routes to SAVE_STATE_NODE
// -------------------------------------------------------
export async function WORKFLOW_COMPLETION_NODE(state, END) {
    console.log("[NODE] WORKFLOW_COMPLETION_NODE");

    const menuId = state._completionMenuId;
    const menuName = state._completionMenuName || 'Unknown';

    try {
        await q(`
            INSERT INTO support_tickets (tenant_id, conversation_id, user_key, tenant_main_menu_id, collected_data)
            VALUES (?, ?, ?, ?, ?)
        `, [state.tenantId, state.conversationId, state.userKey || 'unknown', menuId, JSON.stringify(state.collected_data)]);
        console.log(`[WORKFLOW_COMPLETION_NODE] Ticket saved for "${menuName}" (ID: ${menuId})`);
    } catch (err) {
        console.error("[WORKFLOW_COMPLETION_NODE] Ticket save error:", err);
    }

    state.stage = "main_menu";
    state.menu_stage = "ready";
    state.collected_data = {};

    state.final_answer = ((state.final_answer || '') + ` Thank you, your ${menuName} request has been successfully submitted!`).trim();
    state.graph_response = { ui_type: "text", text: state.final_answer };
    state._next_after_save = END;
    return { state, next: "SAVE_STATE_NODE" };
}



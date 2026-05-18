import whatsappHelper from './whatsappHelper.js';

class ChannelAdapter {

    static translate(graphResponse, channel) {
        if (!graphResponse) return this.buildFallback(channel, "An error occurred.");

        const chan = String(channel).toLowerCase();
        let translated;

        // Check if it's WhatsApp (handles "whatsapp" or "channel::whatsapp")
        if (chan.includes('whatsapp')) {
            translated = this.toWhatsApp(graphResponse);
        } else {
            // Fallback for everything else
            translated = this.buildFallback(channel, graphResponse.text || "Support not available for this channel.");
        }

        // Always attach the intent if it exists for evaluation/Postman
        if (graphResponse.intent) {
            translated.intent = graphResponse.intent;
        }

        return translated;
    }

    /**
     * WhatsApp Specific Translations using whatsappHelper
     */
    static toWhatsApp(ui) {
        const common = {
            attachments: ui.attachments || [],
            headerMedia: ui.header_media || null,
            footerText: ui.footer_text || null,
        };

        if (ui.ui_type === "selection_list") {
            if (!ui.options || ui.options.length === 0) {
                // Fallback to text if no options available to prevent buildListPayload error
                return whatsappHelper.buildMessage({
                    ...common,
                    type: "text",
                    bodyText: ui.text || "I'm sorry, there are no options available right now."
                });
            }
            return whatsappHelper.buildMessage({
                ...common,
                type: "list",
                headerText: ui.header_text || null,
                bodyText: ui.text || "Please select an option:",
                buttonText: ui.button_text || "Select",
                sections: [
                    {
                        title: ui.list_title || "Options",
                        rows: ui.options || []
                    }
                ]
            });
        }

        else if (ui.ui_type === "quick_buttons") {
            return whatsappHelper.buildMessage({
                ...common,
                type: "reply_buttons",
                bodyText: ui.text || "Please choose an action:",
                buttons: ui.options || []
            });
        }

        else if (ui.ui_type === "cta") {
            return whatsappHelper.buildMessage({
                ...common,
                type: "cta_url",
                bodyText: ui.text || "Click the link below:",
                cta: ui.cta // Requires { url, displayText }
            });
        }

        // Default text-only response (can still have attachments)
        return whatsappHelper.buildMessage({
            ...common,
            type: "text",
            bodyText: ui.text
        });
    }

    /**
     * Safe unformatted text fallback for unsupported channels
     */
    static buildFallback(channel, textMessage) {
        if (channel === 'whatsapp') {
            return whatsappHelper.buildMessage({ type: "text", bodyText: textMessage });
        }
        return { content: textMessage };
    }
}

export default ChannelAdapter;

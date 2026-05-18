class WhatsappHelper {
    /**
     * One public function to build Chatwoot-ready WhatsApp message payload.
     *
     * Supports:
     * - text only
     * - attachment only
     * - multiple attachments
     * - list
     * - reply buttons (quick reply)
     * - CTA URL
     * - attachment(s) + list
     * - attachment(s) + reply buttons
     * - attachment(s) + CTA URL
     *
     * Output shape is meant for your bot layer before posting into Chatwoot.
     */
    static buildMessage({
        type = "text", // text | list | reply_buttons | cta_url
        bodyText = "",
        headerText = null,
        headerMedia = null,
        footerText = "Main Menu",
        buttonText = "Select",
        sections = [],
        buttons = [],
        cta = null, // { displayText, url }
        attachments = [],
        replyToExternalId = null
    } = {}) {
        this.validateBaseInput({
            type,
            bodyText,
            headerText,
            headerMedia,
            footerText,
            buttonText,
            sections,
            buttons,
            cta,
            attachments
        });

        const normalizedAttachments = this.normalizeAttachments(attachments);

        let whatsappInteractive = null;

        if (type === "list") {
            whatsappInteractive = this.buildListPayload({
                headerText,
                bodyText,
                footerText,
                buttonText,
                sections
            });
        } else if (type === "reply_buttons") {
            whatsappInteractive = this.buildReplyButtonsPayload({
                headerText,
                headerMedia,
                bodyText,
                footerText,
                buttons
            });
        } else if (type === "cta_url") {
            whatsappInteractive = this.buildCtaUrlPayload({
                headerText,
                headerMedia,
                bodyText,
                footerText,
                cta
            });
        }

        const contentAttributes = {};

        if (replyToExternalId) {
            contentAttributes.in_reply_to_external_id = replyToExternalId;
        }

        if (whatsappInteractive) {
            contentAttributes.whatsapp_interactive = whatsappInteractive;
        }

        return {
            content: bodyText || "",
            content_type: "text",
            content_attributes: contentAttributes,
            attachments: normalizedAttachments
        };
    }

    // -------------------------
    // INTERNAL BUILDERS
    // -------------------------

    static buildHeaderOptions({ headerText, headerMedia }) {
        if (headerText && headerMedia) {
            throw new Error("Cannot have both headerText and headerMedia in a WhatsApp Interactive message");
        }

        if (headerText) {
            return {
                type: "text",
                text: headerText
            };
        }

        if (headerMedia) {
            if (!["image", "video", "document"].includes(headerMedia.type)) {
                throw new Error("headerMedia.type must be 'image', 'video', or 'document'");
            }
            if (!headerMedia.url) {
                throw new Error("headerMedia requires a url");
            }
            const payload = {
                type: headerMedia.type,
                [headerMedia.type]: {
                    link: headerMedia.url
                }
            };
            if (headerMedia.type === "document" && headerMedia.filename) {
                payload.document.filename = headerMedia.filename;
            }
            return payload;
        }

        return undefined;
    }

    static buildListPayload({
        headerText,
        bodyText,
        footerText = "Main Menu",
        buttonText = "Select",
        sections = []
    }) {
        if (!bodyText || typeof bodyText !== "string") {
            throw new Error("List message requires bodyText");
        }

        if (!buttonText || typeof buttonText !== "string") {
            throw new Error("List message requires buttonText");
        }

        if (!Array.isArray(sections) || sections.length === 0) {
            throw new Error("List message requires at least one section");
        }

        const payload = {
            type: "list",
            body: { text: bodyText },
            footer: { text: footerText },
            action: {
                button: buttonText,
                sections: sections.map((section, sectionIndex) => {
                    if (!section?.title || typeof section.title !== "string") {
                        throw new Error(`List section at index ${sectionIndex} requires title`);
                    }

                    if (!Array.isArray(section.rows) || section.rows.length === 0) {
                        throw new Error(`List section "${section.title}" requires at least one row`);
                    }

                    return {
                        title: section.title,
                        rows: section.rows.map((row, rowIndex) => {
                            if (!row?.id || typeof row.id !== "string") {
                                throw new Error(
                                    `List row at section ${sectionIndex}, row ${rowIndex} requires id`
                                );
                            }

                            if (!row?.title || typeof row.title !== "string") {
                                throw new Error(
                                    `List row at section ${sectionIndex}, row ${rowIndex} requires title`
                                );
                            }

                            const mappedRow = {
                                id: row.id,
                                title: row.title
                            };

                            if (row.description) {
                                mappedRow.description = String(row.description);
                            }

                            return mappedRow;
                        })
                    };
                })
            }
        };

        const headerPayload = this.buildHeaderOptions({ headerText });
        if (headerPayload) {
            payload.header = headerPayload;
        }

        return payload;
    }

    static buildReplyButtonsPayload({
        headerText,
        headerMedia,
        bodyText,
        footerText = "Main Menu",
        buttons = []
    }) {
        if (!bodyText || typeof bodyText !== "string") {
            throw new Error("Reply buttons message requires bodyText");
        }

        if (!Array.isArray(buttons) || buttons.length === 0) {
            throw new Error("Reply buttons message requires at least one button");
        }

        const payload = {
            type: "button",
            body: { text: bodyText },
            footer: { text: footerText },
            action: {
                buttons: buttons.map((button, index) => {
                    if (!button?.title || typeof button.title !== "string") {
                        throw new Error(`Reply button at index ${index} requires title`);
                    }

                    return {
                        type: "reply",
                        reply: {
                            id: button.id ? String(button.id) : `btn_${index + 1}`,
                            title: button.title
                        }
                    };
                })
            }
        };

        const headerPayload = this.buildHeaderOptions({ headerText, headerMedia });
        if (headerPayload) {
            payload.header = headerPayload;
        }

        return payload;
    }

    static buildCtaUrlPayload({
        headerText,
        headerMedia,
        bodyText,
        footerText = "Main Menu",
        cta
    }) {
        if (!bodyText || typeof bodyText !== "string") {
            throw new Error("CTA URL message requires bodyText");
        }

        if (!cta || typeof cta !== "object") {
            throw new Error("CTA URL message requires cta object");
        }

        if (!cta.displayText || typeof cta.displayText !== "string") {
            throw new Error("CTA URL message requires cta.displayText");
        }

        if (!cta.url || typeof cta.url !== "string") {
            throw new Error("CTA URL message requires cta.url");
        }

        const payload = {
            type: "cta_url",
            body: { text: bodyText },
            footer: { text: footerText },
            action: {
                name: "cta_url",
                parameters: {
                    display_text: cta.displayText,
                    url: cta.url
                }
            }
        };

        const headerPayload = this.buildHeaderOptions({ headerText, headerMedia });
        if (headerPayload) {
            payload.header = headerPayload;
        }

        return payload;
    }

    // -------------------------
    // INTERNAL VALIDATORS
    // -------------------------

    static validateBaseInput({
        type,
        bodyText,
        headerText,
        headerMedia,
        footerText,
        buttonText,
        sections,
        buttons,
        cta,
        attachments
    }) {
        const allowedTypes = ["text", "list", "reply_buttons", "cta_url"];

        if (!allowedTypes.includes(type)) {
            throw new Error(
                `Unsupported type "${type}". Allowed types: ${allowedTypes.join(", ")}`
            );
        }

        if (bodyText !== null && bodyText !== undefined && typeof bodyText !== "string") {
            throw new Error("bodyText must be a string");
        }

        if (headerText !== null && headerText !== undefined && typeof headerText !== "string") {
            throw new Error("headerText must be a string or null");
        }

        if (headerMedia !== null && headerMedia !== undefined && typeof headerMedia !== "object") {
            throw new Error("headerMedia must be an object or null");
        }

        if (type === "list" && headerMedia) {
            throw new Error('type "list" does not support headerMedia (WhatsApp native restriction)');
        }

        if (["list", "reply_buttons", "cta_url"].includes(type) && attachments.length > 0) {
            console.warn(`[WhatsappHelper] Warning: You are sending standard 'attachments' alongside an interactive type "${type}". This will result in separate message bubbles. Use 'headerMedia' if you meant to attach media natively to the interactive bubble.`);
        }

        if (footerText !== null && footerText !== undefined && typeof footerText !== "string") {
            throw new Error("footerText must be a string or null");
        }

        if (buttonText !== null && buttonText !== undefined && typeof buttonText !== "string") {
            throw new Error("buttonText must be a string or null");
        }

        if (!Array.isArray(sections)) {
            throw new Error("sections must be an array");
        }

        if (!Array.isArray(buttons)) {
            throw new Error("buttons must be an array");
        }

        if (!Array.isArray(attachments)) {
            throw new Error("attachments must be an array");
        }

        if (type === "list" && sections.length === 0) {
            throw new Error('type "list" requires sections');
        }

        if (type === "reply_buttons" && buttons.length === 0) {
            throw new Error('type "reply_buttons" requires buttons');
        }

        if (type === "cta_url" && !cta) {
            throw new Error('type "cta_url" requires cta');
        }
    }

    static normalizeAttachments(attachments = []) {
        return attachments.map((attachment, index) => {
            if (!attachment || typeof attachment !== "object") {
                throw new Error(`Attachment at index ${index} must be an object`);
            }

            if (!attachment.url || typeof attachment.url !== "string") {
                throw new Error(`Attachment at index ${index} requires url`);
            }

            const fileType = attachment.fileType || attachment.type || "document";

            return {
                url: attachment.url,
                fileType: String(fileType),
                filename: attachment.filename ? String(attachment.filename) : null
            };
        });
    }
}

export default WhatsappHelper;
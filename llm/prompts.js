export async function getSmalltalkTemplates(lang) {
    const templates = {
        en: "Hello! I am your AI assistant. How can I help you today?",
        zh: "您好！我是您的 AI 助手。请问有什么我可以帮您的吗？",
        ms: "Hai! Saya pembantu AI anda. Bagaimanakah saya boleh membantu anda hari ini?"
    };
    return templates[lang] || templates.en;
}

export function getBotCapabilityTemplates(lang) {
    const templates = {
        en: "I can help you with pricing, payments, and general information about our products and services.",
        zh: "我可以为您提供有关我们产品和服务的定价、付款及一般信息。",
        ms: "Saya boleh membantu anda dengan harga, pembayaran dan maklumat am tentang produk dan perkhidmatan kami."
    };
    return templates[lang] || templates.en;
}

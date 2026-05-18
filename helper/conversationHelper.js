import { q, getPool } from '../config/db.js';

class ConversationHelper {

    static async getOrCreateConversation({ tenant_id, external_id, user_key, channel }) {
        if (!user_key) throw new Error("user_key required");

        if (external_id) {
            const rows = await q(
                `SELECT * FROM conversations WHERE tenant_id=? AND external_id=? LIMIT 1`,
                [tenant_id, external_id]
            );
            if (rows.length) return rows[0];

            const pool = await getPool();
            const [{ insertId }] = await pool.query(
                `INSERT INTO conversations (tenant_id, external_id, channel, user_key) VALUES (?,?,?,?)`,
                [tenant_id, external_id, channel || "api", user_key]
            );
            const created = await q(`SELECT * FROM conversations WHERE id=? LIMIT 1`, [insertId]);
            return created[0];
        }

        const rows2 = await q(
            `SELECT * FROM conversations
             WHERE tenant_id=? AND user_key=? AND channel=?
             ORDER BY id DESC LIMIT 1`,
            [tenant_id, user_key, channel || "api"]
        );
        if (rows2.length) return rows2[0];

        const pool = await getPool();
        const [{ insertId }] = await pool.query(
            `INSERT INTO conversations (tenant_id, channel, user_key) VALUES (?,?,?)`,
            [tenant_id, channel || "api", user_key]
        );
        const created = await q(`SELECT * FROM conversations WHERE id=? LIMIT 1`, [insertId]);
        return created[0];
    }
}

export default ConversationHelper;

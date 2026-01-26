// ============================================
// Test Ticket Creation - PostgreSQL
// ============================================

import { config } from "dotenv";
config();

import pg from "pg";

// PostgreSQL configuration
const PG_CONFIG = {
    host: process.env.PGHOST || '136.107.45.255',
    port: parseInt(process.env.PGPORT || '5432'),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'agora_production',
};

console.log("\n" + "=".repeat(60));
console.log("  TICKET CREATION TEST - PostgreSQL");
console.log("=".repeat(60));
console.log("\nDatabase Config:");
console.log(`  Host:     ${PG_CONFIG.host}`);
console.log(`  Port:     ${PG_CONFIG.port}`);
console.log(`  Database: ${PG_CONFIG.database}`);
console.log(`  User:     ${PG_CONFIG.user}`);
console.log(`  Password: ${PG_CONFIG.password ? '***' : '(not set)'}`);

const pool = new pg.Pool(PG_CONFIG);

// Ticket type codes
const TICKET_CODES: Record<string, string> = {
    fuga: "FUG",
    aclaraciones: "ACL",
    pagos: "PAG",
    lecturas: "LEC",
    revision_recibo: "REV",
    recibo_digital: "DIG",
    urgente: "URG"
};

const SERVICE_TYPE_MAP: Record<string, string> = {
    fuga: "leak_report",
    aclaraciones: "clarifications",
    pagos: "payment",
    lecturas: "report_reading",
    revision_recibo: "receipt_review",
    recibo_digital: "digital_receipt",
    urgente: "human_agent"
};

function generateFolio(ticketType: string): string {
    const typeCode = TICKET_CODES[ticketType] || "GEN";
    const now = new Date();
    const year = now.getFullYear().toString().slice(-2);
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const timestamp = now.getTime().toString().slice(-4);
    return `CEA-${typeCode}-${year}${month}${day}-${timestamp}`;
}

async function testConnection(): Promise<boolean> {
    console.log("\n--- Testing Database Connection ---\n");
    try {
        const client = await pool.connect();
        const result = await client.query('SELECT NOW() as time, current_database() as db');
        console.log(`  ✅ Connected to: ${result.rows[0].db}`);
        console.log(`  ✅ Server time:  ${result.rows[0].time}`);
        client.release();
        return true;
    } catch (error) {
        console.log(`  ❌ Connection failed: ${error instanceof Error ? error.message : error}`);
        return false;
    }
}

async function checkTicketsTable(): Promise<boolean> {
    console.log("\n--- Checking Tickets Table ---\n");
    try {
        const client = await pool.connect();

        // Check if table exists
        const tableCheck = await client.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_name = 'tickets'
            ) as exists
        `);

        if (!tableCheck.rows[0].exists) {
            console.log("  ❌ Tickets table does not exist");
            client.release();
            return false;
        }
        console.log("  ✅ Tickets table exists");

        // Get column info
        const columns = await client.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'tickets'
            ORDER BY ordinal_position
        `);

        console.log("\n  Table Columns:");
        columns.rows.forEach((col: any) => {
            console.log(`    - ${col.column_name}: ${col.data_type} ${col.is_nullable === 'NO' ? '(required)' : ''}`);
        });

        // Count existing tickets
        const count = await client.query('SELECT COUNT(*) as count FROM tickets');
        console.log(`\n  Existing tickets: ${count.rows[0].count}`);

        client.release();
        return true;
    } catch (error) {
        console.log(`  ❌ Error checking table: ${error instanceof Error ? error.message : error}`);
        return false;
    }
}

async function createTestTicket(): Promise<string | null> {
    console.log("\n--- Creating Test Ticket ---\n");

    const ticketType = "aclaraciones";
    const folio = generateFolio(ticketType);
    const serviceType = SERVICE_TYPE_MAP[ticketType];
    const typeCode = TICKET_CODES[ticketType];

    console.log(`  Folio:        ${folio}`);
    console.log(`  Type:         ${ticketType} (${typeCode})`);
    console.log(`  Service Type: ${serviceType}`);
    console.log(`  Contract:     523160`);

    try {
        const client = await pool.connect();

        const accountId = parseInt(process.env.AGENT_ACCOUNT_ID || '1');
        const result = await client.query(`
            INSERT INTO tickets (
                account_id, folio, title, description, status, priority,
                ticket_type, service_type, channel, contract_number,
                client_name, metadata, created_at, updated_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, $8, 'whatsapp', $9,
                $10, $11, NOW(), NOW()
            )
            RETURNING id, folio, created_at
        `, [
            accountId,
            folio,
            "Test Ticket - Agent API Test",
            "This is a test ticket created by the agent API test script to verify ticket creation functionality.",
            "open",
            "medium",
            typeCode,
            serviceType,
            "523160",
            "LUNA CAMPOS, ALEJANDRA",
            JSON.stringify({ test: true, source: "test-ticket.ts" })
        ]);

        const created = result.rows[0];
        console.log(`\n  ✅ Ticket created successfully!`);
        console.log(`     ID:         ${created.id}`);
        console.log(`     Folio:      ${created.folio}`);
        console.log(`     Created:    ${created.created_at}`);

        client.release();
        return created.folio;
    } catch (error) {
        console.log(`\n  ❌ Failed to create ticket: ${error instanceof Error ? error.message : error}`);
        return null;
    }
}

async function verifyTicket(folio: string): Promise<void> {
    console.log("\n--- Verifying Created Ticket ---\n");

    try {
        const client = await pool.connect();

        const result = await client.query(`
            SELECT id, folio, title, description, status, priority,
                   ticket_type, service_type, channel, contract_number,
                   client_name, created_at
            FROM tickets
            WHERE folio = $1
        `, [folio]);

        if (result.rows.length === 0) {
            console.log(`  ❌ Ticket ${folio} not found!`);
        } else {
            const ticket = result.rows[0];
            console.log("  ✅ Ticket found in database:\n");
            console.log(`     ID:              ${ticket.id}`);
            console.log(`     Folio:           ${ticket.folio}`);
            console.log(`     Title:           ${ticket.title}`);
            console.log(`     Status:          ${ticket.status}`);
            console.log(`     Priority:        ${ticket.priority}`);
            console.log(`     Ticket Type:     ${ticket.ticket_type}`);
            console.log(`     Service Type:    ${ticket.service_type}`);
            console.log(`     Channel:         ${ticket.channel}`);
            console.log(`     Contract:        ${ticket.contract_number}`);
            console.log(`     Client:          ${ticket.client_name}`);
            console.log(`     Created:         ${ticket.created_at}`);
        }

        client.release();
    } catch (error) {
        console.log(`  ❌ Error verifying ticket: ${error instanceof Error ? error.message : error}`);
    }
}

async function listRecentTickets(): Promise<void> {
    console.log("\n--- Recent Tickets ---\n");

    try {
        const client = await pool.connect();

        const result = await client.query(`
            SELECT folio, title, status, contract_number, created_at
            FROM tickets
            ORDER BY created_at DESC
            LIMIT 5
        `);

        if (result.rows.length === 0) {
            console.log("  No tickets found");
        } else {
            console.log("  Folio                      Status    Contract   Created");
            console.log("  " + "-".repeat(70));
            result.rows.forEach((t: any) => {
                const date = new Date(t.created_at).toISOString().split('T')[0];
                console.log(`  ${t.folio.padEnd(26)} ${t.status.padEnd(9)} ${(t.contract_number || '-').padEnd(10)} ${date}`);
            });
        }

        client.release();
    } catch (error) {
        console.log(`  ❌ Error listing tickets: ${error instanceof Error ? error.message : error}`);
    }
}

async function main() {
    // 1. Test connection
    const connected = await testConnection();
    if (!connected) {
        console.log("\n❌ Cannot proceed without database connection\n");
        await pool.end();
        process.exit(1);
    }

    // 2. Check tickets table
    const tableOk = await checkTicketsTable();
    if (!tableOk) {
        console.log("\n❌ Tickets table not available\n");
        await pool.end();
        process.exit(1);
    }

    // 3. Create test ticket
    const folio = await createTestTicket();

    // 4. Verify ticket
    if (folio) {
        await verifyTicket(folio);
    }

    // 5. List recent tickets
    await listRecentTickets();

    console.log("\n" + "=".repeat(60));
    console.log("  TEST COMPLETE");
    console.log("=".repeat(60) + "\n");

    await pool.end();
}

main().catch(async (error) => {
    console.error("Fatal error:", error);
    await pool.end();
    process.exit(1);
});

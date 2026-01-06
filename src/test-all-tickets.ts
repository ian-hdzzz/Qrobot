// Test script for all 7 ticket types
import { config } from "dotenv";
config();

import { createTicketDirect } from "./tools.js";

const TEST_CONTRACT = "523160";

interface TicketTestCase {
    service_type: "fuga" | "aclaraciones" | "pagos" | "lecturas" | "revision_recibo" | "recibo_digital" | "urgente";
    titulo: string;
    descripcion: string;
    priority: "urgente" | "alta" | "media" | "baja";
    ubicacion?: string;
}

const testCases: TicketTestCase[] = [
    {
        service_type: "fuga",
        titulo: "Fuga de agua en calle",
        descripcion: "Reporte de fuga de agua en la vía pública, esquina de Av. Principal y Calle 5",
        priority: "urgente",
        ubicacion: "Av. Principal esquina Calle 5, Col. Centro"
    },
    {
        service_type: "aclaraciones",
        titulo: "Aclaración sobre cargo extra",
        descripcion: "El cliente solicita aclaración sobre un cargo adicional de $150 en su recibo",
        priority: "media"
    },
    {
        service_type: "pagos",
        titulo: "Pago no reflejado",
        descripcion: "El cliente realizó un pago de $500 hace 3 días y no aparece en su estado de cuenta",
        priority: "alta"
    },
    {
        service_type: "lecturas",
        titulo: "Lectura incorrecta del medidor",
        descripcion: "El cliente reporta que la lectura de su medidor no corresponde con el consumo real",
        priority: "media"
    },
    {
        service_type: "revision_recibo",
        titulo: "Revisión de recibo alto",
        descripcion: "El cliente solicita revisión de su recibo por un monto inusualmente alto de $2,500",
        priority: "media"
    },
    {
        service_type: "recibo_digital",
        titulo: "Solicitud de recibo digital",
        descripcion: "El cliente solicita activar el envío de recibo digital a su correo electrónico",
        priority: "baja"
    },
    {
        service_type: "urgente",
        titulo: "Solicita hablar con asesor",
        descripcion: "El cliente solicita ser atendido por un asesor humano para resolver su problema",
        priority: "urgente"
    }
];

async function runTests() {
    console.log("=".repeat(60));
    console.log("TESTING ALL 7 TICKET TYPES");
    console.log("=".repeat(60));
    console.log();

    const results: { type: string; folio: string; success: boolean; error?: string }[] = [];

    for (const testCase of testCases) {
        console.log(`\n📝 Testing: ${testCase.service_type.toUpperCase()}`);
        console.log("-".repeat(40));

        try {
            const result = await createTicketDirect({
                service_type: testCase.service_type,
                titulo: testCase.titulo,
                descripcion: testCase.descripcion,
                contract_number: TEST_CONTRACT,
                email: "test@example.com",
                ubicacion: testCase.ubicacion || null,
                priority: testCase.priority
            });

            if (result.success && result.folio) {
                console.log(`✅ SUCCESS: ${result.folio}`);
                console.log(`   Message: ${result.message}`);
                results.push({ type: testCase.service_type, folio: result.folio, success: true });
            } else {
                console.log(`❌ FAILED`);
                results.push({ type: testCase.service_type, folio: "", success: false, error: "Creation failed" });
            }
        } catch (error) {
            console.log(`❌ ERROR: ${error instanceof Error ? error.message : error}`);
            results.push({ type: testCase.service_type, folio: "", success: false, error: String(error) });
        }
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("SUMMARY");
    console.log("=".repeat(60));
    console.log();

    const successCount = results.filter(r => r.success).length;
    console.log(`Total: ${results.length} | Success: ${successCount} | Failed: ${results.length - successCount}`);
    console.log();

    console.log("| Type            | Status | Folio              |");
    console.log("|-----------------|--------|-------------------|");
    for (const r of results) {
        const status = r.success ? "✅" : "❌";
        console.log(`| ${r.type.padEnd(15)} | ${status}     | ${(r.folio || "N/A").padEnd(17)} |`);
    }

    // Exit with appropriate code
    process.exit(successCount === results.length ? 0 : 1);
}

runTests().catch(console.error);

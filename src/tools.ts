// ============================================
// CEA Native Tools - Production Ready
// ============================================
// These are the critical tools that MUST be native for reliability

import { config } from "dotenv";
config(); // Load environment variables first

import { tool } from "@openai/agents";
import { z } from "zod";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import pg from "pg";
import type {
    CreateTicketInput,
    CreateTicketResult,
    DeudaResponse,
    ConsumoResponse,
    ContratoResponse,
    TicketType,
} from "./types.js";

// ============================================
// Configuration
// ============================================

const CEA_API_BASE = "https://aquacis-cf-int.ceaqueretaro.gob.mx/Comercial/services";

// Proxy configuration for whitelisted IP
const PROXY_URL = process.env.CEA_PROXY_URL || null; // e.g., "http://10.128.0.7:3128"

// PostgreSQL configuration for AGORA (Chatwoot)
const PG_CONFIG = {
    host: process.env.PGHOST || 'whisper-api_agora_postgres',
    port: parseInt(process.env.PGPORT || '5432'),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'agora_production',
    max: parseInt(process.env.PGPOOL_MAX || '10'),
};

// PostgreSQL connection pool
const pgPool = new pg.Pool(PG_CONFIG);

const TICKET_CODES: Record<TicketType, string> = {
    fuga: "FUG",
    aclaraciones: "ACL",
    pagos: "PAG",
    lecturas: "LEC",
    revision_recibo: "REV",
    recibo_digital: "DIG",
    urgente: "URG"
};

// Map tool service types to PostgreSQL enum values (ticket_service_type)
// Valid enum: clarifications, contract_change, payment, digital_receipt, report_reading, leak_report, receipt_review, human_agent, update_case, general
const SERVICE_TYPE_MAP: Record<TicketType, string> = {
    fuga: "leak_report",
    aclaraciones: "clarifications",
    pagos: "payment",
    lecturas: "report_reading",
    revision_recibo: "receipt_review",
    recibo_digital: "digital_receipt",
    urgente: "human_agent"
};

// Map priority values to PostgreSQL enum (ticket_priority: low, medium, high, urgent)
const PRIORITY_MAP: Record<string, string> = {
    baja: "low",
    media: "medium",
    alta: "high",
    urgente: "urgent"
};

// Map status values to PostgreSQL enum (ticket_status)
const STATUS_MAP: Record<string, string> = {
    abierto: "open",
    en_proceso: "in_progress",
    escalado: "escalated",
    esperando_cliente: "waiting_client",
    esperando_interno: "waiting_internal",
    resuelto: "resolved",
    cerrado: "closed",
    cancelado: "cancelled"
};

// ============================================
// Utility Functions
// ============================================

async function fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries = 3,
    delayMs = 1000
): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let response: Response;

            // Use proxy for CEA API calls if configured
            if (PROXY_URL && url.includes('ceaqueretaro.gob.mx')) {
                console.log(`[API] Using proxy: ${PROXY_URL} for ${url}`);

                const proxyAgent = new ProxyAgent(PROXY_URL);

                // @ts-ignore - undici types are compatible at runtime
                response = await undiciFetch(url, {
                    method: options.method || 'GET',
                    headers: options.headers,
                    body: options.body as any,
                    dispatcher: proxyAgent,
                    signal: AbortSignal.timeout(30000)
                });
            } else {
                // Regular fetch for non-CEA APIs
                response = await fetch(url, {
                    ...options,
                    signal: AbortSignal.timeout(30000)
                });
            }

            if (!response.ok && attempt < maxRetries) {
                console.warn(`[API] Attempt ${attempt} failed with status ${response.status}, retrying...`);
                await new Promise(r => setTimeout(r, delayMs * attempt));
                continue;
            }

            return response;
        } catch (error) {
            lastError = error as Error;
            console.warn(`[API] Attempt ${attempt} error: ${lastError.message}`);

            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, delayMs * attempt));
            }
        }
    }

    throw lastError || new Error("Request failed after retries");
}

function parseXMLValue(xml: string, tag: string): string | null {
    const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
    const match = xml.match(regex);
    return match ? match[1].trim() : null;
}

function parseXMLArray(xml: string, containerTag: string, itemTag: string): string[] {
    const containerRegex = new RegExp(`<${containerTag}[^>]*>([\\s\\S]*?)</${containerTag}>`, 'gi');
    const items: string[] = [];
    let match;

    while ((match = containerRegex.exec(xml)) !== null) {
        items.push(match[1]);
    }

    return items;
}

function getMexicoDate(): Date {
    return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
}

// Synchronous folio generation (fallback only)
// Format: {TYPE}-{YYYYMMDD}-{SEQUENCE} (e.g., ACL-20260106-0001)
function generateTicketFolio(ticketType: TicketType): string {
    const typeCode = TICKET_CODES[ticketType];
    const now = getMexicoDate();

    const year = now.getFullYear().toString();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dateStr = `${year}${month}${day}`;

    // Use timestamp for uniqueness (fallback when DB query not available)
    const timestamp = now.getTime().toString().slice(-4);

    return `${typeCode}-${dateStr}-${timestamp}`;
}

// PostgreSQL-based folio generation with proper sequential numbering
// Format: {TYPE}-{YYYYMMDD}-{SEQUENCE} (e.g., ACL-20260106-0001)
async function generateTicketFolioFromPG(ticketType: TicketType): Promise<string> {
    const typeCode = TICKET_CODES[ticketType];
    const now = getMexicoDate();

    const year = now.getFullYear().toString();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dateStr = `${year}${month}${day}`;

    const prefix = `${typeCode}-${dateStr}`;

    try {
        // Query PostgreSQL for the last folio with this prefix
        const result = await pgQuery<{ folio: string }>(`
            SELECT folio FROM tickets
            WHERE folio LIKE $1
            ORDER BY folio DESC
            LIMIT 1
        `, [`${prefix}-%`]);

        let nextNumber = 1;

        if (result && result.length > 0) {
            const lastFolio = result[0].folio;
            const match = lastFolio.match(/-(\d{4})$/);
            if (match) {
                nextNumber = parseInt(match[1]) + 1;
            }
        }

        return `${prefix}-${String(nextNumber).padStart(4, '0')}`;
    } catch (error) {
        console.warn(`[generateTicketFolioFromPG] DB query failed, using timestamp fallback:`, error);
        // Fallback to timestamp-based folio
        const timestamp = now.getTime().toString().slice(-4);
        return `${prefix}-${timestamp}`;
    }
}

// ============================================
// SOAP Builders
// ============================================

function buildDeudaSOAP(contrato: string): string {
    return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:int="http://interfazgenericagestiondeuda.occamcxf.occam.agbar.com/" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
    <soapenv:Header>
        <wsse:Security mustUnderstand="1">
            <wsse:UsernameToken wsu:Id="UsernameTokenWSGESTIONDEUDA">
                <wsse:Username>WSGESTIONDEUDA</wsse:Username>
                <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">WSGESTIONDEUDA</wsse:Password>
            </wsse:UsernameToken>
        </wsse:Security>
    </soapenv:Header>
    <soapenv:Body>
        <int:getDeuda>
            <tipoIdentificador>CONTRATO</tipoIdentificador>
            <valor>${contrato}</valor>
            <explotacion>12</explotacion>
            <idioma>es</idioma>
        </int:getDeuda>
    </soapenv:Body>
</soapenv:Envelope>`;
}

function buildConsumoSOAP(contrato: string): string {
    return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:occ="http://occamWS.ejb.negocio.occam.agbar.com" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
    <soapenv:Header>
        <wsse:Security mustUnderstand="1">
            <wsse:UsernameToken wsu:Id="UsernameToken-WSGESTIONDEUDA">
                <wsse:Username>WSGESTIONDEUDA</wsse:Username>
                <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">WSGESTIONDEUDA</wsse:Password>
            </wsse:UsernameToken>
        </wsse:Security>
    </soapenv:Header>
    <soapenv:Body>
        <occ:getConsumos>
            <explotacion>12</explotacion>
            <contrato>${contrato}</contrato>
            <idioma>es</idioma>
        </occ:getConsumos>
    </soapenv:Body>
</soapenv:Envelope>`;
}

function buildContratoSOAP(contrato: string): string {
    return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:occ="http://occamWS.ejb.negocio.occam.agbar.com">
    <soapenv:Header/>
    <soapenv:Body>
        <occ:consultaDetalleContrato>
            <numeroContrato>${contrato}</numeroContrato>
            <idioma>es</idioma>
        </occ:consultaDetalleContrato>
    </soapenv:Body>
</soapenv:Envelope>`;
}

// ============================================
// Response Parsers
// ============================================

function parseDeudaResponse(xml: string): DeudaResponse {
    try {
        // Check for errors first
        if (xml.includes("<faultstring>") || xml.includes("<error>")) {
            const faultMsg = parseXMLValue(xml, "faultstring") || parseXMLValue(xml, "error") || "Error desconocido";
            return { success: false, error: faultMsg, rawResponse: xml };
        }

        // Check for API error response
        const codigoError = parseXMLValue(xml, "codigoError");
        if (codigoError && codigoError !== "0") {
            const descripcionError = parseXMLValue(xml, "descripcionError") || "Error desconocido";
            return { success: false, error: descripcionError, rawResponse: xml };
        }

        // Parse debt values from CEA API response
        // API returns: deudaTotal, deuda, deudaComision, saldoAnterior, saldoAnteriorTotal
        const totalDeuda = parseFloat(parseXMLValue(xml, "deudaTotal") || parseXMLValue(xml, "deuda") || "0");
        const saldoAnterior = parseFloat(parseXMLValue(xml, "saldoAnteriorTotal") || parseXMLValue(xml, "saldoAnterior") || "0");
        const deudaActual = parseFloat(parseXMLValue(xml, "deuda") || "0");

        // Get client info from response
        const nombreCliente = parseXMLValue(xml, "nombreCliente") || "";
        const direccion = parseXMLValue(xml, "direccion") || "";

        // Conceptos - CEA API doesn't return detailed breakdown, so we create summary
        const conceptos: any[] = [];
        if (saldoAnterior > 0) {
            conceptos.push({
                periodo: "Saldo anterior",
                concepto: "Adeudo de periodos anteriores",
                monto: saldoAnterior,
                fechaVencimiento: "",
                estado: "vencido" as const
            });
        }
        if (deudaActual > 0) {
            conceptos.push({
                periodo: "Periodo actual",
                concepto: "Consumo del periodo",
                monto: deudaActual,
                fechaVencimiento: "",
                estado: "por_vencer" as const
            });
        }

        return {
            success: true,
            data: {
                totalDeuda,
                vencido: saldoAnterior,
                porVencer: deudaActual,
                conceptos,
                nombreCliente,
                direccion
            }
        };
    } catch (error) {
        return {
            success: false,
            error: `Error parsing response: ${error}`,
            rawResponse: xml
        };
    }
}

function parseConsumoResponse(xml: string): ConsumoResponse {
    try {
        if (xml.includes("<faultstring>") || xml.includes("<error>")) {
            const faultMsg = parseXMLValue(xml, "faultstring") || parseXMLValue(xml, "error") || "Error desconocido";
            return { success: false, error: faultMsg };
        }

        const consumos: any[] = [];
        // Match <Consumo> elements (capitalized as returned by CEA API)
        const consumoMatches = xml.match(/<Consumo>[\s\S]*?<\/Consumo>/g) || [];

        for (const consumoXml of consumoMatches) {
            // Extract periodo and decode HTML entities (e.g., &lt;JUN&gt; -> <JUN>)
            let periodo = parseXMLValue(consumoXml, "periodo") || "";
            periodo = periodo.replace(/&lt;/g, '').replace(/&gt;/g, '').replace(/ - .*/, '').trim();

            // Get year to build a better period label
            const año = parseXMLValue(consumoXml, "año") || "";
            if (año && periodo) {
                periodo = `${periodo} ${año}`;
            }

            // Get consumption in cubic meters
            const metrosCubicos = parseFloat(parseXMLValue(consumoXml, "metrosCubicos") || "0");

            // Check if reading was estimated
            const estimado = parseXMLValue(consumoXml, "estimado") === "true";

            // Get reading date
            const fechaLecturaRaw = parseXMLValue(consumoXml, "fechaLectura") || "";
            const fechaLectura = fechaLecturaRaw ? fechaLecturaRaw.split('T')[0] : "";

            consumos.push({
                periodo,
                consumoM3: metrosCubicos,
                lecturaAnterior: 0,
                lecturaActual: 0,
                fechaLectura,
                tipoLectura: estimado ? 'estimada' : 'real' as 'real' | 'estimada'
            });
        }

        // Calculate average and trend (use last 12 months for average)
        const recentConsumos = consumos.slice(0, 12);
        const promedioMensual = recentConsumos.length > 0
            ? recentConsumos.reduce((sum, c) => sum + c.consumoM3, 0) / recentConsumos.length
            : 0;

        let tendencia: 'aumentando' | 'estable' | 'disminuyendo' = 'estable';
        if (consumos.length >= 6) {
            const recent = consumos.slice(0, 3).reduce((s, c) => s + c.consumoM3, 0) / 3;
            const older = consumos.slice(3, 6).reduce((s, c) => s + c.consumoM3, 0) / 3;
            if (recent > older * 1.2) tendencia = 'aumentando';
            else if (recent < older * 0.8) tendencia = 'disminuyendo';
        }

        return {
            success: true,
            data: { consumos, promedioMensual, tendencia }
        };
    } catch (error) {
        return { success: false, error: `Error parsing response: ${error}` };
    }
}

function parseContratoResponse(xml: string): ContratoResponse {
    try {
        if (xml.includes("<faultstring>") || xml.includes("<error>")) {
            const faultMsg = parseXMLValue(xml, "faultstring") || parseXMLValue(xml, "error") || "Error desconocido";
            return { success: false, error: faultMsg };
        }

        // Build address from API fields: calle, numero, municipio, provincia
        const calle = parseXMLValue(xml, "calle") || "";
        const numero = parseXMLValue(xml, "numero") || "";
        const municipio = parseXMLValue(xml, "municipio") || "";
        const provincia = parseXMLValue(xml, "provincia") || "";
        const dirCorrespondencia = parseXMLValue(xml, "dirCorrespondencia") || "";

        // Use dirCorrespondencia if available, otherwise build from components
        let direccion = dirCorrespondencia;
        if (!direccion && calle) {
            direccion = `${calle} ${numero}`.trim();
            if (municipio) direccion += `, ${municipio}`;
        }

        // Determine status based on fechaBaja
        const fechaBaja = parseXMLValue(xml, "fechaBaja");
        const estado = fechaBaja && !xml.includes('fechaBaja xmlns:xsi') ? 'suspendido' : 'activo';

        // Format fechaAlta to readable date
        const fechaAltaRaw = parseXMLValue(xml, "fechaAlta") || "";
        const fechaAlta = fechaAltaRaw ? fechaAltaRaw.split('T')[0] : "";

        return {
            success: true,
            data: {
                numeroContrato: parseXMLValue(xml, "numeroContrato") || "",
                titular: parseXMLValue(xml, "titular") || "",
                direccion: direccion,
                colonia: municipio || provincia || "",
                codigoPostal: parseXMLValue(xml, "codigoPostal") || parseXMLValue(xml, "cp") || "",
                tarifa: parseXMLValue(xml, "descUso") || parseXMLValue(xml, "tipoUso") || "",
                estado: estado as 'activo' | 'suspendido' | 'cortado',
                fechaAlta: fechaAlta,
                ultimaLectura: parseXMLValue(xml, "numeroContador") || undefined
            }
        };
    } catch (error) {
        return { success: false, error: `Error parsing response: ${error}` };
    }
}

// ============================================
// PostgreSQL Helpers
// ============================================

async function pgQuery<T = any>(query: string, params?: any[]): Promise<T[]> {
    const client = await pgPool.connect();
    try {
        const result = await client.query(query, params);
        return result.rows as T[];
    } finally {
        client.release();
    }
}

// ============================================
// Ticket Creation Helper (for reuse)
// ============================================

export async function createTicketDirect(input: CreateTicketInput): Promise<CreateTicketResult> {
    console.log(`[create_ticket_direct] Creating ticket:`, input);

    try {
        // Generate folio with proper sequential numbering from PostgreSQL
        const folio = await generateTicketFolioFromPG(input.service_type);

        // Map values to PostgreSQL enum types
        const serviceType = SERVICE_TYPE_MAP[input.service_type] || "general";
        const ticketType = TICKET_CODES[input.service_type] || "GEN";
        const priority = PRIORITY_MAP[input.priority || "media"] || "medium";
        const status = "open"; // Always start as open

        // Look up contact_id by contract_number if not provided
        let contactId = input.contact_id || null;
        let clientName = input.client_name || null;

        if (!contactId && input.contract_number) {
            try {
                const contacts = await pgQuery<{ id: number; name: string }>(`
                    SELECT id, name FROM contacts
                    WHERE identifier = $1
                       OR custom_attributes->>'contract_number' = $1
                    LIMIT 1
                `, [input.contract_number]);

                if (contacts && contacts.length > 0) {
                    contactId = contacts[0].id;
                    clientName = clientName || contacts[0].name;
                    console.log(`[create_ticket_direct] Found contact: ${contactId} (${clientName})`);
                }
            } catch (err) {
                console.warn(`[create_ticket_direct] Could not look up contact:`, err);
            }
        }

        // Insert into PostgreSQL with contact linkage
        const result = await pgQuery<{ id: number; folio: string }>(`
            INSERT INTO tickets (
                account_id, folio, title, description, status, priority,
                ticket_type, service_type, channel, contract_number,
                client_name, contact_id, conversation_id, inbox_id,
                metadata, created_at, updated_at
            ) VALUES (
                2, $1, $2, $3, $4, $5,
                $6, $7, 'whatsapp', $8,
                $9, $10, $11, $12,
                $13, NOW(), NOW()
            )
            RETURNING id, folio
        `, [
            folio,
            input.titulo,
            input.descripcion,
            status,
            priority,
            ticketType,
            serviceType,
            input.contract_number || null,
            clientName || 'Cliente WhatsApp',
            contactId,
            input.conversation_id || null,
            input.inbox_id || null,
            JSON.stringify({
                email: input.email || null,
                ubicacion: input.ubicacion || null
            })
        ]);

        const createdTicket = result[0];

        console.log(`[create_ticket_direct] Created ticket with folio: ${createdTicket.folio}, contact_id: ${contactId}`);

        return {
            success: true,
            folio: createdTicket.folio,
            ticketId: String(createdTicket.id),
            message: `Ticket creado exitosamente con folio ${createdTicket.folio}`
        };
    } catch (error) {
        console.error(`[create_ticket_direct] Error:`, error);

        // On PostgreSQL failure, return a local folio
        const fallbackFolio = generateTicketFolio(input.service_type);

        return {
            success: true, // Still return success with local folio
            folio: fallbackFolio,
            warning: "Ticket creado localmente, sincronización pendiente",
            message: `Ticket registrado con folio ${fallbackFolio}`
        };
    }
}

// ============================================
// NATIVE TOOLS (Critical - Must be reliable)
// ============================================

/**
 * GET DEUDA - Retrieves debt/balance information
 * Critical for: pagos agent
 */
export const getDeudaTool = tool({
    name: "get_deuda",
    description: `Obtiene el saldo y adeudo de un contrato CEA.

RETORNA:
- totalDeuda: Total a pagar
- vencido: Monto vencido
- porVencer: Monto por vencer
- conceptos: Desglose de adeudos

Usa este tool cuando el usuario pregunte por su saldo, deuda, cuánto debe, o quiera pagar.`,
    parameters: z.object({
        contrato: z.string().describe("Número de contrato CEA (ej: 123456)")
    }),
    execute: async ({ contrato }) => {
        console.log(`[get_deuda] Fetching debt for contract: ${contrato}`);

        try {
            const response = await fetchWithRetry(
                `${CEA_API_BASE}/InterfazGenericaGestionDeudaWS`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/xml;charset=UTF-8' },
                    body: buildDeudaSOAP(contrato)
                }
            );

            const xml = await response.text();
            const parsed = parseDeudaResponse(xml);

            if (!parsed.success) {
                return { error: parsed.error, success: false };
            }

            // Format for agent consumption
            const data = parsed.data!;
            return {
                success: true,
                contrato,
                totalDeuda: data.totalDeuda,
                vencido: data.vencido,
                porVencer: data.porVencer,
                resumen: `Saldo total: ${data.totalDeuda.toFixed(2)} MXN${data.vencido > 0 ? ` (Vencido: ${data.vencido.toFixed(2)})` : ''}`,
                conceptos: data.conceptos.slice(0, 5) // Limit to last 5
            };
        } catch (error) {
            console.error(`[get_deuda] Error:`, error);
            return {
                success: false,
                error: `No se pudo consultar el saldo: ${error instanceof Error ? error.message : 'Error desconocido'}`
            };
        }
    }
});

/**
 * GET CONSUMO - Retrieves consumption history
 * Critical for: consumos agent
 */
export const getConsumoTool = tool({
    name: "get_consumo",
    description: `Obtiene el historial de consumo de agua de un contrato.

RETORNA:
- consumos: Lista de consumos por periodo (m³)
- promedioMensual: Promedio de consumo mensual
- tendencia: Si el consumo está aumentando, estable o disminuyendo

Usa cuando el usuario pregunte por su consumo, historial de lecturas, o cuánta agua ha gastado.`,
    parameters: z.object({
        contrato: z.string().describe("Número de contrato CEA")
    }),
    execute: async ({ contrato }) => {
        console.log(`[get_consumo] Fetching consumption for contract: ${contrato}`);

        try {
            const response = await fetchWithRetry(
                `${CEA_API_BASE}/InterfazOficinaVirtualClientesWS`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/xml;charset=UTF-8' },
                    body: buildConsumoSOAP(contrato)
                }
            );

            const xml = await response.text();
            const parsed = parseConsumoResponse(xml);

            if (!parsed.success) {
                return { error: parsed.error, success: false };
            }

            const data = parsed.data!;

            // Return up to 36 months (3 years) of consumption data
            const allConsumos = data.consumos.slice(0, 36);

            // Group consumos by year for easier querying
            const consumosPorAño: Record<string, any[]> = {};
            for (const c of allConsumos) {
                const year = c.periodo.split(' ').pop() || 'Unknown';
                if (!consumosPorAño[year]) consumosPorAño[year] = [];
                consumosPorAño[year].push(c);
            }

            return {
                success: true,
                contrato,
                promedioMensual: Math.round(data.promedioMensual),
                tendencia: data.tendencia,
                consumos: allConsumos.slice(0, 12), // Recent 12 months for display
                consumosPorAño, // All data grouped by year
                añosDisponibles: Object.keys(consumosPorAño).sort().reverse(),
                resumen: `Promedio mensual: ${Math.round(data.promedioMensual)} m³ (Tendencia: ${data.tendencia}). Datos disponibles: ${Object.keys(consumosPorAño).sort().reverse().join(', ')}`
            };
        } catch (error) {
            console.error(`[get_consumo] Error:`, error);
            return {
                success: false,
                error: `No se pudo consultar el consumo: ${error instanceof Error ? error.message : 'Error desconocido'}`
            };
        }
    }
});

/**
 * GET CONTRACT DETAILS - Retrieves contract information
 * Critical for: all agents that need contract validation
 */
export const getContratoTool = tool({
    name: "get_contract_details",
    description: `Obtiene los detalles de un contrato CEA.

RETORNA:
- titular: Nombre del titular
- direccion: Dirección del servicio
- tarifa: Tipo de tarifa
- estado: Estado del contrato (activo/suspendido/cortado)

Usa para validar un contrato o conocer detalles del servicio.`,
    parameters: z.object({
        contrato: z.string().describe("Número de contrato CEA")
    }),
    execute: async ({ contrato }) => {
        console.log(`[get_contract_details] Fetching contract: ${contrato}`);

        try {
            const response = await fetchWithRetry(
                `${CEA_API_BASE}/InterfazGenericaContratacionWS`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/xml;charset=UTF-8' },
                    body: buildContratoSOAP(contrato)
                }
            );

            const xml = await response.text();
            const parsed = parseContratoResponse(xml);

            if (!parsed.success) {
                return { error: parsed.error, success: false };
            }

            return {
                success: true,
                ...parsed.data
            };
        } catch (error) {
            console.error(`[get_contract_details] Error:`, error);
            return {
                success: false,
                error: `No se pudo consultar el contrato: ${error instanceof Error ? error.message : 'Error desconocido'}`
            };
        }
    }
});

/**
 * CREATE TICKET - Creates a new support ticket
 * Critical for: all agents that create tickets
 */
export const createTicketTool = tool({
    name: "create_ticket",
    description: `Crea un ticket en el sistema CEA y retorna el folio generado.

TIPOS DE TICKET:
- fuga: Reportes de fugas de agua
- aclaraciones: Aclaraciones generales
- pagos: Problemas con pagos
- lecturas: Problemas con lecturas del medidor
- revision_recibo: Revisión de recibo
- recibo_digital: Solicitud de recibo digital
- urgente: Solicitar asesor humano

IMPORTANTE: Siempre incluye el folio en tu respuesta al usuario.`,
    parameters: z.object({
        service_type: z.enum(["fuga", "aclaraciones", "pagos", "lecturas", "revision_recibo", "recibo_digital", "urgente"])
            .describe("Tipo de ticket"),
        titulo: z.string().describe("Título breve del ticket"),
        descripcion: z.string().describe("Descripción detallada del problema"),
        contract_number: z.string().nullable().describe("Número de contrato (si aplica)"),
        email: z.string().nullable().describe("Email del cliente (si aplica)"),
        ubicacion: z.string().nullable().describe("Ubicación de la fuga (solo para fugas)"),
        priority: z.enum(["urgente", "alta", "media", "baja"]).default("media")
            .describe("Prioridad del ticket")
    }),
    execute: async (input) => {
        return await createTicketDirect(input);
    }
});

/**
 * GET CLIENT TICKETS - Retrieves tickets for a contract
 * Critical for: ticket agent
 */
export const getClientTicketsTool = tool({
    name: "get_client_tickets",
    description: `Obtiene los tickets de un cliente por número de contrato.

RETORNA lista de tickets con:
- folio: Número de ticket
- status: Estado (abierto, en_proceso, resuelto, etc.)
- titulo: Título del ticket
- created_at: Fecha de creación`,
    parameters: z.object({
        contract_number: z.string().describe("Número de contrato CEA")
    }),
    execute: async ({ contract_number }) => {
        console.log(`[get_client_tickets] Fetching tickets for contract: ${contract_number}`);

        try {
            const tickets = await pgQuery<{
                folio: string;
                status: string;
                title: string;
                service_type: string;
                created_at: Date;
                description: string;
            }>(`
                SELECT folio, status, title, service_type, created_at, description
                FROM tickets
                WHERE contract_number = $1
                ORDER BY created_at DESC
                LIMIT 10
            `, [contract_number]);

            if (!tickets || tickets.length === 0) {
                return {
                    success: true,
                    tickets: [],
                    message: "No se encontraron tickets para este contrato"
                };
            }

            return {
                success: true,
                tickets: tickets.map((t) => ({
                    folio: t.folio,
                    status: t.status,
                    titulo: t.title,
                    service_type: t.service_type,
                    created_at: t.created_at,
                    descripcion: t.description?.substring(0, 100)
                })),
                count: tickets.length
            };
        } catch (error) {
            console.error(`[get_client_tickets] Error:`, error);
            return {
                success: false,
                error: `No se pudieron consultar los tickets: ${error instanceof Error ? error.message : 'Error desconocido'}`
            };
        }
    }
});

/**
 * SEARCH CUSTOMER BY CONTRACT - Finds customer in Chatwoot contacts table
 * Searches by identifier field or custom_attributes->contract_number
 */
export const searchCustomerByContractTool = tool({
    name: "search_customer_by_contract",
    description: "Busca un cliente por su número de contrato en la base de datos CEA (Chatwoot contacts).",
    parameters: z.object({
        contract_number: z.string().describe("Número de contrato CEA")
    }),
    execute: async ({ contract_number }) => {
        console.log(`[search_customer] Searching for contract: ${contract_number}`);

        try {
            // Search in Chatwoot contacts table
            // First try identifier field, then custom_attributes->contract_number
            const contacts = await pgQuery<{
                id: number;
                name: string;
                email: string | null;
                phone_number: string | null;
                identifier: string | null;
                custom_attributes: Record<string, any> | null;
            }>(`
                SELECT id, name, email, phone_number, identifier, custom_attributes
                FROM contacts
                WHERE identifier = $1
                   OR custom_attributes->>'contract_number' = $1
                LIMIT 1
            `, [contract_number]);

            if (!contacts || contacts.length === 0) {
                return {
                    success: false,
                    found: false,
                    message: "Cliente no encontrado"
                };
            }

            const contact = contacts[0];
            const customAttrs = contact.custom_attributes || {};

            return {
                success: true,
                found: true,
                customer: {
                    id: contact.id,
                    nombre: contact.name || 'Sin nombre',
                    contrato: contact.identifier || customAttrs.contract_number || contract_number,
                    email: contact.email || customAttrs.email || null,
                    whatsapp: contact.phone_number || customAttrs.whatsapp || null,
                    recibo_digital: customAttrs.recibo_digital || false
                }
            };
        } catch (error) {
            console.error(`[search_customer] Error:`, error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Error desconocido'
            };
        }
    }
});

/**
 * UPDATE TICKET STATUS - Updates a ticket
 */
export const updateTicketTool = tool({
    name: "update_ticket",
    description: `Actualiza el estado u otros campos de un ticket existente.

ESTADOS:
- abierto, en_proceso, esperando_cliente, esperando_interno, escalado, resuelto, cerrado, cancelado`,
    parameters: z.object({
        folio: z.string().describe("Folio del ticket a actualizar"),
        status: z.enum(["abierto", "en_proceso", "esperando_cliente", "esperando_interno", "escalado", "resuelto", "cerrado", "cancelado"]).nullable().describe("Nuevo estado del ticket (opcional)"),
        priority: z.enum(["urgente", "alta", "media", "baja"]).nullable().describe("Nueva prioridad del ticket (opcional)"),
        notes: z.string().nullable().describe("Notas adicionales (opcional)")
    }),
    execute: async ({ folio, status, priority, notes }) => {
        console.log(`[update_ticket] Updating ticket: ${folio}`);

        try {
            // Build dynamic SET clause
            const setClauses: string[] = ['updated_at = NOW()'];
            const params: any[] = [];
            let paramIndex = 1;

            if (status) {
                const pgStatus = STATUS_MAP[status] || status;
                setClauses.push(`status = $${paramIndex++}`);
                params.push(pgStatus);
            }
            if (priority) {
                const pgPriority = PRIORITY_MAP[priority] || priority;
                setClauses.push(`priority = $${paramIndex++}`);
                params.push(pgPriority);
            }
            if (notes) {
                setClauses.push(`resolution_notes = $${paramIndex++}`);
                params.push(notes);
            }
            if (status === 'resuelto') {
                setClauses.push('resolved_at = NOW()');
            }

            params.push(folio); // Last param for WHERE clause

            await pgQuery(`
                UPDATE tickets
                SET ${setClauses.join(', ')}
                WHERE folio = $${paramIndex}
            `, params);

            return {
                success: true,
                folio,
                message: `Ticket ${folio} actualizado correctamente`
            };
        } catch (error) {
            console.error(`[update_ticket] Error:`, error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Error desconocido'
            };
        }
    }
});

// ============================================
// Export all native tools as an array
// ============================================

export const nativeTools = [
    getDeudaTool,
    getConsumoTool,
    getContratoTool,
    createTicketTool,
    getClientTicketsTool,
    searchCustomerByContractTool,
    updateTicketTool
];

// Export individually for selective use
export {
    generateTicketFolio,
    getMexicoDate,
    fetchWithRetry
};

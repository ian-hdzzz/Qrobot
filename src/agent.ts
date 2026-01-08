// ============================================
// CEA Agent System - Production Ready v2.0
// ============================================

import { Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";
import { z } from "zod";
import type { WorkflowInput, WorkflowOutput, Classification } from "./types.js";
import {
    getDeudaTool,
    getConsumoTool,
    getContratoTool,
    createTicketTool,
    getClientTicketsTool,
    searchCustomerByContractTool,
    updateTicketTool,
    generateTicketFolio,
    getMexicoDate,
    createTicketDirect
} from "./tools.js";
import { runWithChatwootContext, getCurrentChatwootContext, type ChatwootContext } from "./context.js";

// Re-export for external use
export { getCurrentChatwootContext };

// ============================================
// Configuration
// ============================================

const MODELS = {
    CLASSIFIER: "gpt-4.1-mini",
    SPECIALIST: "gpt-4.1",
    INFO: "gpt-4.1-mini"
} as const;

// ============================================
// Conversation Store (Production: use Redis)
// ============================================

interface ConversationEntry {
    history: AgentInputItem[];
    lastAccess: Date;
    contractNumber?: string;
    classification?: Classification;
    // Chatwoot integration fields for linking tickets
    chatwootConversationId?: number;
    chatwootContactId?: number;
    chatwootInboxId?: number;
}

const conversationStore = new Map<string, ConversationEntry>();

// Cleanup old conversations (1 hour expiry)
setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of conversationStore.entries()) {
        if (now - entry.lastAccess.getTime() > 3600000) {
            conversationStore.delete(id);
        }
    }
}, 300000); // Check every 5 minutes

function getConversation(id: string): ConversationEntry {
    const existing = conversationStore.get(id);
    if (existing) {
        existing.lastAccess = new Date();
        return existing;
    }
    
    const newEntry: ConversationEntry = {
        history: [],
        lastAccess: new Date()
    };
    conversationStore.set(id, newEntry);
    return newEntry;
}

// ============================================
// Agent Schemas
// ============================================

const ClassificationSchema = z.object({
    classification: z.enum([
        "fuga",
        "pagos",
        "hablar_asesor",
        "informacion",
        "consumos",
        "contrato",
        "tickets"
    ]),
    confidence: z.number().min(0).max(1).nullable().describe("Confidence score for classification (optional)"),
    extractedContract: z.string().nullable().describe("Extracted contract number if found (optional)")
});

// ============================================
// System Context Builder
// ============================================

function buildSystemContext(): string {
    const now = getMexicoDate();
    const dateStr = now.toLocaleDateString('es-MX', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
    const timeStr = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    
    return `[Fecha: ${dateStr}, Hora: ${timeStr} (hora de Querétaro)]`;
}

// ============================================
// Classification Agent
// ============================================

const classificationAgent = new Agent({
    name: "Clasificador María",
    model: MODELS.CLASSIFIER,
    instructions: `Eres el clasificador de intenciones para CEA Querétaro. Tu trabajo es categorizar cada mensaje.

CATEGORÍAS:
- "fuga": Fugas de agua, inundaciones, falta de servicio, emergencias
- "pagos": Consultar saldo, deuda, cómo pagar, dónde pagar, recibo digital
- "consumos": Consultar consumo, historial de lecturas, medidor
- "contrato": Nuevo contrato, cambio de titular, datos del contrato
- "tickets": Ver estado de tickets, dar seguimiento a reportes
- "hablar_asesor": Solicitar hablar con una persona real
- "informacion": Todo lo demás (horarios, oficinas, trámites, saludos, etc.)

REGLAS:
1. Si menciona "fuga", "no hay agua", "inundación" → fuga
2. Si menciona "deuda", "saldo", "pagar", "recibo digital" → pagos  
3. Si menciona "consumo", "lectura", "medidor", "cuánta agua" → consumos
4. Si menciona "contrato", "nuevo servicio", "cambio de nombre" → contrato
5. Si pregunta por estado de un reporte o ticket → tickets
6. Si quiere "hablar con alguien", "asesor", "persona real" → hablar_asesor
7. Saludos simples como "hola" sin más contexto → informacion

Si detectas un número de contrato (6+ dígitos), extráelo en extractedContract.`,
    outputType: ClassificationSchema,
    modelSettings: {
        temperature: 0.3,
        maxTokens: 256
    }
});

// ============================================
// Information Agent (General queries)
// ============================================

const informacionAgent = new Agent({
    name: "María - Información",
    model: MODELS.INFO,
    instructions: `Eres María, asistente virtual de la CEA Querétaro. 

Tu rol es responder preguntas generales sobre servicios CEA.

ESTILO:
- Tono cálido y profesional
- Respuestas cortas y directas
- Máximo 1 pregunta por respuesta
- Usa máximo 1 emoji por mensaje (💧 preferido)

SI PREGUNTAN "¿QUÉ PUEDES HACER?":
"Soy María, tu asistente de la CEA 💧 Puedo ayudarte con:
• Consultar tu saldo y pagos
• Ver tu historial de consumo
• Reportar fugas
• Dar seguimiento a tus tickets
• Información de trámites y oficinas"

INFORMACIÓN DE PAGOS:
- Pagar en línea en cea.gob.mx
- Bancos y Oxxo con el recibo
- Oficinas CEA
- Los pagos pueden tardar 48 hrs en reflejarse

OFICINAS CEA:
- Horario: Lunes a Viernes 8:00-16:00
- Oficina central: Centro, Querétaro

CONTRATOS NUEVOS (documentos):
1. Identificación oficial
2. Documento de propiedad del predio
3. Carta poder (si no es el propietario)
Costo: $175 + IVA

CAMBIO DE TITULAR:
1. Número de contrato
2. Documento de propiedad
3. Identificación oficial

NO debes:
- Confirmar datos específicos de cuentas
- Hacer ajustes o descuentos
- Levantar reportes (eso lo hacen otros agentes)`,
    tools: [],
    modelSettings: {
        temperature: 0.7,
        maxTokens: 512
    }
});

// ============================================
// Pagos Agent (Payments, debt, digital receipt)
// ============================================

const pagosAgent = new Agent({
    name: "María - Pagos",
    model: MODELS.SPECIALIST,
    instructions: `Eres María, especialista en pagos y adeudos de CEA Querétaro.

FLUJO PARA CONSULTA DE SALDO:
1. Si no tienes contrato, pregunta: "¿Me proporcionas tu número de contrato?"
2. Usa get_deuda para obtener el saldo
3. Presenta el resultado de forma clara

FLUJO PARA RECIBO DIGITAL:
1. Pregunta: "¿Me confirmas tu número de contrato y correo electrónico?"
2. Cuando tengas ambos, crea ticket con create_ticket:
   - service_type: "recibo_digital"
   - titulo: "Cambio a recibo digital - Contrato [X]"
   - descripcion: Incluir contrato y email
3. Confirma con el folio: "Listo, solicitud registrada con folio [FOLIO]. Tu recibo llegará a [email] 💧"

FORMAS DE PAGO:
- En línea: cea.gob.mx
- Oxxo: con tu recibo
- Bancos autorizados
- Cajeros CEA
- Oficinas CEA

IMPORTANTE:
- Un número de contrato tiene típicamente 6-10 dígitos
- Siempre confirma el folio cuando crees un ticket
- Sé conciso, una pregunta a la vez`,
    tools: [getDeudaTool, getContratoTool, createTicketTool, searchCustomerByContractTool],
    modelSettings: {
        temperature: 0.5,
        maxTokens: 1024
    }
});

// ============================================
// Consumos Agent (Consumption history)
// ============================================

const consumosAgent = new Agent({
    name: "María - Consumos",
    model: MODELS.SPECIALIST,
    instructions: `Eres María, especialista en consumo de agua de CEA Querétaro.

FLUJO:
1. Solicita número de contrato si no lo tienes
2. Usa get_consumo para obtener historial
3. Presenta los datos claramente

CÓMO PRESENTAR CONSUMOS:
"Tu historial de consumo 💧
• [Mes]: [X] m³
• [Mes]: [X] m³
Promedio mensual: [X] m³"

SI EL USUARIO DISPUTA UN CONSUMO:
1. Recaba: contrato, mes(es) en disputa, descripción del problema
2. Crea ticket con create_ticket:
   - service_type: "lecturas" (si es problema de medidor)
   - service_type: "revision_recibo" (si quiere revisión del recibo)
3. Confirma con el folio

NOTA: Si el consumo es muy alto, sugiere:
- Revisar instalaciones internas
- Verificar si hay fugas en casa
- Si persiste, abrir un ticket de revisión`,
    tools: [getConsumoTool, getContratoTool, createTicketTool],
    modelSettings: {
        temperature: 0.5,
        maxTokens: 1024
    }
});

// ============================================
// Fugas Agent (Water leaks)
// ============================================

const fugasAgent = new Agent({
    name: "María - Fugas",
    model: MODELS.SPECIALIST,
    instructions: `Eres María, especialista en reportes de fugas de CEA Querétaro.

INFORMACIÓN NECESARIA PARA UN REPORTE:
1. Ubicación exacta (calle, número, colonia, referencias)
2. Tipo de fuga: vía pública o dentro de propiedad
3. Gravedad: ¿Es mucha agua? ¿Hay inundación?

FLUJO:
- Pregunta UNA cosa a la vez
- Si te envían foto, úsala para entender la situación
- Cuando tengas ubicación + tipo + gravedad, crea el ticket

CREAR TICKET:
Usa create_ticket con:
- service_type: "fuga"
- titulo: "Fuga en [vía pública/propiedad] - [Colonia]"
- descripcion: Toda la información recabada
- ubicacion: La dirección exacta
- priority: "urgente" si hay inundación, "alta" si es considerable

RESPUESTA DESPUÉS DE CREAR:
"He registrado tu reporte con el folio [FOLIO] 💧
Un equipo de CEA acudirá a la ubicación lo antes posible."

NO pidas número de contrato para fugas en vía pública.
SÍ pide contrato si la fuga es dentro de la propiedad.`,
    tools: [createTicketTool],
    modelSettings: {
        temperature: 0.5,
        maxTokens: 1024
    }
});

// ============================================
// Contratos Agent (Contract management)
// ============================================

const contratosAgent = new Agent({
    name: "María - Contratos",
    model: MODELS.SPECIALIST,
    instructions: `Eres María, especialista en contratos de CEA Querétaro.

PARA CONTRATO NUEVO:
Documentos requeridos:
1. Identificación oficial
2. Documento que acredite propiedad del predio
3. Carta poder simple (si no es el propietario)

Costo: $175 + IVA

Responde: "Para un contrato nuevo necesitas traer a oficinas CEA:
• Identificación oficial
• Comprobante de propiedad
• Carta poder (si aplica)
El costo es $175 + IVA 💧"

PARA CAMBIO DE TITULAR:
1. Pregunta el número de contrato actual
2. Usa get_contract_details para verificar
3. Indica documentos:
   - Identificación oficial del nuevo titular
   - Documento de propiedad a nombre del nuevo titular
   - El trámite se realiza en oficinas CEA

PARA CONSULTA DE DATOS:
- Pide el número de contrato
- Usa get_contract_details
- Presenta: titular, dirección, estado del servicio`,
    tools: [getContratoTool, searchCustomerByContractTool],
    modelSettings: {
        temperature: 0.5,
        maxTokens: 1024
    }
});

// ============================================
// Tickets Agent (Ticket tracking)
// ============================================

const ticketsAgent = new Agent({
    name: "María - Tickets",
    model: MODELS.SPECIALIST,
    instructions: `Eres María, especialista en seguimiento de tickets de CEA Querétaro.

FLUJO:
1. Solicita número de contrato
2. Usa get_client_tickets para buscar tickets
3. Presenta los resultados

FORMATO DE PRESENTACIÓN:
"Encontré [N] ticket(s) para tu contrato 💧

📋 Ticket: [FOLIO]
Estado: [status]
Tipo: [tipo]
Fecha: [fecha]
[descripción breve]"

ESTADOS DE TICKET:
- abierto: Recién creado
- en_proceso: Un agente lo está atendiendo
- esperando_cliente: Necesitamos información tuya
- resuelto: Ya se atendió
- cerrado: Caso finalizado

Si el usuario quiere actualizar un ticket, recaba la información y usa update_ticket.

IMPORTANTE:
- NO narres tu proceso de búsqueda ("intentando", "probando")
- Ve directo al resultado
- Si no hay tickets: "No encontré tickets activos para este contrato"`,
    tools: [getClientTicketsTool, searchCustomerByContractTool, updateTicketTool],
    modelSettings: {
        temperature: 0.5,
        maxTokens: 1024
    }
});

// ============================================
// Agent Router Map
// ============================================

const agentMap: Record<Classification, Agent<any>> = {
    fuga: fugasAgent,
    pagos: pagosAgent,
    consumos: consumosAgent,
    contrato: contratosAgent,
    tickets: ticketsAgent,
    informacion: informacionAgent,
    hablar_asesor: informacionAgent // Handled specially
};

// ============================================
// Runner with Auto-Approval
// ============================================

async function runAgentWithApproval(
    runner: Runner,
    agent: Agent<any>,
    history: AgentInputItem[]
): Promise<{ output: string; newItems: AgentInputItem[]; toolsUsed: string[] }> {
    const result = await runner.run(agent, history);
    const toolsUsed: string[] = [];

    // Extract tool usage from new items
    for (const item of result.newItems) {
        const rawItem = (item as any).rawItem || item;
        if (rawItem.type === "hosted_tool_call" && rawItem.name) {
            toolsUsed.push(rawItem.name);
        }
    }

    // Extract output
    let output = result.finalOutput;

    if (!output) {
        // Try to find last assistant message
        for (let i = result.newItems.length - 1; i >= 0; i--) {
            const rawItem = (result.newItems[i] as any).rawItem || result.newItems[i];
            if (rawItem.role === 'assistant' && rawItem.content) {
                if (typeof rawItem.content === 'string') {
                    output = rawItem.content;
                    break;
                } else if (Array.isArray(rawItem.content)) {
                    output = rawItem.content.map((c: any) => c.text || c.output_text || '').filter(Boolean).join('');
                    if (output) break;
                }
            }
        }
    }

    // Collect new items for history
    const newItems = result.newItems.map((item: any) => (item as any).rawItem || item);

    return { output: output || '', newItems, toolsUsed };
}

// ============================================
// Main Workflow Function
// ============================================

export async function runWorkflow(input: WorkflowInput): Promise<WorkflowOutput> {
    const startTime = Date.now();
    const conversationId = input.conversationId || crypto.randomUUID();

    // Extract Chatwoot context for linking tickets
    // conversationId from Chatwoot is passed as string but may be numeric
    const chatwootConversationId = input.conversationId ? parseInt(input.conversationId, 10) : undefined;
    const chatwootContext: ChatwootContext = {
        conversationId: !isNaN(chatwootConversationId!) ? chatwootConversationId : undefined,
        contactId: input.contactId
    };

    if (chatwootContext.conversationId || chatwootContext.contactId) {
        console.log(`[Workflow] Chatwoot context: conversation=${chatwootContext.conversationId}, contact=${chatwootContext.contactId}`);
    }

    // Run workflow within Chatwoot context so tools can access it
    return await runWithChatwootContext(chatwootContext, async () => {
        return await withTrace("María-CEA-v2", async () => {
            console.log(`\n========== WORKFLOW START ==========`);
            console.log(`ConversationId: ${conversationId}`);
            console.log(`Input: "${input.input_as_text}"`);

            // Get or create conversation
            const conversation = getConversation(conversationId);

            // Store Chatwoot IDs in conversation for persistence
            if (chatwootContext.conversationId) conversation.chatwootConversationId = chatwootContext.conversationId;
            if (chatwootContext.contactId) conversation.chatwootContactId = chatwootContext.contactId;

            // Build context-enhanced input
            const contextualInput = `${buildSystemContext()}\n${input.input_as_text}`;
        
        // Add user message to history
        const userMessage: AgentInputItem = {
            role: "user",
            content: [{ type: "input_text", text: contextualInput }]
        };
        
        const workingHistory: AgentInputItem[] = [...conversation.history, userMessage];
        const toolsUsed: string[] = [];
        
        // Create runner
        const runner = new Runner({
            traceMetadata: {
                __trace_source__: "cea-agent-v2",
                conversation_id: conversationId
            }
        });
        
        try {
            // Step 1: Classification
            console.log(`[Workflow] Running classification...`);
            const classificationResult = await runner.run(classificationAgent, workingHistory);
            
            if (!classificationResult.finalOutput) {
                throw new Error("Classification failed - no output");
            }
            
            const classification = classificationResult.finalOutput.classification as Classification;
            const extractedContract = classificationResult.finalOutput.extractedContract;
            
            console.log(`[Workflow] Classification: ${classification}`);
            if (extractedContract) {
                console.log(`[Workflow] Extracted contract: ${extractedContract}`);
                conversation.contractNumber = extractedContract;
            }
            
            // Save classification to conversation
            conversation.classification = classification;
            
            let output: string;
            let newItems: AgentInputItem[] = [];
            
            // Step 2: Handle special case - hablar_asesor
            if (classification === "hablar_asesor") {
                console.log(`[Workflow] Creating urgent ticket for human advisor`);

                // Create ticket and wait for it (to get proper folio)
                const ticketResult = await createTicketDirect({
                    service_type: "urgente",
                    titulo: "Solicitud de contacto con asesor humano",
                    descripcion: `El usuario solicitó hablar con un asesor humano. Mensaje original: ${input.input_as_text}`,
                    contract_number: conversation.contractNumber || null,
                    email: null,
                    ubicacion: null,
                    priority: "urgente"
                });

                const folio = ticketResult.folio || "PENDING";
                output = `He creado tu solicitud con el folio ${folio}. Te conectaré con un asesor humano. Por favor espera un momento 💧`;

                toolsUsed.push("create_ticket");

            } else {
                // Step 3: Route to specialized agent
                const selectedAgent = agentMap[classification];
                console.log(`[Workflow] Routing to: ${selectedAgent.name}`);
                
                const agentResult = await runAgentWithApproval(runner, selectedAgent, workingHistory);
                
                output = agentResult.output;
                newItems = agentResult.newItems;
                toolsUsed.push(...agentResult.toolsUsed);
            }
            
            // Step 4: Update conversation history
            conversation.history.push(userMessage);
            if (newItems.length > 0) {
                conversation.history.push(...newItems);
            } else if (output) {
                // Add assistant response to history
                conversation.history.push({
                    role: "assistant",
                    content: [{ type: "output_text", text: output }]
                } as any);
            }
            
            // Limit history length (keep last 20 messages)
            if (conversation.history.length > 20) {
                conversation.history = conversation.history.slice(-20);
            }
            
            const processingTime = Date.now() - startTime;
            console.log(`[Workflow] Complete in ${processingTime}ms`);
            console.log(`[Workflow] Output: "${output.substring(0, 100)}..."`);
            console.log(`========== WORKFLOW END ==========\n`);
            
            return {
                output_text: output,
                classification,
                toolsUsed
            };
            
        } catch (error) {
            console.error(`[Workflow] Error:`, error);

            return {
                output_text: "Lo siento, tuve un problema procesando tu mensaje. ¿Podrías intentar de nuevo? 💧",
                error: error instanceof Error ? error.message : "Unknown error",
                toolsUsed
            };
        }
        });
    });
}

// ============================================
// Health Check for Agents
// ============================================

export function getAgentHealth(): { status: string; agents: string[]; conversationCount: number } {
    return {
        status: "healthy",
        agents: [
            classificationAgent.name,
            informacionAgent.name,
            pagosAgent.name,
            consumosAgent.name,
            fugasAgent.name,
            contratosAgent.name,
            ticketsAgent.name
        ],
        conversationCount: conversationStore.size
    };
}

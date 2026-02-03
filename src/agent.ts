// ============================================
// Santiago - Gobierno de Querétaro Agent System v1.0
// ============================================

import { Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";
import { z } from "zod";
import type { WorkflowInput, WorkflowOutput, Classification, CeaSubClassification } from "./types.js";
import {
    getDeudaTool,
    getConsumoTool,
    getContratoTool,
    createTicketTool,
    createGeneralTicketTool,
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
// Santiago Welcome Message
// ============================================

const SANTIAGO_WELCOME_MESSAGE = `Hola 👋 Soy *Santiago*, tu asistente del Gobierno del Estado de Querétaro.

Selecciona una opción o dime en qué te puedo ayudar:

1. Atención Ciudadana
2. Transporte Público - AMEQ 🚌
3. Servicios de Agua Potable - CEA 💧
4. Educación Básica - USEBEQ
5. Trámites Vehiculares 🚗
6. Atención Psicológica - SEJUVE
7. Atención a Mujeres - IQM
8. Cultura - Secretaría de Cultura 🎭
9. Registro Público - RPP
10. Conciliación Laboral - CCLQ
11. Instituto de la Vivienda - IVEQ 🏠
12. Atención APPQRO 📱
13. Programas Sociales - SEDESOQ
14. Hablar con un asesor 💬`;

// ============================================
// Conversation Store (Production: use Redis)
// ============================================

interface ConversationEntry {
    history: AgentInputItem[];
    lastAccess: Date;
    contractNumber?: string;
    classification?: Classification;
    // Active flow tracking - keeps user in current flow until it finishes
    activeFlow?: Classification;
    activeCeaSubType?: CeaSubClassification;
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
}, 300000);

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
        "atencion_ciudadana",
        "transporte_ameq",
        "agua_cea",
        "educacion_usebeq",
        "tramites_vehiculares",
        "psicologia_sejuve",
        "mujeres_iqm",
        "cultura",
        "registro_publico_rpp",
        "conciliacion_cclq",
        "vivienda_iveq",
        "appqro",
        "programas_sedesoq",
        "hablar_asesor",
        "tickets"
    ]),
    confidence: z.number().min(0).max(1).nullable().describe("Confidence score"),
    extractedContract: z.string().nullable().describe("Numero de contrato extraido si se encuentra"),
    ceaSubType: z.enum(["fuga", "pagos", "consumos", "contrato", "informacion_cea"]).nullable()
        .describe("Solo cuando classification=agua_cea. Sub-tipo de servicio CEA.")
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

    return `[Fecha: ${dateStr}, Hora: ${timeStr} (hora de Queretaro)]`;
}

// ============================================
// Classification Agent
// ============================================

const classificationAgent = new Agent({
    name: "Santiago - Clasificador",
    model: MODELS.CLASSIFIER,
    instructions: `Eres el clasificador de intenciones para Santiago, el asistente del Gobierno del Estado de Queretaro.

CATEGORIAS:
- "atencion_ciudadana": Quejas generales, denuncias ciudadanas, servicios gubernamentales generales, saludos sin contexto
- "transporte_ameq": Transporte publico, rutas de camion, horarios AMEQ, tarjetas de transporte, QroBus
- "agua_cea": TODO sobre agua potable: fugas, pagos de agua, consumo, contratos de agua, recibos de agua, medidores, CEA
- "educacion_usebeq": Inscripciones escolares, becas educativas, escuelas publicas, USEBEQ
- "tramites_vehiculares": Licencias de conducir, placas, tenencia, verificacion vehicular, multas de transito
- "psicologia_sejuve": Atencion psicologica, apoyo emocional, salud mental, jovenes, SEJUVE
- "mujeres_iqm": Violencia de genero, derechos de la mujer, refugios, asesoria legal para mujeres, IQM
- "cultura": Eventos culturales, museos, bibliotecas, talleres artisticos, Secretaria de Cultura
- "registro_publico_rpp": Actas de nacimiento, matrimonio, defuncion, registro de propiedad, escrituras, RPP
- "conciliacion_cclq": Conflictos laborales, despidos, demandas laborales, conciliacion, derechos laborales, CCLQ
- "vivienda_iveq": Creditos de vivienda, programas de vivienda, escrituracion, IVEQ
- "appqro": Aplicacion APPQRO, servicios digitales del gobierno, problemas con la app
- "programas_sedesoq": Programas sociales, apoyos economicos, despensas, becas sociales, SEDESOQ
- "hablar_asesor": Quiere hablar con persona real, asesor humano, operador
- "tickets": Seguimiento a reportes o tickets existentes, consultar folio

SUB-CLASIFICACION CEA (solo cuando classification = "agua_cea"):
- "fuga": Fugas de agua, inundaciones, falta de agua, emergencias hidricas
- "pagos": Saldo, deuda, pagar agua, recibo digital, donde pagar
- "consumos": Consumo de agua, lectura del medidor, historial
- "contrato": Contrato nuevo de agua, cambio de titular
- "informacion_cea": Info general de CEA, horarios, oficinas

SELECCION POR NUMERO:
Si el usuario envia solo un numero (1-14), mapea asi:
1->atencion_ciudadana, 2->transporte_ameq, 3->agua_cea (ceaSubType: informacion_cea),
4->educacion_usebeq, 5->tramites_vehiculares, 6->psicologia_sejuve,
7->mujeres_iqm, 8->cultura, 9->registro_publico_rpp,
10->conciliacion_cclq, 11->vivienda_iveq, 12->appqro,
13->programas_sedesoq, 14->hablar_asesor

REGLAS:
1. Si menciona "agua", "fuga", "recibo de agua", "CEA", "contrato de agua", "medidor" -> agua_cea
2. Si menciona "camion", "ruta", "transporte", "AMEQ", "QroBus" -> transporte_ameq
3. Si menciona "licencia", "placas", "tenencia", "verificacion" -> tramites_vehiculares
4. Si es un saludo simple ("hola", "buenos dias") sin mas contexto -> atencion_ciudadana
5. Si detectas numero de contrato (6+ digitos), extrae en extractedContract
6. Si hay duda entre categorias, usa la mas especifica
7. ceaSubType DEBE ser null cuando classification NO es agua_cea`,
    outputType: ClassificationSchema,
    modelSettings: {
        temperature: 0.3,
        maxTokens: 256
    }
});

// ============================================
// CEA Specialist Agents (existentes, renombrados)
// ============================================

const informacionCeaAgent = new Agent({
    name: "Santiago - CEA Informacion",
    model: MODELS.INFO,
    instructions: `Eres Santiago, asistente del Gobierno de Queretaro, especialista en informacion de la CEA (Comision Estatal de Aguas).

ESTILO:
- Tono profesional y amigable
- Respuestas cortas y directas
- Maximo 1 emoji por mensaje

SI PREGUNTAN QUE PUEDES HACER EN TEMAS DE AGUA:
"Puedo ayudarte con servicios de agua potable (CEA):
- Consultar tu saldo y pagos
- Ver tu historial de consumo
- Reportar fugas
- Dar seguimiento a tus tickets
- Informacion de tramites y oficinas"

INFORMACION DE PAGOS:
- Pagar en linea en cea.gob.mx
- Bancos y Oxxo con el recibo
- Oficinas CEA
- Los pagos pueden tardar 48 hrs en reflejarse

OFICINAS CEA:
- Horario: Lunes a Viernes 8:00-16:00

CONTRATOS NUEVOS (documentos):
1. Identificacion oficial
2. Documento de propiedad del predio
3. Carta poder (si no es el propietario)
Costo: $175 + IVA

CAMBIO DE TITULAR:
1. Numero de contrato
2. Documento de propiedad
3. Identificacion oficial`,
    tools: [],
    modelSettings: {
        temperature: 0.7,
        maxTokens: 512
    }
});

const pagosAgent = new Agent({
    name: "Santiago - CEA Pagos",
    model: MODELS.SPECIALIST,
    instructions: `Eres Santiago, asistente del Gobierno de Queretaro, especialista en pagos y adeudos de CEA.

FLUJO PARA CONSULTA DE SALDO:
1. Si no tienes contrato, pregunta: "Me proporcionas tu numero de contrato de agua?"
2. Usa get_deuda para obtener el saldo
3. Presenta el resultado de forma clara

FLUJO PARA RECIBO DIGITAL:
1. Pregunta: "Me confirmas tu numero de contrato y correo electronico?"
2. Cuando tengas ambos, crea ticket con create_ticket:
   - service_type: "recibo_digital"
   - titulo: "Cambio a recibo digital - Contrato [X]"
   - descripcion: Incluir contrato y email
3. Confirma con el folio

FORMAS DE PAGO:
- En linea: cea.gob.mx
- Oxxo: con tu recibo
- Bancos autorizados
- Cajeros CEA
- Oficinas CEA

IMPORTANTE:
- Un numero de contrato tiene tipicamente 6-10 digitos
- Siempre confirma el folio cuando crees un ticket
- Se conciso, una pregunta a la vez`,
    tools: [getDeudaTool, getContratoTool, createTicketTool, searchCustomerByContractTool],
    modelSettings: {
        temperature: 0.5,
        maxTokens: 1024
    }
});

const consumosAgent = new Agent({
    name: "Santiago - CEA Consumos",
    model: MODELS.SPECIALIST,
    instructions: `Eres Santiago, asistente del Gobierno de Queretaro, especialista en consumo de agua de CEA.

FLUJO:
1. Solicita numero de contrato si no lo tienes
2. Usa get_consumo para obtener historial
3. Presenta los datos claramente

COMO PRESENTAR CONSUMOS:
"Tu historial de consumo:
- [Mes]: [X] m3
- [Mes]: [X] m3
Promedio mensual: [X] m3"

SI EL USUARIO DISPUTA UN CONSUMO:
1. Recaba: contrato, mes(es) en disputa, descripcion del problema
2. Crea ticket con create_ticket:
   - service_type: "lecturas" (si es problema de medidor)
   - service_type: "revision_recibo" (si quiere revision del recibo)
3. Confirma con el folio

NOTA: Si el consumo es muy alto, sugiere:
- Revisar instalaciones internas
- Verificar si hay fugas en casa
- Si persiste, abrir un ticket de revision`,
    tools: [getConsumoTool, getContratoTool, createTicketTool],
    modelSettings: {
        temperature: 0.5,
        maxTokens: 1024
    }
});

const fugasAgent = new Agent({
    name: "Santiago - CEA Fugas",
    model: MODELS.SPECIALIST,
    instructions: `Eres Santiago, asistente del Gobierno de Queretaro, especialista en reportes de fugas de CEA.

INFORMACION NECESARIA PARA UN REPORTE:
1. Ubicacion exacta (calle, numero, colonia, referencias)
2. Tipo de fuga: via publica o dentro de propiedad
3. Gravedad: Es mucha agua? Hay inundacion?

FLUJO:
- Pregunta UNA cosa a la vez
- Cuando tengas ubicacion + tipo + gravedad, crea el ticket

CREAR TICKET:
Usa create_ticket con:
- service_type: "fuga"
- titulo: "Fuga en [via publica/propiedad] - [Colonia]"
- descripcion: Toda la informacion recabada
- ubicacion: La direccion exacta
- priority: "urgente" si hay inundacion, "alta" si es considerable

RESPUESTA DESPUES DE CREAR:
"He registrado tu reporte con el folio [FOLIO]. Un equipo de CEA acudira a la ubicacion lo antes posible."

NO pidas numero de contrato para fugas en via publica.
SI pide contrato si la fuga es dentro de la propiedad.`,
    tools: [createTicketTool],
    modelSettings: {
        temperature: 0.5,
        maxTokens: 1024
    }
});

const contratosAgent = new Agent({
    name: "Santiago - CEA Contratos",
    model: MODELS.SPECIALIST,
    instructions: `Eres Santiago, asistente del Gobierno de Queretaro, especialista en contratos de CEA.

PARA CONTRATO NUEVO:
Documentos requeridos:
1. Identificacion oficial
2. Documento que acredite propiedad del predio
3. Carta poder simple (si no es el propietario)
Costo: $175 + IVA

PARA CAMBIO DE TITULAR:
1. Pregunta el numero de contrato actual
2. Usa get_contract_details para verificar
3. Indica documentos:
   - Identificacion oficial del nuevo titular
   - Documento de propiedad a nombre del nuevo titular
   - El tramite se realiza en oficinas CEA

PARA CONSULTA DE DATOS:
- Pide el numero de contrato
- Usa get_contract_details
- Presenta: titular, direccion, estado del servicio`,
    tools: [getContratoTool, searchCustomerByContractTool],
    modelSettings: {
        temperature: 0.5,
        maxTokens: 1024
    }
});

const ticketsAgent = new Agent({
    name: "Santiago - Tickets",
    model: MODELS.SPECIALIST,
    instructions: `Eres Santiago, asistente del Gobierno de Queretaro, especialista en seguimiento de tickets.

FLUJO:
1. Solicita numero de contrato o folio
2. Usa get_client_tickets para buscar tickets
3. Presenta los resultados

FORMATO DE PRESENTACION:
"Encontre [N] ticket(s):

Ticket: [FOLIO]
Estado: [status]
Tipo: [tipo]
Fecha: [fecha]
[descripcion breve]"

ESTADOS DE TICKET:
- abierto: Recien creado
- en_proceso: Un agente lo esta atendiendo
- esperando_cliente: Necesitamos informacion tuya
- resuelto: Ya se atendio
- cerrado: Caso finalizado

Si el usuario quiere actualizar un ticket, recaba la informacion y usa update_ticket.

IMPORTANTE:
- NO narres tu proceso de busqueda
- Ve directo al resultado
- Si no hay tickets: "No encontre tickets activos para este contrato"`,
    tools: [getClientTicketsTool, searchCustomerByContractTool, updateTicketTool],
    modelSettings: {
        temperature: 0.5,
        maxTokens: 1024
    }
});

// ============================================
// Government Service Agents (nuevos)
// ============================================

const atencionCiudadanaAgent = new Agent({
    name: "Santiago - Atencion Ciudadana",
    model: MODELS.INFO,
    instructions: `Eres Santiago, asistente del Gobierno del Estado de Queretaro, especialista en Atencion Ciudadana.

ESTILO:
- Tono profesional y amigable
- Respuestas concisas
- Maximo 1 emoji por mensaje

SI ES UN SALUDO O PREGUNTA GENERAL:
Presentate brevemente y ofrece los servicios disponibles:
"Soy Santiago, tu asistente del Gobierno de Queretaro. Puedo ayudarte con:
- Agua potable (CEA)
- Transporte publico (AMEQ)
- Educacion (USEBEQ)
- Tramites vehiculares
- Atencion psicologica (SEJUVE)
- Atencion a mujeres (IQM)
- Cultura
- Registro publico (RPP)
- Conciliacion laboral (CCLQ)
- Vivienda (IVEQ)
- APPQRO
- Programas sociales (SEDESOQ)

Dime en que te puedo ayudar."

PARA QUEJAS O DENUNCIAS:
1. Escucha al ciudadano
2. Recaba: descripcion del problema, ubicacion (si aplica), datos de contacto
3. Crea ticket con create_general_ticket (service_type: "atencion_ciudadana")
4. Confirma con folio

LINEA DE ATENCION CIUDADANA: 442 238 5000
PORTAL: queretaro.gob.mx`,
    tools: [createGeneralTicketTool],
    modelSettings: {
        temperature: 0.7,
        maxTokens: 512
    }
});

const transporteAgent = new Agent({
    name: "Santiago - Transporte AMEQ",
    model: MODELS.INFO,
    instructions: `Eres Santiago, asistente del Gobierno de Queretaro, especialista en transporte publico (AMEQ).

INFORMACION CLAVE:
- Rutas y horarios: consultar en la app AMEQ o en ameq.gob.mx
- Tarjeta QroBus: se adquiere en puntos de venta autorizados
- Quejas sobre transporte: crear ticket para seguimiento
- Horario de atencion AMEQ: Lunes a Viernes 9:00-17:00

PARA QUEJAS SOBRE TRANSPORTE:
Recaba: numero de ruta, hora del incidente, descripcion. Crea ticket con create_general_ticket (service_type: "transporte").

Se conciso y profesional.`,
    tools: [createGeneralTicketTool],
    modelSettings: {
        temperature: 0.7,
        maxTokens: 512
    }
});

const educacionAgent = new Agent({
    name: "Santiago - Educacion USEBEQ",
    model: MODELS.INFO,
    instructions: `Eres Santiago, asistente del Gobierno de Queretaro, especialista en educacion basica (USEBEQ).

INFORMACION CLAVE:
- Inscripciones: periodos establecidos por la SEP, consultar usebeq.gob.mx
- Becas: programas de becas estatales y federales disponibles
- Escuelas: directorio en usebeq.gob.mx
- Certificados de estudio: tramite en la delegacion USEBEQ
- Horario: Lunes a Viernes 8:00-16:00

Si el ciudadano necesita seguimiento personalizado, crea ticket con create_general_ticket (service_type: "educacion").`,
    tools: [createGeneralTicketTool],
    modelSettings: {
        temperature: 0.7,
        maxTokens: 512
    }
});

const vehicularAgent = new Agent({
    name: "Santiago - Tramites Vehiculares",
    model: MODELS.INFO,
    instructions: `Eres Santiago, asistente del Gobierno de Queretaro, especialista en tramites vehiculares.

TRAMITES DISPONIBLES:
- Licencia de conducir: requisitos, renovacion, reposicion
- Placas vehiculares: alta, baja, cambio
- Tenencia y refrendo vehicular
- Verificacion vehicular: centros autorizados, calendario
- Tarjeta de circulacion

REQUISITOS GENERALES LICENCIA:
- Identificacion oficial vigente
- Comprobante de domicilio reciente
- CURP
- Aprobar examen teorico y practico
- Examen de la vista

Horario: Lunes a Viernes 8:00-15:00 en modulos de atencion.
Portal: tramites.queretaro.gob.mx

Si necesitan seguimiento, crea ticket con create_general_ticket (service_type: "vehicular").`,
    tools: [createGeneralTicketTool],
    modelSettings: {
        temperature: 0.7,
        maxTokens: 512
    }
});

const psicologiaAgent = new Agent({
    name: "Santiago - Atencion Psicologica SEJUVE",
    model: MODELS.INFO,
    instructions: `Eres Santiago, asistente del Gobierno de Queretaro, especialista en atencion psicologica del SEJUVE.

SERVICIOS:
- Atencion psicologica individual y grupal
- Orientacion para jovenes
- Prevencion de adicciones
- Apoyo en crisis emocional
- Talleres de desarrollo personal

IMPORTANTE - CRISIS EMOCIONAL:
Si detectas una crisis grave o riesgo de autolesion:
- Proporciona la Linea de la Vida: 800 911 2000 (24 hrs)
- Recomienda acudir a urgencias del hospital mas cercano
- Crea ticket URGENTE con create_general_ticket (service_type: "psicologia", priority: "urgente")

Horario SEJUVE: Lunes a Viernes 9:00-17:00
Portal: sejuve.queretaro.gob.mx

Trata estos temas con sensibilidad y empatia.`,
    tools: [createGeneralTicketTool],
    modelSettings: {
        temperature: 0.7,
        maxTokens: 512
    }
});

const mujeresAgent = new Agent({
    name: "Santiago - Atencion a Mujeres IQM",
    model: MODELS.INFO,
    instructions: `Eres Santiago, asistente del Gobierno de Queretaro, especialista en servicios del Instituto Queretano de las Mujeres (IQM).

SERVICIOS:
- Asesoria legal para mujeres
- Atencion a violencia de genero
- Refugio temporal
- Acompanamiento psicologico
- Empoderamiento y capacitacion

EN CASO DE EMERGENCIA POR VIOLENCIA:
- Linea 911 para emergencias inmediatas
- Linea Violeta: 800 108 4053 (24 hrs)
- Crea ticket URGENTE con create_general_ticket (service_type: "atencion_mujeres", priority: "urgente")

Horario IQM: Lunes a Viernes 8:00-16:00
Portal: iqm.queretaro.gob.mx

SENSIBILIDAD: Trata estos temas con extrema empatia y sin juzgar. Siempre prioriza la seguridad.`,
    tools: [createGeneralTicketTool],
    modelSettings: {
        temperature: 0.7,
        maxTokens: 512
    }
});

const culturaAgent = new Agent({
    name: "Santiago - Cultura",
    model: MODELS.INFO,
    instructions: `Eres Santiago, asistente del Gobierno de Queretaro, especialista en cultura.

SERVICIOS:
- Agenda cultural: eventos, exposiciones, conciertos
- Museos estatales: horarios y costos
- Bibliotecas publicas: ubicaciones y horarios
- Talleres artisticos: inscripciones y convocatorias
- Patrimonio cultural: informacion sobre sitios historicos de Queretaro

Portal: cultura.queretaro.gob.mx

Si necesitan informacion especifica o seguimiento, crea ticket con create_general_ticket (service_type: "cultura").`,
    tools: [createGeneralTicketTool],
    modelSettings: {
        temperature: 0.7,
        maxTokens: 512
    }
});

const registroPublicoAgent = new Agent({
    name: "Santiago - Registro Publico RPP",
    model: MODELS.INFO,
    instructions: `Eres Santiago, asistente del Gobierno de Queretaro, especialista en Registro Publico de la Propiedad (RPP).

TRAMITES:
- Registro de escrituras
- Certificados de libertad de gravamen
- Consulta de antecedentes registrales
- Registro de contratos
- Constancias de no propiedad

REQUISITOS GENERALES:
- Escritura publica notariada
- Identificacion oficial
- Pago de derechos correspondiente

Horario: Lunes a Viernes 8:30-15:00

Si necesitan seguimiento, crea ticket con create_general_ticket (service_type: "registro_publico").`,
    tools: [createGeneralTicketTool],
    modelSettings: {
        temperature: 0.7,
        maxTokens: 512
    }
});

const conciliacionAgent = new Agent({
    name: "Santiago - Conciliacion Laboral CCLQ",
    model: MODELS.INFO,
    instructions: `Eres Santiago, asistente del Gobierno de Queretaro, especialista en conciliacion laboral (CCLQ).

SERVICIOS:
- Conciliacion laboral obligatoria (previo a demanda)
- Asesoria en derechos laborales
- Calculo de liquidacion e indemnizacion
- Mediacion entre trabajador y patron

PROCESO:
1. Solicitar cita en CCLQ
2. Presentar documentacion laboral
3. Audiencia de conciliacion
4. Si no hay acuerdo, se emite constancia para demanda

Documentos: Identificacion, comprobante de domicilio, contrato laboral (si existe), recibos de nomina.
Horario: Lunes a Viernes 9:00-15:00

Si necesitan seguimiento, crea ticket con create_general_ticket (service_type: "conciliacion_laboral").`,
    tools: [createGeneralTicketTool],
    modelSettings: {
        temperature: 0.7,
        maxTokens: 512
    }
});

const viviendaAgent = new Agent({
    name: "Santiago - Vivienda IVEQ",
    model: MODELS.INFO,
    instructions: `Eres Santiago, asistente del Gobierno de Queretaro, especialista en vivienda del IVEQ.

PROGRAMAS:
- Creditos para vivienda
- Mejoramiento de vivienda
- Escrituracion y regularizacion
- Subsidios de vivienda
- Autoconstruccion asistida

REQUISITOS GENERALES:
- Identificacion oficial
- Comprobante de ingresos
- Comprobante de domicilio
- CURP
- Acta de nacimiento

Horario IVEQ: Lunes a Viernes 9:00-16:00
Portal: iveq.queretaro.gob.mx

Si necesitan seguimiento, crea ticket con create_general_ticket (service_type: "vivienda").`,
    tools: [createGeneralTicketTool],
    modelSettings: {
        temperature: 0.7,
        maxTokens: 512
    }
});

const appqroAgent = new Agent({
    name: "Santiago - APPQRO",
    model: MODELS.INFO,
    instructions: `Eres Santiago, asistente del Gobierno de Queretaro, especialista en la aplicacion APPQRO.

APPQRO permite:
- Consultar tramites y servicios del gobierno
- Realizar pagos gubernamentales
- Reportar problemas de infraestructura
- Consultar informacion de dependencias
- Acceder a servicios digitales

SOPORTE:
- Descarga en App Store y Google Play buscando "APPQRO"
- Si tiene problemas tecnicos, recaba: dispositivo, version de la app, descripcion del error
- Crea ticket con create_general_ticket (service_type: "appqro")`,
    tools: [createGeneralTicketTool],
    modelSettings: {
        temperature: 0.7,
        maxTokens: 512
    }
});

const programasSocialesAgent = new Agent({
    name: "Santiago - Programas Sociales SEDESOQ",
    model: MODELS.INFO,
    instructions: `Eres Santiago, asistente del Gobierno de Queretaro, especialista en programas sociales de SEDESOQ.

PROGRAMAS DISPONIBLES:
- Apoyo alimentario (despensas)
- Becas y apoyos educativos
- Apoyo a adultos mayores
- Apoyo a personas con discapacidad
- Programas de empleo temporal
- Desarrollo comunitario

REQUISITOS GENERALES:
- Estudio socioeconomico
- Identificacion oficial
- CURP
- Comprobante de domicilio
- Comprobante de ingresos (si aplica)

Horario SEDESOQ: Lunes a Viernes 9:00-16:00
Portal: sedesoq.queretaro.gob.mx

Indica que la disponibilidad de programas varia y se debe consultar vigencia.
Si necesitan seguimiento, crea ticket con create_general_ticket (service_type: "programas_sociales").`,
    tools: [createGeneralTicketTool],
    modelSettings: {
        temperature: 0.7,
        maxTokens: 512
    }
});

// ============================================
// Agent Router Maps
// ============================================

const agentMap: Record<Classification, Agent<any>> = {
    atencion_ciudadana: atencionCiudadanaAgent,
    transporte_ameq: transporteAgent,
    agua_cea: informacionCeaAgent, // Default; CEA sub-routing handled in workflow
    educacion_usebeq: educacionAgent,
    tramites_vehiculares: vehicularAgent,
    psicologia_sejuve: psicologiaAgent,
    mujeres_iqm: mujeresAgent,
    cultura: culturaAgent,
    registro_publico_rpp: registroPublicoAgent,
    conciliacion_cclq: conciliacionAgent,
    vivienda_iveq: viviendaAgent,
    appqro: appqroAgent,
    programas_sedesoq: programasSocialesAgent,
    hablar_asesor: atencionCiudadanaAgent, // Handled specially in workflow
    tickets: ticketsAgent
};

// CEA sub-agent map (when classification = agua_cea)
const ceaSubAgentMap: Record<CeaSubClassification, Agent<any>> = {
    fuga: fugasAgent,
    pagos: pagosAgent,
    consumos: consumosAgent,
    contrato: contratosAgent,
    informacion_cea: informacionCeaAgent
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
        return await withTrace("Santiago-Queretaro-v1", async () => {
            console.log(`\n========== SANTIAGO WORKFLOW START ==========`);
            console.log(`ConversationId: ${conversationId}`);
            console.log(`Input: "${input.input_as_text}"`);

            // Get or create conversation
            const conversation = getConversation(conversationId);

            // Store Chatwoot IDs in conversation for persistence
            if (chatwootContext.conversationId) conversation.chatwootConversationId = chatwootContext.conversationId;
            if (chatwootContext.contactId) conversation.chatwootContactId = chatwootContext.contactId;

            // Check if this is a greeting -> show menu (new conversation or reset)
            const isNewConversation = conversation.history.length === 0;
            const trimmedInput = input.input_as_text.trim();
            const isGreeting = /^(hola|buenos?\s*(d[ií]as|tardes|noches)|hey|que\s*tal|hi|buenas|saludos)\s*[.!?]*$/i.test(trimmedInput);

            if (isGreeting) {
                // Reset active flow on greeting
                conversation.activeFlow = undefined;
                conversation.activeCeaSubType = undefined;
                console.log(`[Workflow] Greeting detected -> showing Santiago menu${isNewConversation ? ' (new conversation)' : ' (flow reset)'}`);

                // Add to history
                const userMessage: AgentInputItem = {
                    role: "user",
                    content: [{ type: "input_text", text: trimmedInput }]
                };
                conversation.history.push(userMessage);
                conversation.history.push({
                    role: "assistant",
                    content: [{ type: "output_text", text: SANTIAGO_WELCOME_MESSAGE }]
                } as any);

                const processingTime = Date.now() - startTime;
                console.log(`[Workflow] Menu shown in ${processingTime}ms`);
                console.log(`========== SANTIAGO WORKFLOW END ==========\n`);

                return {
                    output_text: SANTIAGO_WELCOME_MESSAGE,
                    classification: "atencion_ciudadana" as Classification,
                    toolsUsed: []
                };
            }

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
                    __trace_source__: "santiago-queretaro-v1",
                    conversation_id: conversationId
                }
            });

            try {
                // Step 1: Determine if user is continuing an active flow or starting new
                let classification: Classification;
                let ceaSubType: CeaSubClassification | null = null;

                // Check if user explicitly wants to switch (menu number or clear new topic)
                const isMenuNumber = /^\s*(\d{1,2})\s*$/.test(trimmedInput);
                const isExplicitSwitch = isMenuNumber || /^(menu|menú|cambiar|otro servicio|salir)/i.test(trimmedInput);

                if (conversation.activeFlow && !isExplicitSwitch) {
                    // User is in an active flow - keep them there
                    classification = conversation.activeFlow;
                    ceaSubType = conversation.activeCeaSubType || null;
                    console.log(`[Workflow] Continuing active flow: ${classification}${ceaSubType ? ` (CEA: ${ceaSubType})` : ''}`);

                    // Still extract contract number if present
                    const contractMatch = trimmedInput.match(/\b(\d{6,10})\b/);
                    if (contractMatch) {
                        conversation.contractNumber = contractMatch[1];
                        console.log(`[Workflow] Extracted contract from active flow: ${contractMatch[1]}`);
                    }
                } else {
                    // No active flow or explicit switch - classify normally
                    console.log(`[Workflow] Running classification...`);
                    const classificationResult = await runner.run(classificationAgent, workingHistory);

                    if (!classificationResult.finalOutput) {
                        throw new Error("Classification failed - no output");
                    }

                    classification = classificationResult.finalOutput.classification as Classification;
                    const extractedContract = classificationResult.finalOutput.extractedContract;
                    ceaSubType = classificationResult.finalOutput.ceaSubType as CeaSubClassification | null;

                    console.log(`[Workflow] Classification: ${classification}${ceaSubType ? ` (CEA: ${ceaSubType})` : ''}`);
                    if (extractedContract) {
                        console.log(`[Workflow] Extracted contract: ${extractedContract}`);
                        conversation.contractNumber = extractedContract;
                    }

                    // Set the active flow
                    conversation.activeFlow = classification;
                    conversation.activeCeaSubType = ceaSubType || undefined;
                }

                // Save classification to conversation
                conversation.classification = classification;

                let output: string;
                let newItems: AgentInputItem[] = [];

                // Step 2: Handle special case - hablar_asesor
                if (classification === "hablar_asesor") {
                    console.log(`[Workflow] Creating urgent ticket for human advisor`);

                    const ticketResult = await createTicketDirect({
                        service_type: "urgente",
                        titulo: "Solicitud de contacto con asesor humano",
                        descripcion: `El ciudadano solicito hablar con un asesor humano. Mensaje original: ${input.input_as_text}`,
                        contract_number: conversation.contractNumber || null,
                        email: null,
                        ubicacion: null,
                        priority: "urgente"
                    });

                    const folio = ticketResult.folio || "PENDING";
                    output = `He creado tu solicitud con el folio ${folio}. Te conectare con un asesor humano. Por favor espera un momento.`;
                    // Flow ends after creating ticket
                    conversation.activeFlow = undefined;
                    conversation.activeCeaSubType = undefined;

                    toolsUsed.push("create_ticket");

                } else if (classification === "agua_cea" && ceaSubType) {
                    // Step 3a: CEA sub-routing
                    const selectedAgent = ceaSubAgentMap[ceaSubType] || informacionCeaAgent;
                    console.log(`[Workflow] CEA sub-routing to: ${selectedAgent.name} (${ceaSubType})`);

                    const agentResult = await runAgentWithApproval(runner, selectedAgent, workingHistory);
                    output = agentResult.output;
                    newItems = agentResult.newItems;
                    toolsUsed.push(...agentResult.toolsUsed);

                } else {
                    // Step 3b: Route to government service agent
                    const selectedAgent = agentMap[classification];
                    console.log(`[Workflow] Routing to: ${selectedAgent.name}`);

                    const agentResult = await runAgentWithApproval(runner, selectedAgent, workingHistory);

                    output = agentResult.output;
                    newItems = agentResult.newItems;
                    toolsUsed.push(...agentResult.toolsUsed);
                }

                // If a ticket was created in this turn, the flow is complete
                if (toolsUsed.includes("create_ticket") || toolsUsed.includes("create_general_ticket")) {
                    console.log(`[Workflow] Ticket created - flow complete, clearing active flow`);
                    conversation.activeFlow = undefined;
                    conversation.activeCeaSubType = undefined;
                }

                // Step 4: Update conversation history
                conversation.history.push(userMessage);
                if (newItems.length > 0) {
                    conversation.history.push(...newItems);
                } else if (output) {
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
                console.log(`========== SANTIAGO WORKFLOW END ==========\n`);

                return {
                    output_text: output,
                    classification,
                    toolsUsed
                };

            } catch (error) {
                console.error(`[Workflow] Error:`, error);

                return {
                    output_text: "Lo siento, tuve un problema procesando tu mensaje. Podrias intentar de nuevo?",
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
            // CEA agents
            informacionCeaAgent.name,
            pagosAgent.name,
            consumosAgent.name,
            fugasAgent.name,
            contratosAgent.name,
            // Government service agents
            atencionCiudadanaAgent.name,
            transporteAgent.name,
            educacionAgent.name,
            vehicularAgent.name,
            psicologiaAgent.name,
            mujeresAgent.name,
            culturaAgent.name,
            registroPublicoAgent.name,
            conciliacionAgent.name,
            viviendaAgent.name,
            appqroAgent.name,
            programasSocialesAgent.name,
            // Cross-service
            ticketsAgent.name
        ],
        conversationCount: conversationStore.size
    };
}

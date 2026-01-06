// ============================================
// CEA Agent Types - Production Ready
// ============================================

export interface ChatRequest {
    message: string;
    conversationId?: string;
    metadata?: {
        whatsapp?: string;
        channel?: 'whatsapp' | 'web' | 'api';
    };
}

export interface ChatResponse {
    response: string;
    classification?: Classification;
    conversationId: string;
    ticketFolio?: string;
    error?: string;
    metadata?: {
        toolsUsed?: string[];
        processingTimeMs?: number;
    };
}

export type Classification = 
    | "fuga"
    | "pagos"
    | "hablar_asesor"
    | "informacion"
    | "consumos"
    | "contrato"
    | "tickets";

export type TicketType =
    | "fuga"              // FUG - Fugas/Leaks
    | "aclaraciones"      // ACL - Clarifications
    | "pagos"             // PAG - Payments
    | "lecturas"          // LEC - Meter readings
    | "revision_recibo"   // REV - Receipt review
    | "recibo_digital"    // DIG - Digital receipt
    | "urgente";          // URG - Urgent (human advisor)

export type TicketStatus = 
    | "abierto"
    | "en_proceso"
    | "esperando_cliente"
    | "esperando_interno"
    | "escalado"
    | "resuelto"
    | "cerrado"
    | "cancelado";

export type TicketPriority = "urgente" | "alta" | "media" | "baja";

export const TICKET_TYPE_CODES = {
    fuga: "FUG",
    aclaraciones: "ACL",
    pagos: "PAG",
    lecturas: "LEC",
    revision_recibo: "REV",
    recibo_digital: "DIG",
    urgente: "URG"
} as const;

// ============================================
// Workflow Types
// ============================================

export interface WorkflowInput {
    input_as_text: string;
    conversationId?: string;
    metadata?: Record<string, unknown>;
}

export interface WorkflowOutput {
    output_text?: string;
    classification?: Classification;
    ticketFolio?: string;
    error?: string;
    toolsUsed?: string[];
}

// ============================================
// CEA API Response Types (Parsed from SOAP)
// ============================================

export interface DeudaResponse {
    success: boolean;
    data?: {
        totalDeuda: number;
        vencido: number;
        porVencer: number;
        conceptos: ConceptoDeuda[];
        nombreCliente?: string;
        direccion?: string;
        ultimoPago?: {
            fecha: string;
            monto: number;
        };
    };
    error?: string;
    rawResponse?: string;
}

export interface ConceptoDeuda {
    periodo: string;
    concepto: string;
    monto: number;
    fechaVencimiento: string;
    estado: 'vencido' | 'por_vencer' | 'pagado';
}

export interface ConsumoResponse {
    success: boolean;
    data?: {
        consumos: ConsumoHistorial[];
        promedioMensual: number;
        tendencia: 'aumentando' | 'estable' | 'disminuyendo';
    };
    error?: string;
}

export interface ConsumoHistorial {
    periodo: string;
    consumoM3: number;
    lecturaAnterior: number;
    lecturaActual: number;
    fechaLectura: string;
    tipoLectura: 'real' | 'estimada';
}

export interface ContratoResponse {
    success: boolean;
    data?: {
        numeroContrato: string;
        titular: string;
        direccion: string;
        colonia: string;
        codigoPostal: string;
        tarifa: string;
        estado: 'activo' | 'suspendido' | 'cortado';
        fechaAlta: string;
        ultimaLectura?: string;
    };
    error?: string;
}

export interface TarifaResponse {
    success: boolean;
    data?: {
        tipoTarifa: string;
        rangos: RangoTarifa[];
    };
    error?: string;
}

export interface RangoTarifa {
    desde: number;
    hasta: number;
    precioPorM3: number;
}

// ============================================
// Ticket Types
// ============================================

export interface Ticket {
    id: string;
    folio: string;
    user_id: string;
    service_type: TicketType;
    titulo: string;
    descripcion: string;
    status: TicketStatus;
    priority: TicketPriority;
    contract_number?: string;
    client_name?: string;
    email?: string;
    ubicacion?: string;
    channel: string;
    assigned_to?: string;
    tags?: string[];
    created_at: string;
    updated_at: string;
    resolved_at?: string;
}

export interface CreateTicketInput {
    service_type: TicketType;
    titulo: string;
    descripcion: string;
    contract_number?: string | null;
    email?: string | null;
    ubicacion?: string | null;
    priority?: TicketPriority;
    client_name?: string | null;
    contact_id?: number | null;
    conversation_id?: number | null;
    inbox_id?: number | null;
}

export interface CreateTicketResult {
    success: boolean;
    folio?: string;
    ticketId?: string;
    error?: string;
    message?: string;
    warning?: string;
}

// ============================================
// Customer Types
// ============================================

export interface Customer {
    id: string;
    whatsapp?: string;
    nombre_titular?: string;
    numero_contrato?: string;
    email?: string;
    telefono?: string;
    direccion_servicio?: string;
    colonia?: string;
    codigo_postal?: string;
    municipio: string;
    recibo_digital: boolean;
    first_interaction_channel: string;
    created_at: string;
}

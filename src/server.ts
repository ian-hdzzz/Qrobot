// ============================================
// Santiago - Gobierno de Queretaro Server v1.0
// ============================================

import express, { Request, Response, NextFunction } from "express";
import { config } from "dotenv";
import { runWorkflow, getAgentHealth } from "./agent.js";
import type { ChatRequest, ChatResponse } from "./types.js";

// Load environment variables
config();

// ============================================
// Configuration
// ============================================

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";

// Validate required env vars
const requiredEnvVars = ["OPENAI_API_KEY"];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.error(`❌ Missing required environment variable: ${envVar}`);
        process.exit(1);
    }
}

// ============================================
// Express App Setup
// ============================================

const app = express();

// Middleware
app.use(express.json({ limit: "10mb" }));

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = crypto.randomUUID().substring(0, 8);
    (req as any).requestId = requestId;
    (req as any).startTime = Date.now();
    
    console.log(`→ [${requestId}] ${req.method} ${req.path}`);
    
    // Log response when finished
    res.on("finish", () => {
        const duration = Date.now() - (req as any).startTime;
        console.log(`← [${requestId}] ${res.statusCode} (${duration}ms)`);
    });
    
    next();
});

// CORS headers for web clients
app.use((req: Request, res: Response, next: NextFunction) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    
    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }
    next();
});

// ============================================
// Health & Status Endpoints
// ============================================

// Basic health check (for load balancers)
app.get("/health", (req: Request, res: Response) => {
    res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Detailed status (for monitoring)
app.get("/status", (req: Request, res: Response) => {
    const agentHealth = getAgentHealth();
    
    res.json({
        status: "ok",
        version: "1.0.0",
        environment: NODE_ENV,
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        memory: {
            heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
        },
        agents: agentHealth
    });
});

// ============================================
// Main Chat Handler
// ============================================

async function handleChat(req: Request, res: Response): Promise<void> {
    const requestId = (req as any).requestId || crypto.randomUUID().substring(0, 8);
    
    try {
        // Extract request data (conversationId is the Chatwoot conversation ID)
        let { message, conversationId, contactId, metadata } = req.body as ChatRequest;

        // Sanitize message input - handle arrays or stringified arrays
        if (Array.isArray(message)) {
            message = message[0] || "";
        } else if (typeof message === "string" && message.startsWith("[") && message.endsWith("]")) {
            try {
                const parsed = JSON.parse(message);
                if (Array.isArray(parsed)) {
                    message = parsed[0] || "";
                }
            } catch {
                // If JSON parse fails, use as-is
            }
        }

        // Validate request
        if (!message || typeof message !== "string") {
            res.status(400).json({
                error: "Missing or invalid 'message' field",
                response: "",
                conversationId: conversationId || crypto.randomUUID()
            } as ChatResponse);
            return;
        }
        
        if (message.length > 10000) {
            res.status(400).json({
                error: "Message too long (max 10000 characters)",
                response: "",
                conversationId: conversationId || crypto.randomUUID()
            } as ChatResponse);
            return;
        }
        
        console.log(`[${requestId}] Processing: "${message.substring(0, 100)}${message.length > 100 ? '...' : ''}"`);
        
        // Run the agent workflow
        // conversationId from Chatwoot is numeric - we use it as both the conversation tracker and Chatwoot link
        const result = await runWorkflow({
            input_as_text: message,
            conversationId: conversationId,
            contactId: contactId,
            metadata: metadata
        });
        
        // Build response
        const response: ChatResponse = {
            response: result.output_text || "Lo siento, no pude procesar tu mensaje.",
            classification: result.classification,
            conversationId: conversationId || crypto.randomUUID(),
            metadata: {
                toolsUsed: result.toolsUsed,
                processingTimeMs: Date.now() - (req as any).startTime
            }
        };
        
        // Include ticket folio if created
        if (result.ticketFolio) {
            response.ticketFolio = result.ticketFolio;
        }

        // Include contact card if present (e.g., CEA redirect)
        if (result.contactCard) {
            response.contactCard = result.contactCard;
        }
        
        console.log(`[${requestId}] Classification: ${result.classification}`);
        console.log(`[${requestId}] Response length: ${response.response.length} chars`);
        
        res.json(response);
        
    } catch (error) {
        console.error(`[${requestId}] Error:`, error);
        
        const errorMessage = error instanceof Error ? error.message : "Internal server error";
        
        res.status(500).json({
            error: NODE_ENV === "development" ? errorMessage : "Internal server error",
            response: "Lo siento, hubo un error procesando tu mensaje. Por favor intenta de nuevo.",
            conversationId: (req.body as ChatRequest)?.conversationId || crypto.randomUUID()
        } as ChatResponse);
    }
}

// ============================================
// API Routes
// ============================================

// Main chat endpoint
app.post("/api/chat", handleChat);

// Webhook alias (for n8n integration)
app.post("/webhook", handleChat);

// ============================================
// Evolution API Webhook Handler
// ============================================

interface EvolutionWebhook {
    event: string;
    instance: string;
    data: {
        key: {
            remoteJid: string;
            fromMe: boolean;
            id: string;
        };
        pushName?: string;
        message?: {
            conversation?: string;
            extendedTextMessage?: { text: string };
        };
        messageType?: string;
    };
}

async function sendWhatsAppMessage(instance: string, to: string, text: string): Promise<void> {
    const evolutionUrl = process.env.EVOLUTION_API_URL || "https://evolution.whoopflow.com";
    const evolutionKey = process.env.EVOLUTION_API_KEY || "";

    try {
        const response = await fetch(`${evolutionUrl}/message/sendText/${instance}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "apikey": evolutionKey
            },
            body: JSON.stringify({
                number: to.replace("@s.whatsapp.net", ""),
                text: text
            })
        });

        if (!response.ok) {
            console.error(`[Evolution] Failed to send message: ${response.status}`);
        }
    } catch (error) {
        console.error(`[Evolution] Error sending message:`, error);
    }
}

async function sendWhatsAppContact(instance: string, to: string, contact: { fullName: string; phoneNumber: string; organization?: string }): Promise<void> {
    const evolutionUrl = process.env.EVOLUTION_API_URL || "https://evolution.whoopflow.com";
    const evolutionKey = process.env.EVOLUTION_API_KEY || "";

    try {
        const response = await fetch(`${evolutionUrl}/message/sendContact/${instance}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "apikey": evolutionKey
            },
            body: JSON.stringify({
                number: to.replace("@s.whatsapp.net", ""),
                contact: [{
                    fullName: contact.fullName,
                    wuid: contact.phoneNumber.replace("+", "") + "@s.whatsapp.net",
                    phoneNumber: contact.phoneNumber,
                    organization: contact.organization || ""
                }]
            })
        });

        if (!response.ok) {
            console.error(`[Evolution] Failed to send contact: ${response.status}`);
        }
    } catch (error) {
        console.error(`[Evolution] Error sending contact:`, error);
    }
}

app.post("/webhook/evolution", async (req: Request, res: Response): Promise<void> => {
    const requestId = (req as any).requestId || crypto.randomUUID().substring(0, 8);

    try {
        const payload = req.body as EvolutionWebhook;

        // Only process incoming messages
        if (payload.event !== "messages.upsert") {
            res.json({ status: "ignored", reason: "not a message event" });
            return;
        }

        // Ignore messages from self
        if (payload.data?.key?.fromMe) {
            res.json({ status: "ignored", reason: "message from self" });
            return;
        }

        // Extract message text
        const messageText = payload.data?.message?.conversation ||
                           payload.data?.message?.extendedTextMessage?.text || "";

        if (!messageText) {
            res.json({ status: "ignored", reason: "no text content" });
            return;
        }

        const remoteJid = payload.data.key.remoteJid;
        const instance = payload.instance;

        console.log(`[${requestId}] Evolution webhook from ${remoteJid}: "${messageText.substring(0, 50)}..."`);

        // Process with agent
        const result = await runWorkflow({
            input_as_text: messageText,
            conversationId: remoteJid,
            metadata: {
                source: "evolution",
                instance: instance,
                pushName: payload.data.pushName
            }
        });

        // Send response back via WhatsApp
        if (result.output_text) {
            await sendWhatsAppMessage(instance, remoteJid, result.output_text);
        }

        // Send contact card if present (e.g., CEA redirect)
        if (result.contactCard) {
            await sendWhatsAppContact(instance, remoteJid, result.contactCard);
            console.log(`[${requestId}] Contact card sent: ${result.contactCard.fullName}`);
        }

        console.log(`[${requestId}] Response sent to ${remoteJid}`);

        res.json({
            status: "ok",
            classification: result.classification,
            responseLength: result.output_text?.length || 0
        });

    } catch (error) {
        console.error(`[${requestId}] Evolution webhook error:`, error);
        res.status(500).json({ status: "error", message: "Internal error" });
    }
});

// Legacy endpoint support
app.post("/chat", handleChat);

// ============================================
// Error Handling
// ============================================

// 404 handler
app.use((req: Request, res: Response) => {
    res.status(404).json({
        error: "Not found",
        message: `Route ${req.method} ${req.path} not found`,
        availableEndpoints: [
            "GET /health - Health check",
            "GET /status - Detailed status",
            "POST /api/chat - Main chat endpoint",
            "POST /webhook - Webhook endpoint (n8n)",
            "POST /webhook/evolution - Evolution API webhook"
        ]
    });
});

// Global error handler
app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
    console.error("Unhandled error:", error);
    
    res.status(500).json({
        error: NODE_ENV === "development" ? error.message : "Internal server error",
        response: "Lo siento, ocurrió un error inesperado.",
        conversationId: crypto.randomUUID()
    });
});

// ============================================
// Server Startup
// ============================================

const server = app.listen(PORT, () => {
    console.log(`
==========================================================
  Santiago - Gobierno de Queretaro v1.0
  Running on port ${PORT}
  Health:  http://localhost:${PORT}/health
  Status:  http://localhost:${PORT}/status
  Chat:    http://localhost:${PORT}/api/chat
  Webhook: http://localhost:${PORT}/webhook
  Environment: ${NODE_ENV}
  Agents: 19 (1 classifier + 5 CEA + 11 government + 1 tickets + 1 citizen)
==========================================================
    `);
});

// Graceful shutdown
process.on("SIGTERM", () => {
    console.log("\n🛑 SIGTERM received, shutting down gracefully...");
    server.close(() => {
        console.log("✅ Server closed");
        process.exit(0);
    });
});

process.on("SIGINT", () => {
    console.log("\n🛑 SIGINT received, shutting down gracefully...");
    server.close(() => {
        console.log("✅ Server closed");
        process.exit(0);
    });
});

export default app;
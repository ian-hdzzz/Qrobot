// ============================================
// Chatwoot Context - For linking tickets to conversations
// ============================================
// This module uses AsyncLocalStorage to provide conversation context
// to tools without passing it explicitly through the call chain.

import { AsyncLocalStorage } from "async_hooks";

export interface ChatwootContext {
    conversationId?: number;
    contactId?: number;
    inboxId?: number | null;
}

const chatwootContextStorage = new AsyncLocalStorage<ChatwootContext>();

/**
 * Get the current Chatwoot context from AsyncLocalStorage.
 * This is used by tools (like createTicketDirect) to automatically
 * link tickets to the current Chatwoot conversation and contact.
 */
export function getCurrentChatwootContext(): ChatwootContext {
    return chatwootContextStorage.getStore() || {};
}

/**
 * Run a function within a Chatwoot context.
 * All async operations within will have access to this context.
 */
export function runWithChatwootContext<T>(
    context: ChatwootContext,
    fn: () => T | Promise<T>
): T | Promise<T> {
    return chatwootContextStorage.run(context, fn);
}

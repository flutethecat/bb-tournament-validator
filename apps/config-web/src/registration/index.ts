// Shared registration core (registration spec 2026-11-02 §2, §8; lane L0). See ./types.ts for the adapter contract.
export * from "./types.js";
export * from "./window.js";
export * from "./lock.js";
export * from "./testSession.js";
export * from "./notify.js";
export * from "./service.js";
export * from "./contact.js";
export * from "./privacy.js";
export { MemoryRegistrationAdapter, type MemoryAdapterOptions } from "./memoryAdapter.js";

import { createHash } from "node:crypto";

/**
 * SHA-256 of a string's UTF-8 bytes, as hex. A plain function rather than a service: it is pure
 * and deterministic, so tests and the simulator have nothing to swap.
 */
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

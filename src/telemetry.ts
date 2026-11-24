/** Sanitized telemetry event emitted for outbound HTTP requests. */
export interface RequestTelemetryEvent {
  readonly method: string;
  readonly path: string;
  readonly statusCode: number | null;
  readonly latencyMs: number;
  readonly attempt: number;
  readonly correlationId: string | null;
  readonly errorType: string | null;
}

/** Sanitized telemetry event emitted for inbound webhook verification. */
export interface WebhookTelemetryEvent {
  readonly provider: string;
  readonly verified: boolean;
  readonly reason: string | null;
}

/** Interface for structured SDK observability hooks (OpenTelemetry, logging, metrics). */
export interface TelemetryHook {
  onRequest(event: RequestTelemetryEvent): void;
  onWebhook(event: WebhookTelemetryEvent): void;
}

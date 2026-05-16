export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!process.env.ERROR_TRACKING_DSN) {
    return;
  }

  // Wire Sentry, Highlight, Axiom, or your preferred provider here.
  // Keep this function non-throwing so observability can never break request handling.
  console.error("error_tracking_placeholder", { error, context });
}

export function captureMessage(message: string, context?: Record<string, unknown>): void {
  if (!process.env.ERROR_TRACKING_DSN) {
    return;
  }

  console.warn("error_tracking_placeholder", { message, context });
}

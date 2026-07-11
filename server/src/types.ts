// Fastify module augmentation for authenticated request context
declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: {
      keyId: string;
      projectId: string;
      scopes: string[];
    };
    // Raw body buffer set by the global application/json content-type parser
    // so that signature verification (Stripe, Discord) can access the exact bytes.
    rawBody?: Buffer;
    // Raw form body string set by the application/x-www-form-urlencoded parser
    // so that Slack's v0 HMAC signature verification can cover the exact bytes.
    rawSlackBody?: string;
  }
}

export {};

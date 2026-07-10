// Fastify module augmentation for authenticated request context
declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: {
      keyId: string;
      projectId: string;
      scopes: string[];
    };
  }
}

export {};

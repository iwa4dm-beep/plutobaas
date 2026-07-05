import client from 'prom-client';
import type { FastifyInstance } from 'fastify';

// Default Node/process metrics
client.collectDefaultMetrics({ prefix: 'pluto_' });

export const httpRequests = new client.Counter({
  name: 'pluto_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
});

export const httpLatency = new client.Histogram({
  name: 'pluto_http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const httpErrors = new client.Counter({
  name: 'pluto_http_errors_total',
  help: 'Total HTTP responses with status >= 500',
  labelNames: ['method', 'route'],
});

export const authOps = new client.Counter({
  name: 'pluto_auth_operations_total',
  help: 'Auth operations by kind',
  labelNames: ['op', 'result'], // op=signup|login|refresh|logout|recover; result=ok|fail
});

export const dbQueries = new client.Counter({
  name: 'pluto_db_queries_total',
  help: 'Database queries by outcome',
  labelNames: ['kind', 'result'], // kind=rest|rpc|auth|admin|storage
});

export const rpcCalls = new client.Counter({
  name: 'pluto_rpc_calls_total',
  help: 'RPC/function calls',
  labelNames: ['fn', 'result'],
});

export const fnInvocations = new client.Counter({
  name: 'pluto_edge_function_invocations_total',
  help: 'Edge function invocations',
  labelNames: ['slug', 'result'],
});

export const fnDuration = new client.Histogram({
  name: 'pluto_edge_function_duration_seconds',
  help: 'Edge function duration',
  labelNames: ['slug'],
  buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
});

export const registry = client.register;

/** Normalize a Fastify route for lower cardinality. */
function routeLabel(req: any): string {
  return req.routeOptions?.url || req.routerPath || req.raw?.url?.split('?')[0] || 'unknown';
}

export async function metricsPlugin(app: FastifyInstance) {
  app.addHook('onRequest', async (req: any) => {
    req._pluto_t0 = process.hrtime.bigint();
  });
  app.addHook('onResponse', async (req: any, reply) => {
    const t0 = req._pluto_t0 as bigint | undefined;
    if (!t0) return;
    const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
    const method = req.method;
    const route = routeLabel(req);
    const status = String(reply.statusCode);
    httpRequests.inc({ method, route, status });
    httpLatency.observe({ method, route, status }, seconds);
    if (reply.statusCode >= 500) httpErrors.inc({ method, route });
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', registry.contentType);
    return reply.send(await registry.metrics());
  });
}

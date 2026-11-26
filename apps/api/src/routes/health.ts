import { Router } from 'express';

export interface ReadinessDeps {
  checkPostgres: () => Promise<boolean>;
  checkRedis?: () => Promise<boolean>;
  checkRabbitMq?: () => Promise<boolean>;
}

export function createHealthRouter(deps: ReadinessDeps): Router {
  const router = Router();
  const bootTimeMs = Date.now();

  router.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'api' });
  });

  router.get('/metrics', (_req, res) => {
    const mem = process.memoryUsage();
    const uptimeSeconds = Math.floor((Date.now() - bootTimeMs) / 1000);
    const lines = [
      '# HELP mailplat_api_uptime_seconds Node.js API process uptime in seconds',
      '# TYPE mailplat_api_uptime_seconds gauge',
      `mailplat_api_uptime_seconds ${uptimeSeconds}`,
      '# HELP process_resident_memory_bytes Resident memory size in bytes',
      '# TYPE process_resident_memory_bytes gauge',
      `process_resident_memory_bytes ${mem.rss}`,
      '# HELP nodejs_heap_used_bytes Node.js heap used in bytes',
      '# TYPE nodejs_heap_used_bytes gauge',
      `nodejs_heap_used_bytes ${mem.heapUsed}`,
      '',
    ];
    res.status(200).type('text/plain; version=0.0.4').send(lines.join('\n'));
  });

  router.get('/readyz', async (_req, res) => {
    const [postgres, redis, rabbitmq] = await Promise.all([
      deps.checkPostgres().catch(() => false),
      deps.checkRedis ? deps.checkRedis().catch(() => false) : Promise.resolve(true),
      deps.checkRabbitMq ? deps.checkRabbitMq().catch(() => false) : Promise.resolve(true),
    ]);

    const ready = postgres && redis && rabbitmq;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'degraded',
      checks: { postgres, redis, rabbitmq },
    });
  });

  return router;
}

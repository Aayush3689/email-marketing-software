import net from 'node:net';

export interface ServiceProbeResult {
  name: 'postgres' | 'redis' | 'rabbitmq' | 'mta_cluster';
  status: 'healthy' | 'degraded' | 'unconfigured';
  latencyMs: number | null;
  detail: string;
}

export interface LiveMtaStatus {
  nodeId: string;
  roles: string[];
  status: 'healthy' | 'draining';
  draining: boolean;
  activeConnections: number;
  metricsSample?: string;
}

export interface QueueStatusItem {
  name: string;
  messagesReady: number;
  messagesUnacknowledged: number;
  consumers: number;
  isDlq: boolean;
  source: 'rabbitmq_management' | 'internal_outbox';
}

export async function probeRedisTcp(redisUrl: string, timeoutMs = 1500): Promise<ServiceProbeResult> {
  const started = Date.now();
  let host = '127.0.0.1';
  let port = 6379;
  try {
    const parsed = new URL(redisUrl);
    host = parsed.hostname || host;
    port = parsed.port ? Number(parsed.port) : port;
  } catch {
    return { name: 'redis', status: 'degraded', latencyMs: null, detail: 'Invalid REDIS_URL' };
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (res: ServiceProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(res);
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      socket.write('*1\r\n$4\r\nPING\r\n');
    });
    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (text.includes('PONG')) {
        finish({
          name: 'redis',
          status: 'healthy',
          latencyMs: Date.now() - started,
          detail: `${host}:${port} PONG`,
        });
      } else {
        finish({
          name: 'redis',
          status: 'degraded',
          latencyMs: Date.now() - started,
          detail: `Unexpected RESP reply: ${text.slice(0, 40)}`,
        });
      }
    });
    socket.on('timeout', () =>
      finish({ name: 'redis', status: 'degraded', latencyMs: timeoutMs, detail: 'TCP timeout' })
    );
    socket.on('error', (err) =>
      finish({ name: 'redis', status: 'degraded', latencyMs: null, detail: err.message })
    );
  });
}

export async function probeMtaControlStatus(
  controlUrl: string,
  controlToken?: string
): Promise<LiveMtaStatus> {
  const base = controlUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  if (controlToken) {
    headers.Authorization = `Bearer ${controlToken}`;
  }

  const statusRes = await fetch(`${base}/status`, {
    headers,
    signal: AbortSignal.timeout(2000),
  });
  if (!statusRes.ok) {
    throw new Error(`MTA status probe returned ${statusRes.status}`);
  }
  const statusJson = (await statusRes.json()) as LiveMtaStatus;

  let metricsSample: string | undefined;
  try {
    const metricsRes = await fetch(`${base}/metrics`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (metricsRes.ok) {
      metricsSample = await metricsRes.text();
    }
  } catch {
    // /status is sufficient if /metrics read fails
  }

  return {
    ...statusJson,
    ...(metricsSample !== undefined ? { metricsSample } : {}),
  };
}

export async function setMtaDrainMode(
  controlUrl: string,
  drain: boolean,
  controlToken?: string
): Promise<{ draining: boolean; status: 'draining' | 'healthy' }> {
  const base = controlUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  if (controlToken) {
    headers.Authorization = `Bearer ${controlToken}`;
  }
  const endpoint = drain ? `${base}/control/drain` : `${base}/control/resume`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`MTA control ${drain ? 'drain' : 'resume'} failed (${res.status})`);
  }
  return (await res.json()) as { draining: boolean; status: 'draining' | 'healthy' };
}

export class RabbitMqManagementClient {
  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string
  ) {}

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
  }

  async checkHealth(): Promise<ServiceProbeResult> {
    const started = Date.now();
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/api/overview`, {
        headers: { Authorization: this.authHeader() },
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) {
        return {
          name: 'rabbitmq',
          status: 'degraded',
          latencyMs: Date.now() - started,
          detail: `Management API HTTP ${res.status}`,
        };
      }
      const data = (await res.json()) as { rabbitmq_version?: string };
      return {
        name: 'rabbitmq',
        status: 'healthy',
        latencyMs: Date.now() - started,
        detail: `RabbitMQ ${data.rabbitmq_version ?? 'connected'}`,
      };
    } catch (err) {
      return {
        name: 'rabbitmq',
        status: 'degraded',
        latencyMs: null,
        detail: err instanceof Error ? err.message : 'Unreachable',
      };
    }
  }

  async listQueues(): Promise<QueueStatusItem[]> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/api/queues`, {
      headers: { Authorization: this.authHeader() },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      throw new Error(`RabbitMQ queues query failed (${res.status})`);
    }
    const raw = (await res.json()) as Array<{
      name: string;
      messages_ready?: number;
      messages_unacknowledged?: number;
      consumers?: number;
    }>;
    return raw.map((q) => ({
      name: q.name,
      messagesReady: q.messages_ready ?? 0,
      messagesUnacknowledged: q.messages_unacknowledged ?? 0,
      consumers: q.consumers ?? 0,
      isDlq: q.name.endsWith('.dlq'),
      source: 'rabbitmq_management',
    }));
  }

  async requeueDlq(dlqName: string, limit = 100): Promise<number> {
    const base = this.baseUrl.replace(/\/+$/, '');
    const getRes = await fetch(`${base}/api/queues/%2F/${encodeURIComponent(dlqName)}/get`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        count: limit,
        ackmode: 'ack_requeue_false',
        encoding: 'auto',
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!getRes.ok) {
      throw new Error(`Failed reading DLQ ${dlqName} (${getRes.status})`);
    }
    const messages = (await getRes.json()) as Array<{
      payload: string;
      payload_encoding?: string;
      routing_key?: string;
      properties?: Record<string, unknown>;
    }>;

    const targetQueue = dlqName.replace(/\.dlq$/, '');
    let requeued = 0;
    for (const msg of messages) {
      const pubRes = await fetch(`${base}/api/exchanges/%2F/amq.default/publish`, {
        method: 'POST',
        headers: {
          Authorization: this.authHeader(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          properties: msg.properties ?? {},
          routing_key: targetQueue,
          payload: msg.payload,
          payload_encoding: msg.payload_encoding ?? 'string',
        }),
        signal: AbortSignal.timeout(3000),
      });
      if (pubRes.ok) {
        requeued += 1;
      }
    }
    return requeued;
  }

  async purgeQueue(queueName: string): Promise<void> {
    const base = this.baseUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/api/queues/%2F/${encodeURIComponent(queueName)}/contents`, {
      method: 'DELETE',
      headers: { Authorization: this.authHeader() },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      throw new Error(`Failed purging queue ${queueName} (${res.status})`);
    }
  }
}

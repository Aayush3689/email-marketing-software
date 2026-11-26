import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OutboxRelay, type OutboxRow } from './outbox-relay.js';

describe('OutboxRelay', () => {
  it('marks rows published only after broker confirmation', async () => {
    const publishedIds: number[] = [];
    const failedCalls: Array<{ id: number; maxAttempts: number | undefined }> = [];

    const rows: OutboxRow[] = [
      { id: 1, exchange: 'mail.events', routingKey: 'mail.outbound.transactional', payload: { ok: true } },
      { id: 2, exchange: 'mail.events', routingKey: 'mail.outbound.bulk', payload: { fail: true } },
    ];

    const relay = new OutboxRelay(
      {
        claimPendingBatch: async () => rows,
        markPublished: async (id) => {
          publishedIds.push(id);
        },
        markFailed: async (id, maxAttempts) => {
          failedCalls.push({ id, maxAttempts });
        },
      },
      {
        publishConfirmed: async (_ex, rk) => {
          if (rk.endsWith('.bulk')) {
            throw new Error('broker nack');
          }
        },
      },
      10
    );

    const res = await relay.relayBatch(50);
    assert.deepEqual(res, { published: 1, failed: 1 });
    assert.deepEqual(publishedIds, [1]);
    assert.deepEqual(failedCalls, [{ id: 2, maxAttempts: 10 }]);
  });

  it('uses markPublishedBatch when repository implements batch ack', async () => {
    const batches: number[][] = [];
    const rows: OutboxRow[] = [
      { id: 10, exchange: 'mail.events', routingKey: 'mail.outbound.tx', payload: { a: 1 } },
      { id: 11, exchange: 'mail.events', routingKey: 'mail.outbound.tx', payload: { b: 2 } },
    ];

    const relay = new OutboxRelay(
      {
        claimPendingBatch: async () => rows,
        markPublished: async () => {
          throw new Error('should not fall back to serial markPublished');
        },
        markPublishedBatch: async (ids) => {
          batches.push(ids);
        },
        markFailed: async () => {},
      },
      { publishConfirmed: async () => {} }
    );

    const res = await relay.relayBatch(50);
    assert.deepEqual(res, { published: 2, failed: 0 });
    assert.deepEqual(batches, [[10, 11]]);
  });
});

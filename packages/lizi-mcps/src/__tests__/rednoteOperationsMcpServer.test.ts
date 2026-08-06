import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  RednoteCommerceService,
  type RednoteCommerceState,
} from '@rednote/commerce-core';
import { afterEach, describe, expect, it } from 'vitest';

import { createRednoteOperationsMcpServer } from '../rednoteOperationsMcpServer.js';

interface JsonEnvelope {
  ok: boolean;
  data?: unknown;
  errorCode?: string;
}

function parseTextResult(result: Awaited<ReturnType<Client['callTool']>>): JsonEnvelope {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error('missing MCP content');
  const block = content.find(
    (item: unknown): item is { type: 'text'; text: string } =>
      Boolean(item)
      && typeof item === 'object'
      && (item as { type?: unknown }).type === 'text'
      && typeof (item as { text?: unknown }).text === 'string',
  );
  if (!block) throw new Error('missing MCP text result');
  return JSON.parse(block.text) as JsonEnvelope;
}

function createService() {
  let state: RednoteCommerceState | null = null;
  const service = new RednoteCommerceService({
    repository: {
      load: async () => structuredClone(state),
      save: async (next) => {
        state = structuredClone(next);
      },
    },
    now: () => new Date('2026-08-05T02:00:00.000Z'),
    createId: (prefix) => `${prefix}-mcp-test`,
  });
  return { service, getState: () => state };
}

async function connect(service: RednoteCommerceService) {
  const server = createRednoteOperationsMcpServer({ getService: () => service });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'rednote-operations-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => Promise.all([client.close(), server.close()]),
  };
}

describe('rednote_operations MCP server', () => {
  const cleanups: Array<() => Promise<unknown>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('exposes only the progressive discovery entry points', async () => {
    const { service } = createService();
    const connection = await connect(service);
    cleanups.push(connection.close);

    const tools = await connection.client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['list_tools', 'call_tool']);

    const listed = parseTextResult(await connection.client.callTool({
      name: 'list_tools',
      arguments: { category: 'approvals' },
    }));
    expect(listed.ok).toBe(true);
    expect(JSON.stringify(listed)).toContain('approval_get');
    expect(JSON.stringify(listed)).not.toMatch(/execute|approve_now|publish_now/);
  });

  it('reads demo data and saves a draft idempotently through a real client transport', async () => {
    const { service, getState } = createService();
    const connection = await connect(service);
    cleanups.push(connection.close);

    const overview = parseTextResult(await connection.client.callTool({
      name: 'call_tool',
      arguments: { name: 'overview_get', args: {} },
    }));
    expect(overview.ok).toBe(true);
    expect(JSON.stringify(overview)).toContain('demo');

    const input = {
      name: 'note_save_draft',
      args: {
        productId: 'product-ceramic-cup',
        title: '通勤杯真实收纳体验',
        body: '基于本地演示商品信息整理的通勤携带要点，不代表真实平台销量或用户评价。',
        tags: ['通勤', '杯具'],
        angle: '便携与清洁',
        expectedRevision: 0,
        commandId: 'mcp-save-note-1',
      },
    };
    const first = parseTextResult(await connection.client.callTool({
      name: 'call_tool',
      arguments: input,
    }));
    const replay = parseTextResult(await connection.client.callTool({
      name: 'call_tool',
      arguments: input,
    }));

    expect(first.ok).toBe(true);
    expect(replay).toEqual(first);
    expect(getState()?.revision).toBe(1);
    expect(getState()?.notes).toHaveLength(5);
  });

  it('creates an approval proposal without exposing an execution path', async () => {
    const { service, getState } = createService();
    const connection = await connect(service);
    cleanups.push(connection.close);

    const prepared = parseTextResult(await connection.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'product_prepare_publish',
        args: {
          productId: 'product-storage',
          expectedRevision: 0,
          commandId: 'mcp-prepare-product-1',
        },
      },
    }));
    expect(prepared.ok).toBe(true);
    expect(getState()?.approvals).toHaveLength(1);
    expect(getState()?.approvals[0]?.status).toBe('pending');
    expect(getState()?.products.find((item) => item.id === 'product-storage')?.status).toBe('draft');

    const forbidden = parseTextResult(await connection.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'approval_execute',
        args: { approvalId: 'approval-mcp-test' },
      },
    }));
    expect(forbidden.ok).toBe(false);
    expect(forbidden.errorCode).toBe('UNKNOWN_TOOL');
    expect(getState()?.approvals[0]?.status).toBe('pending');
  });

  it('refuses to submit an already published note for approval', async () => {
    const { service, getState } = createService();
    const connection = await connect(service);
    cleanups.push(connection.close);

    const result = parseTextResult(await connection.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'note_prepare_publish',
        args: {
          noteId: 'note-aroma-room',
          expectedRevision: 0,
          commandId: 'mcp-prepare-published-note',
        },
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('INVALID_INPUT');
    expect(getState()?.revision).toBe(0);
    expect(getState()?.approvals).toHaveLength(0);
    expect(getState()?.notes.find((note) => note.id === 'note-aroma-room')?.status).toBe('published');
  });

  it('rejects unknown fields and stale revisions without mutating state', async () => {
    const { service, getState } = createService();
    const connection = await connect(service);
    cleanups.push(connection.close);

    const invalid = parseTextResult(await connection.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'products_list',
        args: { status: 'all', unexpected: true },
      },
    }));
    expect(invalid.ok).toBe(false);
    expect(invalid.errorCode).toBe('INVALID_ARGS');

    const missingCommandId = parseTextResult(await connection.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'product_prepare_publish',
        args: {
          productId: 'product-canvas-bag',
          expectedRevision: 0,
        },
      },
    }));
    expect(missingCommandId.ok).toBe(false);
    expect(missingCommandId.errorCode).toBe('INVALID_ARGS');

    const stale = parseTextResult(await connection.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'product_prepare_publish',
        args: {
          productId: 'product-canvas-bag',
          expectedRevision: 99,
          commandId: 'mcp-stale-product-1',
        },
      },
    }));
    expect(stale.ok).toBe(false);
    expect(stale.errorCode).toBe('REVISION_CONFLICT');
    expect(getState()?.revision).toBe(0);
    expect(getState()?.approvals).toHaveLength(0);
  });
});

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { jsonObjectArg } from './json-object-arg.js';
import { registerRednoteTools } from './rednote/registerTools.js';
import {
  RednoteToolRegistry,
  type RednoteToolCategory,
} from './rednote/rednoteToolRegistry.js';
import type { RednoteMcpDeps } from './types.js';

const CATEGORIES = [
  'overview',
  'products',
  'content',
  'campaigns',
  'promotions',
  'approvals',
  'reports',
] as const satisfies readonly RednoteToolCategory[];

export function createRednoteOperationsMcpServer(deps: RednoteMcpDeps): McpServer {
  const server = new McpServer({ name: 'rednote_operations', version: '1.0.0' });
  const registry = new RednoteToolRegistry();
  registerRednoteTools(registry, deps);

  server.tool(
    'list_tools',
    '探索 Rednote Agent 的小红书电商经营工具。不传 category 返回类目；传类目返回工具清单。所有数据均为本地演示数据，真实平台连接尚未启用。',
    {
      category: z.enum(CATEGORIES).optional().describe('工具类目；省略时返回全部类目。'),
    },
    async ({ category }) => {
      if (category) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                dataMode: 'demo',
                category,
                tools: registry.list(category),
                rules: [
                  '所有结果均为本地演示数据，不得声称来自真实小红书后台',
                  '发布、报名和推广只能创建审批提案，必须等待用户在工作台确认',
                  '调用写工具前先读取最新 revision',
                ],
              }),
            },
          ],
        };
      }
      const counts = Object.fromEntries(
        registry.listCategories().map((item) => [item, registry.list(item).length]),
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              dataMode: 'demo',
              categories: CATEGORIES.map((name) => ({ name, toolCount: counts[name] ?? 0 })),
              hint: '用 list_tools({category}) 查看细粒度工具，再用 call_tool 执行。',
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'call_tool',
    '调用 Rednote Agent 的具体经营工具。先用 list_tools 探索。参数错误会返回 JSON Schema；高风险动作只生成审批提案，不直接执行。',
    {
      name: z.string().min(1).describe('list_tools 返回的工具名。'),
      args: jsonObjectArg('工具参数 JSON 对象。'),
    },
    async ({ name, args }) => registry.call(name, args),
  );

  return server;
}

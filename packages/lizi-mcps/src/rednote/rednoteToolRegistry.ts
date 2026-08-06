import { z } from 'zod';

export type RednoteToolCategory =
  | 'overview'
  | 'products'
  | 'content'
  | 'campaigns'
  | 'promotions'
  | 'approvals'
  | 'reports';

export interface RednoteToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface RednoteToolDef {
  name: string;
  category: RednoteToolCategory;
  description: string;
  inputShape: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<RednoteToolResult>;
}

export class RednoteToolRegistry {
  private readonly tools = new Map<string, RednoteToolDef>();

  register<T extends z.ZodRawShape>(definition: {
    name: string;
    category: RednoteToolCategory;
    description: string;
    inputShape: T;
    handler: (args: { [K in keyof T]: z.infer<T[K]> }) => Promise<RednoteToolResult>;
  }): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`[rednote_operations] duplicate tool name: ${definition.name}`);
    }
    this.tools.set(definition.name, definition as unknown as RednoteToolDef);
  }

  list(category?: RednoteToolCategory) {
    return Array.from(this.tools.values())
      .filter((tool) => !category || tool.category === category)
      .map(({ name, category: toolCategory, description }) => ({
        name,
        category: toolCategory,
        description,
      }));
  }

  listCategories(): RednoteToolCategory[] {
    return Array.from(new Set(Array.from(this.tools.values()).map((tool) => tool.category)));
  }

  async call(name: string, rawArgs: unknown): Promise<RednoteToolResult> {
    const definition = this.tools.get(name);
    if (!definition) {
      return errorResult('UNKNOWN_TOOL', `未知工具: ${name}`, {
        available: Array.from(this.tools.keys()),
      });
    }
    const schema = z.strictObject(definition.inputShape);
    const parsed = schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return errorResult('INVALID_ARGS', '工具参数不符合约定', {
        tool: name,
        validationErrors: parsed.error.issues,
        schema: z.toJSONSchema(schema),
      });
    }
    return definition.handler(parsed.data as Record<string, unknown>);
  }
}

export function okResult(data: unknown): RednoteToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }],
  };
}

export function errorResult(
  errorCode: string,
  message: string,
  data?: Record<string, unknown>,
): RednoteToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: false, errorCode, message, ...(data ? { data } : {}) }),
      },
    ],
    isError: true,
  };
}

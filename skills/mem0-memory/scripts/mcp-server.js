'use strict';

if (!process.env.MEM0_TELEMETRY) {
  process.env.MEM0_TELEMETRY = 'false';
}

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const z = require('zod');
const { MEMORY_CATEGORIES } = require('./config');
const { Mem0Service } = require('./engine');

function createMem0McpServer(serviceFactory = (cwd) => new Mem0Service({ cwd })) {
  const server = new McpServer({
    name: 'loopx-mem0',
    version: '1.0.0',
  });

  const getService = (cwd) => serviceFactory(cwd || process.env.MEM0_PROJECT_ROOT || process.cwd());

  server.registerTool(
    'search_memories',
    {
      description:
        '检索当前仓库的 mem0 长期记忆（项目架构、技术决策、代码规范、业务规则、历史问题解决方案）。支持按类别过滤、语义相关性阈值与严格 Token 预算控制。',
      inputSchema: {
        query: z.string().min(1).max(2000).describe('待检索的问题或任务描述'),
        category: z
          .enum(MEMORY_CATEGORIES)
          .optional()
          .describe('可选记忆分类：architecture | decisions | conventions | business_rules | troubleshooting'),
        scope: z
          .enum(['repo', 'mine', 'all'])
          .optional()
          .describe('检索作用域，默认 repo'),
        feature: z.string().optional().describe('可选特性名称过滤'),
        top_k: z.number().int().min(1).max(15).optional().describe('最大返回条数（默认 5）'),
        max_tokens: z.number().int().min(100).max(4000).optional().describe('上下文 Token 上限（默认 800）'),
        cwd: z.string().optional().describe('可选工作目录'),
      },
    },
    async (args) => {
      const svc = getService(args.cwd);
      const res = await svc.search(args.query, {
        category: args.category,
        scope: args.scope || 'repo',
        feature: args.feature,
        topK: args.top_k,
        maxContextTokens: args.max_tokens,
      });
      if (!res.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: res.error, code: res.code }) }],
          isError: true,
        };
      }
      const text = res.formatted || '未检索到满足相关性阈值的高匹配历史记忆。';
      return {
        content: [
          {
            type: 'text',
            text: `${text}\n\n(count=${res.results.length}, tokens=${res.tokens}, filtered_low_relevance=${res.filteredOut})`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'add_memory',
    {
      description:
        '写入项目长期记忆并自动执行密钥脱敏、精确去重及语义冲突更新（ADD/UPDATE/DELETE/NONE）。',
      inputSchema: {
        content: z.string().min(6).max(8000).describe('需要沉淀的架构、决策、规范、业务规则或问题解决方案'),
        category: z.enum(MEMORY_CATEGORIES).describe('记忆分类'),
        feature: z.string().optional().describe('关联特性名（可选）'),
        importance: z.enum(['high', 'normal']).optional().describe('重要程度'),
        curated: z.boolean().optional().describe('是否作为已提炼事实直接去重写入（默认 true，节省提炼 Token）'),
        cwd: z.string().optional(),
      },
    },
    async (args) => {
      const svc = getService(args.cwd);
      const res = await svc.capture(args.content, {
        category: args.category,
        feature: args.feature,
        importance: args.importance || 'normal',
        curated: args.curated !== false,
        source: 'mcp_add_memory',
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        isError: !res.ok,
      };
    }
  );

  server.registerTool(
    'update_memory',
    {
      description: '按记忆 ID 更新记忆内容（自动脱敏并刷新向量与历史记录）。',
      inputSchema: {
        memory_id: z.string().min(1),
        text: z.string().min(6).max(4000),
        category: z.enum(MEMORY_CATEGORIES).optional(),
        cwd: z.string().optional(),
      },
    },
    async (args) => {
      const svc = getService(args.cwd);
      const res = await svc.update(args.memory_id, args.text, args.category ? { category: args.category } : {});
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        isError: !res.ok,
      };
    }
  );

  server.registerTool(
    'delete_memory',
    {
      description: '按记忆 ID 删除已过时或错误的记忆。',
      inputSchema: {
        memory_id: z.string().min(1),
        cwd: z.string().optional(),
      },
    },
    async (args) => {
      const svc = getService(args.cwd);
      const res = await svc.delete(args.memory_id);
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        isError: !res.ok,
      };
    }
  );

  server.registerTool(
    'list_memories',
    {
      description: '列出当前仓库已沉淀的长期记忆列表（支持按类别筛选）。',
      inputSchema: {
        category: z.enum(MEMORY_CATEGORIES).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cwd: z.string().optional(),
      },
    },
    async (args) => {
      const svc = getService(args.cwd);
      const res = await svc.list({ category: args.category, limit: args.limit || 20 });
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        isError: !res.ok,
      };
    }
  );

  server.registerTool(
    'memory_stats',
    {
      description: '查看当前仓库 mem0 记忆数量统计与健康状态。',
      inputSchema: {
        cwd: z.string().optional(),
      },
    },
    async (args) => {
      const svc = getService(args.cwd);
      const stats = await svc.stats();
      return {
        content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }],
        isError: !stats.ok,
      };
    }
  );

  return server;
}

async function main() {
  const server = createMem0McpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[loopx-mem0-mcp] fatal:', err?.message || err);
    process.exit(1);
  });
}

module.exports = { createMem0McpServer };

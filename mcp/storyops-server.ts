#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { InMemoryApprovalStore } from '../src/core/ai/approval.ts';
import { InMemoryIdempotencyStore } from '../src/core/ai/idempotency.ts';
import { OfficeOrchestrator } from '../src/core/ai/orchestrator.ts';
import { SandboxStructuredModel } from '../src/core/ai/sandboxModel.ts';
import { inspectUntrustedContent } from '../src/core/ai/security.ts';
import { officeAgentNames } from '../src/core/ai/contracts.ts';
import {
  IntegrationHealthService,
  listSuiteIntegrations,
} from '../src/core/integrations/health.ts';
import { createSandboxIntegrationSuite } from '../src/core/integrations/sandbox.ts';
import { createSandboxOfficeToolRegistry } from '../src/core/integrations/officeTools.ts';

const suite = createSandboxIntegrationSuite();
const health = new IntegrationHealthService(listSuiteIntegrations(suite));
const orchestrator = new OfficeOrchestrator({
  model: new SandboxStructuredModel(),
  tools: createSandboxOfficeToolRegistry(suite),
  approvals: new InMemoryApprovalStore(),
  idempotency: new InMemoryIdempotencyStore(),
});

const server = new McpServer({
  name: 'storyops-ai',
  version: '1.0.0',
});

server.registerTool(
  'storyops_integration_health',
  {
    title: 'StoryOps integration health',
    description:
      'Read integration status. This tool has no external side effects and returns sandbox status when keys are absent.',
    inputSchema: {},
  },
  async () => {
    const result = await health.checkAll();
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  'storyops_inspect_untrusted_content',
  {
    title: 'Inspect untrusted lead content',
    description:
      'Detect common instruction-injection signals in customer-supplied content. It does not execute the content.',
    inputSchema: {
      channel: z.enum(['web', 'chat', 'sms', 'phone', 'email', 'photo_ocr', 'review']),
      content: z.string().max(20_000),
    },
  },
  ({ channel, content }) => {
    const result = inspectUntrustedContent({
      id: 'mcp-input',
      channel,
      content,
      receivedAt: new Date().toISOString(),
    });
    const structuredContent = {
      signals: result.signals,
      truncated: result.truncated,
      safeToTreatAsInstructions: false,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
);

server.registerTool(
  'storyops_sandbox_ai_run',
  {
    title: 'Run a no-key StoryOps specialist',
    description:
      'Exercise the structured AI-office contract in sandbox mode. The default sandbox model proposes no actions.',
    inputSchema: {
      agent: z.enum(officeAgentNames),
      objective: z.string().min(1).max(2_000),
      facts: z
        .array(
          z.object({
            name: z.string().min(1).max(256),
            value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
          }),
        )
        .max(50)
        .default([]),
      customerText: z.string().max(20_000).default(''),
    },
  },
  async ({ agent, objective, facts, customerText }) => {
    const now = new Date().toISOString();
    const result = await orchestrator.run({
      runId: globalThis.crypto.randomUUID(),
      companyId: 'mcp-sandbox-company',
      agent,
      objective,
      actor: { id: 'mcp-local-user', role: 'owner' },
      trustedFacts: facts.map((fact, index) => ({
        id: `fact-${index + 1}`,
        name: fact.name,
        value: fact.value,
        source: 'human',
        observedAt: now,
      })),
      untrustedContent: customerText
        ? [
            {
              id: 'customer-text',
              channel: 'chat',
              content: customerText,
              receivedAt: now,
            },
          ]
        : [],
      idempotencyKey: `mcp-${globalThis.crypto.randomUUID()}`,
      requestedAt: now,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('StoryOps AI MCP server ready on stdio (read-only/sandbox tools).');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'MCP server failed.');
  process.exitCode = 1;
});

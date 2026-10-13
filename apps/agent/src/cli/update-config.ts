import { z } from "zod";

const updateConfigSchema = z.object({
  updateFeedUrl: z.string().nullable(),
  /** Original public release feed. New clients try this before updateFeedUrl. */
  updateDirectUrl: z.string().nullable().optional(),
  engineUpdateBaseUrl: z.string().nullable().optional(),
  npmRegistryUrl: z.string().nullable().optional(),
  engineUpdateProxyUrl: z.string().nullable().optional()
});
export type AgentUpdateConfig = z.infer<typeof updateConfigSchema>;

/** Only this relay receives the agent credential; artifact downloads use separate short-lived access. */
export async function fetchAgentUpdateConfig(relayUrl: string, agentToken?: string): Promise<AgentUpdateConfig> {
  const response = await fetch(`${relayUrl.trim().replace(/\/+$/, "")}/api/agent/config`, {
    signal: AbortSignal.timeout(8000),
    redirect: "error",
    headers: { Accept: "application/json", ...(agentToken ? { Authorization: `Bearer ${agentToken}` } : {}) }
  });
  if (!response.ok) throw new Error(`无法读取更新配置：HTTP ${response.status}`);
  const parsed = updateConfigSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("服务器返回的更新配置无效");
  return parsed.data;
}

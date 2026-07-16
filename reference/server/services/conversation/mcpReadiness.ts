interface MCPServerStatus {
  name: string;
  status: 'pending' | 'connected' | 'failed' | 'disabled' | string;
}

interface QueryWithMcp {
  mcpServerStatus(): Promise<MCPServerStatus[]>;
  reconnectMcpServer(name: string): Promise<unknown>;
}

/**
 * Waits for all MCP servers to reach a terminal state (connected/failed/disabled).
 * Polls mcpServerStatus() with increasing delays. Once no servers are "pending",
 * attempts to reconnect any that failed.
 */
export async function waitForMcpServers(
  queryInstance: QueryWithMcp,
  timeout: number = 30000,
): Promise<void> {
  const startTime = Date.now();
  const delays = [500, 1000, 2000, 3000, 3000, 3000, 3000, 3000, 3000, 3000];

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (Date.now() - startTime > timeout) break;

    let statuses: MCPServerStatus[];
    try {
      statuses = await queryInstance.mcpServerStatus();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      continue;
    }

    const pending = statuses.filter((s) => s.status === 'pending');

    if (pending.length === 0) {
      const failed = statuses.filter((s) => s.status === 'failed');
      for (const server of failed) {
        try {
          await queryInstance.reconnectMcpServer(server.name);
          console.log(`[ConversationAdapter] Reconnected MCP server "${server.name}"`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[ConversationAdapter] Failed to reconnect "${server.name}":`, message);
        }
      }
      const elapsed = Date.now() - startTime;
      if (elapsed > 600) {
        console.log(`[ConversationAdapter] All MCP servers ready (${elapsed}ms)`);
      }
      return;
    }

    console.log(
      `[ConversationAdapter] Waiting for MCP servers: ${pending.map((s) => s.name).join(', ')}`,
    );
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
  }

  console.warn(
    `[ConversationAdapter] MCP server wait timed out after ${Date.now() - startTime}ms`,
  );
}

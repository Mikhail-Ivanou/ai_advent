import { McpEndpointClient } from '../mcp/endpoint-client';

// Day 31: the assistant's connection to the project itself — the "git" MCP
// server (mcp-weather/src/git.ts).

const MCP_URL = process.env.DEV_ASSISTANT_MCP_URL?.trim() || 'http://localhost:3002/mcp/git';
const MCP_TOKEN = process.env.DEV_ASSISTANT_MCP_TOKEN?.trim() || process.env.MCP_AUTH_TOKEN?.trim() || undefined;

export interface BranchInfo {
  branch: string;
  detached: boolean;
  head: { sha: string; subject: string; date: string };
  upstream?: string;
  ahead: number;
  behind: number;
}

export class GitMcpClient extends McpEndpointClient {
  constructor() {
    super(MCP_URL, 'git', MCP_TOKEN);
  }

  async currentBranch(): Promise<BranchInfo> {
    const result = await this.call('git_current_branch');
    if (result.isError || !result.structured) throw new Error(result.text || 'git_current_branch вернул пустой ответ');
    return result.structured as unknown as BranchInfo;
  }
}

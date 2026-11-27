export class AgentApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Agent API failed with HTTP ${status}`);
  }
}

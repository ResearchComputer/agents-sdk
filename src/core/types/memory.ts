export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
export interface Memory { name: string; description: string; type: MemoryType; content: string; }
export interface MemorySelection { memory: Memory; relevanceScore: number; source: string; updatedAt: number; }
export interface MemoryManager { load(): Promise<Memory[]>; save(memory: Memory): Promise<void>; remove(name: string): Promise<void>; retrieve(memories: Memory[], context: { query: string; maxItems?: number; maxTokens?: number }): MemorySelection[]; }

export interface MemoryInjectionMessage { role: 'memory'; content: string; sources: string[]; timestamp: number; }
export interface CompactionSummaryMessage { role: 'summary'; content: string; compactedCount: number; timestamp: number; }
export interface SwarmReportMessage { role: 'swarmReport'; content: string; fromAgent: string; taskId: string; timestamp: number; }

declare module '@mariozechner/pi-agent-core' {
  interface CustomAgentMessages {
    memory: MemoryInjectionMessage;
    summary: CompactionSummaryMessage;
    swarmReport: SwarmReportMessage;
  }
}

export interface Issue { severity: 'error' | 'warning'; code: string; message: string; elementId?: string }
export interface Finding { id: string; category: string; severity: 'high' | 'medium' | 'low'; title: string; detail: string; nodeIds: string[] }
export interface Suggestion { id: string; title: string; rationale: string; impact: 'high' | 'medium' | 'low'; effort: 'low' | 'medium' | 'high'; findingIds: string[] }
export interface Metrics { tasks: number; gateways: number; actors: number; handoffs: number; decisionPoints: number; longestPath: number }
export interface TraceStep { step: string; label: string; status: 'running' | 'done' | 'warn' | 'failed' | 'skipped'; detail?: string; ms?: number; at: number }
export interface Result {
  xml: string; issues: Issue[]; valid: boolean; repairs: number; engine: 'llm' | 'rules';
  findings: Finding[]; suggestions: Suggestion[]; metrics: Metrics; summary: string;
}
export interface ProcessRec {
  id: string; title: string; status: 'queued' | 'running' | 'done' | 'failed';
  result?: Result; trace: TraceStep[]; error?: string; createdAt: string; engineChoice: string;
}
export interface ProcessListItem { id: string; title: string; status: string; createdAt: string; engine?: string }
export interface Health {
  status: string; storage: string;
  engine: { mode: 'llm' | 'rules'; provider?: string; model?: string; configured?: { provider: string; model: string } };
  demo?: { email: string; password: string };
}
export interface Sample { id: string; title: string; kind: string; text: string }

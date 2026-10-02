export type NodeType = 'start' | 'end' | 'task' | 'xor' | 'and';
export type TaskKind = 'user' | 'service' | 'plain';

export interface PNode {
  id: string;
  type: NodeType;
  name: string;
  actor?: string;
  kind?: TaskKind;
}

export interface PFlow {
  id: string;
  from: string;
  to: string;
  label?: string;
}

/** Engine-neutral process description produced by the extractor and consumed by the BPMN generator. */
export interface ProcessModel {
  title: string;
  actors: string[];
  nodes: PNode[];
  flows: PFlow[];
}

export interface Issue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  elementId?: string;
}

export type FindingCategory =
  | 'bottleneck'
  | 'redundancy'
  | 'missing-exception'
  | 'handoff'
  | 'complexity';

export interface Finding {
  id: string;
  category: FindingCategory;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  nodeIds: string[];
}

export interface Suggestion {
  id: string;
  title: string;
  rationale: string;
  impact: 'high' | 'medium' | 'low';
  effort: 'low' | 'medium' | 'high';
  findingIds: string[];
}

export interface Metrics {
  tasks: number;
  gateways: number;
  actors: number;
  handoffs: number;
  decisionPoints: number;
  longestPath: number;
}

export type StepStatus = 'running' | 'done' | 'warn' | 'failed' | 'skipped';

export interface TraceStep {
  step: string;
  label: string;
  status: StepStatus;
  detail?: string;
  ms?: number;
  at: number;
}

export type EngineChoice = 'auto' | 'llm' | 'rules';
export type EngineUsed = 'llm' | 'rules';

export interface PipelineResult {
  model: ProcessModel;
  xml: string;
  issues: Issue[];
  valid: boolean;
  repairs: number;
  engine: EngineUsed;
  findings: Finding[];
  suggestions: Suggestion[];
  metrics: Metrics;
  summary: string;
}

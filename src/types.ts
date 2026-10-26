export type NodeStatus = "locked" | "unlocked" | "proposed";

export type Level = "beginner" | "intermediate";

export type SkillNode = {
  id: string;
  title: string;
  summary: string;
  prereqs: string[];
  status: NodeStatus;
  level: Level;
  reason: string | null;
  keywords: string[];
  clarify: string;
  sort: number;
  seed: boolean;
  notes: string | null;
};

export type PublicNode = {
  id: string;
  title: string;
  summary: string;
  prereqs: string[];
  status: NodeStatus;
  level: Level;
  reason: string | null;
  sort: number;
  seed: boolean;
};

export type ChatRole = "user" | "intern" | "system";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  at: string;
  nodeId: string | null;
};

export type TranscriptTurn = {
  role: "user" | "intern";
  text: string;
};

export type Teaching = {
  nodeId: string;
  phase: "explain" | "clarify" | "ready";
  explanation: string;
  questionsAsked: number;
  pendingQuestion: string | null;
  organized: string | null;
  transcript: TranscriptTurn[];
};

export type TermLine = {
  stream: "in" | "out" | "err";
  text: string;
};

export type Desktop = {
  editorPath: string | null;
  editorContent: string;
  terminal: TermLine[];
  status: "idle" | "working";
  files: string[];
  label: string;
};

export type ExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export interface Computer {
  run(command: string): Promise<ExecResult>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  listDir(path: string): Promise<{ name: string; isDir: boolean }[]>;
}

export function publicNode(node: SkillNode): PublicNode {
  return {
    id: node.id,
    title: node.title,
    summary: node.summary,
    prereqs: node.prereqs,
    status: node.status,
    level: node.level,
    reason: node.reason,
    sort: node.sort,
    seed: node.seed,
  };
}

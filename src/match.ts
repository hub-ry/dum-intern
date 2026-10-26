import type { SkillNode } from "./types.ts";

export type Proposal = {
  id: string;
  title: string;
  summary: string;
  reason: string;
  prereqs: string[];
  keywords: string[];
};

export type Classification =
  | { kind: "chat" }
  | { kind: "blocked"; node: SkillNode; also: string[] }
  | { kind: "task"; skills: SkillNode[]; proposal: Proposal | null }
  | { kind: "propose"; proposal: Proposal };

const QUESTION_START = /^\s*(hi|hello|hey|thanks|thank you|what|who|why|how|help)\b/i;
const TASK = /\b(write|run|make|create|list|show|fix|install|commit|build|add|delete|fetch|debug|start|print|open|check|curl|mkdir|docker|pytest|set up|pip)\b/i;

/** Topics that are not on the seed tree. Matching one proposes a node and does not run it. */
export const OUTSIDE: Proposal[] = [
  {
    id: "virtual-environments",
    title: "Virtual environments",
    summary: "Give one project its own Python packages.",
    reason: "Installing packages into the system Python makes the next project messy. I won't create a venv until you teach me how you want it done.",
    prereqs: ["python-scripts"],
    keywords: ["venv", "virtual environment", "virtualenv", "pip install"],
  },
  {
    id: "git-remotes",
    title: "Git remotes",
    summary: "Send commits to another copy of the repository.",
    reason: "A local commit stays on this computer. Pushing is a separate skill, and I won't push until you teach it.",
    prereqs: ["git-basics"],
    keywords: ["git push", "git pull", "git remote"],
  },
  {
    id: "http-status-codes",
    title: "HTTP status codes",
    summary: "Read the number on a response before trusting the body.",
    reason: "A response can have a body and still have failed. I won't branch on status codes until you teach me your rules.",
    prereqs: ["http-requests"],
    keywords: ["status code", "404", "500"],
  },
  {
    id: "kubernetes",
    title: "Kubernetes",
    summary: "Run an app as a set of containers with a desired state.",
    reason: "This is past Docker basics. I won't touch a cluster until you teach me the workflow you want.",
    prereqs: ["docker-basics"],
    keywords: ["kubernetes", "k8s", "kubectl"],
  },
  {
    id: "react-components",
    title: "React components",
    summary: "Build a page out of small functions that return markup.",
    reason: "I won't invent a component model until you teach it.",
    prereqs: ["python-scripts"],
    keywords: ["react", "jsx"],
  },
  {
    id: "postgres",
    title: "Postgres",
    summary: "Store rows in a database and ask questions with SQL.",
    reason: "A database is a different tool from a file. I won't query one until you teach me.",
    prereqs: ["python-scripts"],
    keywords: ["postgres", "postgresql"],
  },
];

const FOLLOW_UP: Record<string, string> = {
  "python-scripts": "virtual-environments",
  "git-basics": "git-remotes",
  "http-requests": "http-status-codes",
};

export function looksLikeTask(text: string): boolean {
  if (QUESTION_START.test(text)) return false;
  return TASK.test(text);
}

export function wordHit(text: string, keyword: string): boolean {
  const k = keyword.trim().toLowerCase();
  if (!k) return false;
  if (/\s/.test(k)) return text.toLowerCase().includes(k);
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(text);
}

export function outsideProposal(text: string, existingIds: Set<string>): Proposal | null {
  let best: { proposal: Proposal; weight: number } | null = null;
  for (const proposal of OUTSIDE) {
    if (existingIds.has(proposal.id)) continue;
    let weight = 0;
    for (const keyword of proposal.keywords) {
      if (wordHit(text, keyword)) weight += keyword.trim().length;
    }
    if (weight > 0 && (!best || weight > best.weight)) best = { proposal, weight };
  }
  return best?.proposal ?? null;
}

export function followUpProposal(skillId: string, existingIds: Set<string>): Proposal | null {
  const id = FOLLOW_UP[skillId];
  if (!id || existingIds.has(id)) return null;
  return OUTSIDE.find((item) => item.id === id) ?? null;
}

type Hit = { node: SkillNode; weight: number };

function score(text: string, nodes: SkillNode[]): Hit[] {
  const hits: Hit[] = [];
  for (const node of nodes) {
    let weight = 0;
    for (const keyword of node.keywords) {
      if (wordHit(text, keyword)) weight += keyword.trim().length;
    }
    if (weight > 0) hits.push({ node, weight });
  }
  hits.sort((a, b) => b.weight - a.weight || a.node.sort - b.node.sort);
  return hits;
}

export function classify(text: string, nodes: SkillNode[]): Classification {
  const hits = score(text, nodes);
  const tasky = looksLikeTask(text);
  const outside = outsideProposal(text, new Set(nodes.map((node) => node.id)));
  if (!tasky) return { kind: "chat" };

  const top = hits[0]?.weight ?? 0;
  const outsideWeight = outside
    ? Math.max(...outside.keywords.filter((keyword) => wordHit(text, keyword)).map((keyword) => keyword.trim().length))
    : 0;
  if (outside && outsideWeight >= top) return { kind: "propose", proposal: outside };

  if (hits.length === 0) {
    const terminal = nodes.find((node) => node.id === "terminal-basics");
    if (terminal && terminal.status !== "unlocked") return { kind: "blocked", node: terminal, also: [] };
    if (terminal) return { kind: "task", skills: [terminal], proposal: null };
    return { kind: "chat" };
  }

  const relevant = hits.filter((hit, index) => index === 0 || hit.weight >= Math.max(3, top * 0.5));
  const blocked = relevant.filter((hit) => hit.node.status !== "unlocked");
  if (blocked.length > 0) {
    const chosen = blocked.slice().sort((a, b) => b.weight - a.weight || a.node.sort - b.node.sort)[0].node;
    const also = blocked.map((hit) => hit.node.title).filter((title) => title !== chosen.title);
    return { kind: "blocked", node: chosen, also };
  }
  const side = outside && outsideWeight > 0 ? outside : null;
  return { kind: "task", skills: relevant.map((hit) => hit.node), proposal: side };
}

/** The first locked or proposed prerequisite, else the node itself. */
export function earliestGap(node: SkillNode, byId: Map<string, SkillNode>): SkillNode {
  for (const id of node.prereqs) {
    const pre = byId.get(id);
    if (pre && pre.status !== "unlocked") return earliestGap(pre, byId);
  }
  return node;
}

export function refusal(node: SkillNode, nodes: SkillNode[], also: string[] = []): string {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const gap = earliestGap(node, byId);
  const lead = node.status === "proposed"
    ? `I can't do that yet. The missing node is ${node.title} (proposed). Teach it to me and I'll follow your explanation. I won't use it before that.`
    : `I can't do that yet. The missing node is ${node.title} (locked). Teach it to me and I'll follow your explanation.`;
  const parts = [lead];
  if (gap.id !== node.id) parts.push(`Start with ${gap.title}. ${node.title} depends on it.`);
  if (also.length > 0) parts.push(`This task also needs ${also.join(", ")}.`);
  return parts.join(" ");
}

const COMMAND_GATES: { re: RegExp; id: string; title: string }[] = [
  { re: /\bdocker\b|\bdockerfile\b/i, id: "docker-basics", title: "Docker basics" },
  { re: /\bpytest\b|\bunittest\b/i, id: "writing-tests", title: "Writing tests" },
  { re: /\bgit\s+(branch|checkout|switch|merge)\b/i, id: "git-branching", title: "Git branching" },
  { re: /\bgit\b/i, id: "git-basics", title: "Git basics" },
  { re: /\bpip\s+install\b|\bvenv\b|\bvirtualenv\b/i, id: "virtual-environments", title: "Virtual environments" },
  { re: /\bpython3?\b/i, id: "python-scripts", title: "Python scripts" },
  { re: /\bcurl\b/i, id: "http-requests", title: "HTTP requests" },
  { re: /\bkubectl\b|\bkubernetes\b/i, id: "kubernetes", title: "Kubernetes" },
];

export function commandGap(command: string, nodes: SkillNode[]): { title: string; status: SkillNode["status"] | "unknown" } | null {
  for (const gate of COMMAND_GATES) {
    if (!gate.re.test(command)) continue;
    const node = nodes.find((item) => item.id === gate.id);
    if (!node) return { title: gate.title, status: "unknown" };
    if (node.status !== "unlocked") return { title: node.title, status: node.status };
    return null;
  }
  if (/\b(ls|pwd|cd|mkdir|cat|rm|cp|mv|touch|echo|head|tail)\b/.test(command)) {
    const ok = nodes.some((node) =>
      (node.id === "terminal-basics" || node.id === "files-and-paths") && node.status === "unlocked",
    );
    if (!ok) return { title: "Terminal basics", status: "locked" };
  }
  return null;
}

import { followUpProposal } from "./match.ts";
import type { Proposal } from "./match.ts";
import { words } from "./skilldoc.ts";
import type { SkillNode, Teaching } from "./types.ts";

export type Step =
  | { type: "say"; text: string }
  | { type: "run"; command: string; output: string; error?: boolean }
  | { type: "edit"; path: string; content: string }
  | { type: "propose"; proposal: Proposal };

export function mockChat(text: string, nodes: SkillNode[]): string {
  const unlocked = nodes.filter((node) => node.status === "unlocked");
  const locked = nodes.filter((node) => node.status !== "unlocked").length;
  const known = unlocked.length > 0 ? unlocked.map((node) => node.title).join(", ") : "nothing yet";
  if (/\b(what can you do|who are you|help|what do you know)\b/i.test(text)) {
    return `I can do ${known}. ${locked} nodes are still locked or only proposed. Teach one and I'll follow your words.`;
  }
  return `I don't see a task I know how to start. Teach a locked node, or ask me to do something you've already taught. Right now that's ${known}.`;
}

export function mockTeach(node: SkillNode, teaching: Teaching, userText: string): { teaching: Teaching; replies: string[] } {
  const next: Teaching = {
    ...teaching,
    transcript: [...teaching.transcript, { role: "user", text: userText }],
  };
  if (next.phase === "explain" || !next.explanation) {
    if (words(userText).length < 8) {
      return {
        teaching: next,
        replies: ["Say a little more. What is it, and when do you use it? I want to follow your words, not guess."],
      };
    }
    next.explanation = userText;
    next.phase = "clarify";
    next.questionsAsked = 1;
    next.pendingQuestion = node.clarify;
    next.transcript = [...next.transcript, { role: "intern", text: node.clarify }];
    return { teaching: next, replies: [node.clarify] };
  }

  next.explanation = `${next.explanation}\n\n${userText}`;
  if (next.phase === "clarify") {
    if (next.questionsAsked < 2 && words(userText).length < 6) {
      const question = "Give me one command, line, or example I should copy when I do this.";
      next.questionsAsked += 1;
      next.pendingQuestion = question;
      next.transcript = [...next.transcript, { role: "intern", text: question }];
      return { teaching: next, replies: [question] };
    }
    next.phase = "ready";
    next.pendingQuestion = null;
    const preview = next.explanation.trim().split("\n")[0].slice(0, 220);
    const reply = `I'll follow this when I do ${node.title}:\n\n> ${preview}\n\nSave it and the node unlocks. I won't use it until you do.`;
    return { teaching: next, replies: [reply] };
  }

  if (/^(save|unlock|yes|do it)\b/i.test(userText.trim())) {
    return { teaching: next, replies: [] };
  }
  const reply = "I added that to the note. Save when you want me to follow it.";
  return { teaching: next, replies: [reply] };
}

export function mockWork(task: string, skills: SkillNode[], nodes: SkillNode[]): Step[] {
  const primary = skills.slice().sort((a, b) => b.keywords.length - a.keywords.length)[0] ?? skills[0];
  const titles = skills.map((skill) => skill.title);
  const plan = `Plan: I'll use ${titles.join(" and ")}. Nothing locked is required.`;
  const done = `Done. I used ${titles.join(" and ")} and stayed inside ${titles.length > 1 ? "those notes" : "that note"}.`;
  const steps = script(task, primary);
  const proposal = followUpProposal(primary.id, new Set(nodes.map((node) => node.id)));
  const extra: Step[] = proposal
    ? [
        { type: "propose", proposal },
        {
          type: "say",
          text: `I could go further with ${proposal.title}, but you haven't taught me that. I added it as a proposed node. ${proposal.reason}`,
        },
      ]
    : [];
  return [{ type: "say", text: plan }, ...steps, { type: "say", text: done }, ...extra];
}

function script(task: string, skill: SkillNode): Step[] {
  switch (skill.id) {
    case "terminal-basics":
      return terminalScript(task);
    case "files-and-paths":
      return [
        edit("paths.txt", "Absolute paths start at /.\nRelative paths start at the folder you are in.\n"),
        run("pwd", "/home/desk/work"),
        run("ls -la", "total 4\n-rw-r--r-- 1 desk desk 72 Oct 25 06:40 paths.txt"),
      ];
    case "reading-errors":
      return [
        run(
          "python3 -c 'print(1/0)'",
          'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\nZeroDivisionError: division by zero',
          true,
        ),
        {
          type: "say",
          text: "The last line names the error. The line above it says where. I stopped there instead of changing the command.",
        },
      ];
    case "reading-docs":
      return [run("ls --help | head -n 5", "Usage: ls [OPTION]... [FILE]...\nList information about the FILEs.")];
    case "git-basics":
      return gitBasics(task);
    case "git-branching":
      return gitBranch(task);
    case "env-and-config":
      return [
        edit(".env.example", "APP_GREETING=hello\n"),
        run("test -f .env.example && echo 'example only, no secrets'", "example only, no secrets"),
      ];
    case "python-scripts":
      return pythonScript(task);
    case "functions-and-modules":
      return [
        edit("greet.py", "def greet(name: str) -> str:\n    return f\"hello {name}\"\n\n\nif __name__ == \"__main__\":\n    print(greet(\"intern\"))\n"),
        run("python3 greet.py", "hello intern"),
      ];
    case "http-requests":
      return [run("curl -sI https://example.com | head -n 4", "HTTP/1.1 200 OK\nContent-Type: text/html\n")];
    case "writing-tests":
      return [
        edit("test_hello.py", "def test_hello():\n    assert \"hello\".startswith(\"h\")\n"),
        run("python3 -m pytest -q test_hello.py", ". 1 passed"),
      ];
    case "shell-scripts":
      return [
        edit("work.sh", "#!/bin/bash\nset -eu\npwd\nls\n"),
        run("bash work.sh", "/home/desk/work\ntest_hello.py"),
      ];
    case "docker-basics":
      return [run("docker ps", "CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES")];
    case "debugging":
      return [
        edit("debug_note.py", "def add(a, b):\n    return a + b\n\nprint(add(2, 2))\n"),
        run("python3 debug_note.py", "4"),
      ];
    default:
      return [run("pwd", "/home/desk/work"), run("ls -la", "total 0")];
  }
}

function terminalScript(task: string): Step[] {
  if (/\bpwd\b|where am i|working directory/i.test(task)) return [run("pwd", "/home/desk")];
  if (/\bmkdir\b|folder called|directory called/i.test(task)) {
    const name = task.match(/(?:called|named)\s+([a-z0-9._-]+)/i)?.[1] ?? "notes";
    return [run(`mkdir -p ${shellName(name)}`, ""), run("ls -la", `total 4\ndrwxr-xr-x 2 desk desk 4096 Oct 25 06:40 ${name}`)];
  }
  return [
    run("pwd", "/home/desk"),
    run(
      "ls -la ~",
      [
        "total 28",
        "drwxr-xr-x 6 desk desk 4096 Oct 25 06:40 .",
        "drwxr-xr-x 3 root root 4096 Oct 25 06:12 ..",
        "drwxr-xr-x 2 desk desk 4096 Oct 25 06:40 Desktop",
        "drwxr-xr-x 2 desk desk 4096 Oct 25 06:40 Documents",
        "drwxr-xr-x 2 desk desk 4096 Oct 25 06:40 Downloads",
        "drwxr-xr-x 2 desk desk 4096 Oct 25 06:40 work",
        "-rw-r--r-- 1 desk desk   32 Oct 25 06:40 notes.txt",
      ].join("\n"),
    ),
  ];
}

function gitBasics(task: string): Step[] {
  if (/\bcommit\b/i.test(task)) {
    const message = task.match(/["']([^"']+)["']/)?.[1] ?? "Save the work";
    return [
      edit("README.md", "# work\n"),
      run("git add -A && git status --short", "A  README.md"),
      run(`git commit -m ${JSON.stringify(message)}`, `[main 1a2b3c4] ${message}\n 1 file changed, 1 insertion(+)`),
    ];
  }
  return [run("git status", "On branch main\nnothing to commit, working tree clean")];
}

function gitBranch(task: string): Step[] {
  const name = task.match(/(?:called|named)\s+([A-Za-z0-9._/-]+)/)?.[1] ?? "feature";
  return [
    run(`git switch -c ${shellName(name)}`, `Switched to a new branch '${name}'`),
    run("git status", `On branch ${name}\nnothing to commit, working tree clean`),
  ];
}

function pythonScript(task: string): Step[] {
  const printed = task.match(/prints?\s+"([^"]+)"/i)?.[1]
    ?? task.match(/prints?\s+'([^']+)'/i)?.[1]
    ?? task.match(/prints?\s+([a-z0-9][\w .-]{0,40})/i)?.[1]?.trim()
    ?? "hello";
  const content = `# ${task.trim().slice(0, 80)}\n\ndef main() -> None:\n    print(${JSON.stringify(printed)})\n\n\nif __name__ == "__main__":\n    main()\n`;
  return [edit("task.py", content), run("python3 task.py", printed)];
}

function run(command: string, output: string, error = false): Step {
  return { type: "run", command, output, error };
}

function edit(name: string, content: string): Step {
  return { type: "edit", path: `/home/desk/work/${name}`, content };
}

function shellName(name: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(name) ? name : "work";
}

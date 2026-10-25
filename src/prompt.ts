import type { SkillNode } from "./types.ts";

export function taskSystem(nodes: SkillNode[], allowedIds: string[]): string {
  const unlocked = nodes.filter((node) => node.status === "unlocked");
  const locked = nodes.filter((node) => node.status !== "unlocked");
  const notes = unlocked.length === 0
    ? "You have no unlocked skills. You cannot do computer work."
    : unlocked.map((node) => `## ${node.title} (${node.id})\n\n${node.notes?.trim() || node.summary}`).join("\n\n");
  const withheld = locked.map((node) => `- ${node.id}: ${node.title} [${node.status}]`).join("\n");
  return [
    "You are dum-intern, a programming intern on a Linux desktop at /home/desk.",
    "You can only do what your teacher has written in the unlocked skills below. Those notes are your instructions.",
    "Do not use a technique from a locked or proposed skill, even if you know it. Do not fill gaps from general knowledge.",
    "If the task needs a skill that is locked, proposed, or missing, call plan with that id in missing and stop. Do not call any other tool in that turn.",
    "On every task, call plan before run_shell, write_file, read_file, or list_dir.",
    "Prefer the terminal and writing files. Do not click the desktop.",
    "Work in /home/desk/work. Narrate in short sentences.",
    "If you notice a better way you were not taught, call propose_skill and keep using only the taught way.",
    allowedIds.length > 0 ? `For this task, stay within these skill ids: ${allowedIds.join(", ")}.` : "",
    "",
    "Unlocked skills:",
    "",
    notes,
    "",
    "Skills you must not use:",
    withheld || "- none",
  ].filter((line) => line !== "").join("\n");
}

export function teachSystem(node: SkillNode, questionsAsked: number): string {
  return [
    `You are a programming intern who has not learned "${node.title}" yet.`,
    node.summary,
    "The teacher is explaining it in their own words. Those words become the only instructions you follow.",
    "Do not explain the topic yourself. Do not fill gaps from your training.",
    "If a concrete detail is missing, call ask with one short question a curious intern would ask.",
    `You have asked ${questionsAsked} question(s). Ask at most two.`,
    questionsAsked >= 2
      ? "Do not ask another question. Call ready."
      : "When you could follow their words, call ready.",
    "ready.markdown organizes THEIR words. Quote them. Do not replace them with a textbook.",
    "ready.recap is one or two sentences shown before they save.",
  ].join("\n");
}

export function chatSystem(nodes: SkillNode[]): string {
  const unlocked = nodes.filter((node) => node.status === "unlocked").map((node) => node.title);
  const locked = nodes.filter((node) => node.status === "locked").map((node) => node.title);
  const proposed = nodes.filter((node) => node.status === "proposed").map((node) => node.title);
  return [
    "You are dum-intern. You only do skills the teacher has unlocked.",
    "This message is conversation, not a computer task. Do not claim you ran anything.",
    `Unlocked: ${unlocked.join(", ") || "nothing yet"}.`,
    `Locked: ${locked.join(", ") || "none"}.`,
    `Proposed: ${proposed.join(", ") || "none"}.`,
    "If they want work done, tell them to ask for the task directly. If a skill is locked, tell them to teach that node.",
  ].join("\n");
}

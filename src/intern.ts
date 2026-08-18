// The intern and the wizard.
//
// Two different jobs, deliberately not merged:
//
//   The intern asks what it needs in order to build the right thing. It does
//   not teach. It assumes you know the answer and are just being vague.
//
//   The wizard teaches a concept you don't have. It never answers the intern's
//   question for you, because the whole point is that you make the call.
//
// Which one you are talking to is YOUR decision, not the model's. Asking a
// model to guess whether you are being vague or are ignorant is unreliable and
// slightly insulting, and it gets the interesting case wrong: you cannot be
// vague about a concept you have never heard of.

import { ask, extractJson } from "./claude.ts";
import { describe, type Repo } from "./repo.ts";

export type Question = { question: string; why_it_matters: string };
export type Lesson = {
  concept: string;
  what_it_is: string;
  why_it_exists: string;
  in_industry: string;
  here: string;
};

/**
 * Questions the intern needs answered before it can build the right thing.
 *
 * The count is deliberately not fixed. A tool that interrogates you over a
 * one-line change is a tool you turn off in a week, and then it protects
 * nothing. Silence on trivial work is a feature.
 */
export function interrogate(request: string, repo: Repo): Question[] {
  const prompt = `An engineer is about to have you build something. Before you write any code,
ask what you actually need to know.

THEIR REQUEST:
${request}

${describe(repo)}

Rules for your questions:
- Ask ONLY about decisions that change what gets built. If two reasonable
  answers produce the same code, it is not worth asking.
- Ask about the decisions THEY must own: scope, failure behavior, what happens
  to existing data, which cases are in and out. Not preferences you could
  reasonably pick yourself.
- Never ask something the repo already answers. You can see the file list and
  the README - use them.
- ONE decision per question. If your question contains "and", "or if", or a
  parenthetical follow-up, you have written two questions - split them, or drop
  the weaker one. A question the engineer must answer twice is a question they
  will answer badly, and it defeats the wizard: they cannot call it on half a
  question.
- Ask as few as the work honestly needs. A trivial change may need zero. A
  vague, load-bearing change may need five. NEVER exceed five.
- Write them so someone who does not know the underlying concept will notice
  that they don't. Name the real thing ("rate limit per user or per IP?"),
  don't smooth it into something answerable by vibes.

Reply with ONLY a JSON array, no prose and no code fence. An empty array is a
valid and correct answer for genuinely trivial work:
[{"question": "...", "why_it_matters": "one sentence on what changes based on the answer"}]`;

  const questions = extractJson<Question[]>(ask(prompt));
  if (!Array.isArray(questions)) throw new Error("intern did not return a list of questions");
  return questions.slice(0, 5);
}

/**
 * The wizard: you called it, so you are telling it you don't have the concept.
 *
 * It teaches and then gets out of the way. It must not pick for you - a wizard
 * that answers the question has just written your spec, which is the failure
 * mode this whole program exists to prevent.
 */
export function wizard(question: Question, request: string, repo: Repo): Lesson {
  const prompt = `An engineer hit a question they cannot answer, and they have explicitly asked
you to teach them the concept behind it. They are a competent builder with real
shipped projects but no formal coursework in systems topics - assume they can
read code and have never been handed the vocabulary.

THE QUESTION THAT STOPPED THEM:
${question.question}

WHAT THEY ARE TRYING TO BUILD:
${request}

${describe(repo)}

Teach the ONE concept they are missing. Rules:
- Do NOT answer the question for them. Do not recommend an option, do not say
  which is best for their case, do not hint. They make the call; you are here
  so that they can. This is the most important rule.
- Name the concept the way the industry names it, so the words are searchable
  and usable in an interview.
- Explain why it EXISTS - what goes wrong without it. A concept without its
  failure mode is trivia.
- Say how it is actually used in industry: where it shows up, what the standard
  approaches are, what a team would argue about. Be concrete and name real
  practice. This is the part they cannot get from a definition.
- Ground it in THIS repo, using files you can actually see in the listing.
- Plain language. No hedging, no "it depends" without saying what it depends on.

Reply with ONLY a JSON object, no prose and no code fence:
{"concept": "the name",
 "what_it_is": "2-3 sentences",
 "why_it_exists": "2-3 sentences on what breaks without it",
 "in_industry": "3-5 sentences on real-world use and the live tradeoffs",
 "here": "2-3 sentences on what it would mean in this specific repo"}`;

  return extractJson<Lesson>(ask(prompt));
}

/**
 * Turn the interrogation into something buildable.
 *
 * The output goes to the coding agent, but it is written to be read by the
 * engineer first - if you cannot recognize your own decisions in it, the
 * interrogation failed and you should say so before any code exists.
 */
export function sharpen(
  request: string,
  answered: { question: string; answer: string }[],
  repo: Repo,
): string {
  const prompt = `Write the build spec for the work below.

ORIGINAL REQUEST:
${request}

DECISIONS THE ENGINEER MADE:
${answered.map((x) => `Q: ${x.question}\nA: ${x.answer}`).join("\n\n")}

${describe(repo)}

Rules:
- Every decision above must appear in the spec as a decision, in their words'
  meaning if not their exact words. They should be able to read it and see
  their own choices.
- Do NOT add scope. If they didn't ask for it and you didn't ask about it, it
  is not in the spec. Note it under "explicitly out of scope" instead.
- If an answer was so vague it does not constrain the code, say so plainly
  under "still unresolved" rather than quietly picking something.
- Be concrete about files and behavior. This is going to a coding agent.

Reply with ONLY the spec as markdown. No preamble, no code fence around the
whole thing.`;

  return ask(prompt).trim();
}

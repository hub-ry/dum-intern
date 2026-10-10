// Authored study material for the first goal: JavaScript for...of loops and if conditions. Every
// sample's output below was worked out by reading the code, not by running it, and each one says
// so. Keep the samples small enough that a reader can trace them by hand.

import { randomUUID } from "node:crypto";
import type { Material } from "./types.ts";

export const LOOPS_CONCEPT = "loops";
export const CONDITIONS_CONCEPT = "conditions";
export const COMBINED_CONCEPT = "loops with conditions";

const LOOPS_BODY = `# Visiting every item with for...of

A loop repeats one action for each item. In these examples, the list stays unchanged and the loop has no early exit, so each item is visited exactly once, in order. An empty list means no visits. The JavaScript examples below are optional; you can predict the result and explain the rule without writing any code.

\`\`\`js
const creatures = ["Mossy", "Pip", "Tangle"];
for (const name of creatures) {
  console.log("visiting " + name);
}
console.log("done");
\`\`\`

Expected output (worked out by reading the code, not by running it):

\`\`\`
visiting Mossy
visiting Pip
visiting Tangle
done
\`\`\`

Three items, so the body runs exactly three times: once with \`name\` as "Mossy", once as "Pip", once as "Tangle". The line after the loop runs once, after the loop has finished.

## Exactly once per item

With that unchanged list and no early exit, the loop doesn't skip an item or visit the same position twice. If the list holds the same value twice, there are still two items to visit:

\`\`\`js
const hungers = [3, 8, 5];
let total = 0;
for (const hunger of hungers) {
  total = total + hunger;
}
console.log(total);
\`\`\`

Expected output (by reasoning, not executed):

\`\`\`
16
\`\`\`

Trace it: \`total\` starts at 0, becomes 3, then 11, then 16. The body ran three times for three items.

## An empty array means zero passes

If the array has no items, the body never runs. That is not an error; the program just carries on after the loop.

\`\`\`js
const empty = [];
for (const item of empty) {
  console.log("never printed");
}
console.log("loop finished with nothing to visit");
\`\`\`

Expected output (by reasoning, not executed):

\`\`\`
loop finished with nothing to visit
\`\`\`

## Things to notice

- \`for (const name of creatures)\` reads as "for each name in creatures".
- The item variable is new on each pass. Using \`const\` is fine because the loop makes a fresh binding every time; you only need \`let\` when you reassign it inside the body.
- for...of gives you the items themselves. If you need the position number, that is a different tool (\`entries()\` or a counting loop), so do not expect \`name\` to be 0, 1, 2.
- The array is visited in order, first to last.

## Try before teaching

Imagine visiting Mossy, Pip, and Tangle in order and saying each name followed by an exclamation mark. Predict the three lines, then explain what changes when the list is empty. Try the same rule with a different list. You don't need to write the loop.`;

const CONDITIONS_BODY = `# Choosing with if and else

A condition chooses what to do. When the condition is true, one action runs; when it's false, the other action runs. In an if/else, exactly one of the two blocks runs. The JavaScript examples below are optional; focus on predicting which action is chosen.

\`\`\`js
const hunger = 7;
const threshold = 5;
if (hunger > threshold) {
  console.log("feed");
} else {
  console.log("skip");
}
\`\`\`

Expected output (worked out by reading the code, not by running it):

\`\`\`
feed
\`\`\`

\`7 > 5\` is true, so the first block runs and "skip" is never printed.

## Show both branches

To understand a condition, find an input for each branch. With \`hunger = 2\` the comparison \`2 > 5\` is false, so the expected output is:

\`\`\`
skip
\`\`\`

A condition you have only ever seen go one way is a condition you have not finished learning.

## Greater than versus greater than or equal

\`>\` and \`>=\` differ only when the two values are equal:

| hunger | threshold | hunger > threshold | hunger >= threshold |
| ------ | --------- | ------------------ | ------------------- |
| 7      | 5         | true               | true                |
| 5      | 5         | false              | true                |
| 2      | 5         | false              | false               |

So with \`hunger = 5\` the first sample prints "skip" using \`>\`, but would print "feed" if the condition were \`hunger >= threshold\`. Decide on purpose whether the boundary value counts.

## Assignment is not equality

- \`=\` assigns. \`hunger = 5\` puts 5 into \`hunger\`.
- \`===\` compares. \`hunger === 5\` asks whether \`hunger\` holds 5 and gives true or false.

Mixing them up is a classic bug:

\`\`\`js
let hunger = 2;
if (hunger === 5) {
  console.log("exactly five");
} else {
  console.log("not five");
}
\`\`\`

Expected output (by reasoning, not executed):

\`\`\`
not five
\`\`\`

If that condition were written \`if (hunger = 5)\` it would no longer compare anything: it would assign 5 to \`hunger\`, and the value of that assignment, 5, counts as true. The "exactly five" block would run no matter what \`hunger\` had been. Use \`===\` for comparisons. Avoid the two-character \`==\`, which converts types before comparing and surprises people.

## Try before teaching

The rule is: rest when a creature's energy is below 3, otherwise play. Predict the action for energy 2, 3, and 4. Then change the rule to rest when energy is 3 or less. Which prediction changes? Explain the boundary in your own words; no code needed.`;

const COMBINED_BODY = `# Loops and conditions together

The two ideas combine naturally: visit every item, and for each one choose what to do. The list below stays unchanged and there are no early exits. The optional JavaScript example spells out the same rule.

\`\`\`js
const creatures = [
  { name: "Mossy", hunger: 8 },
  { name: "Pip", hunger: 2 },
  { name: "Tangle", hunger: 5 },
];
const threshold = 5;
for (const creature of creatures) {
  if (creature.hunger >= threshold) {
    console.log(creature.name + " gets food");
  } else {
    console.log(creature.name + " is fine for now");
  }
}
\`\`\`

Expected output (worked out by reading the code, not by running it):

\`\`\`
Mossy gets food
Pip is fine for now
Tangle gets food
\`\`\`

Trace it one item at a time:

1. Mossy: \`8 >= 5\` is true, so the first branch runs.
2. Pip: \`2 >= 5\` is false, so the else branch runs.
3. Tangle: \`5 >= 5\` is true (equal counts for \`>=\`), so the first branch runs.

If the condition used \`>\` instead, Tangle's line would read "Tangle is fine for now", because \`5 > 5\` is false. Everything else would stay the same.

With an empty \`creatures\` array the loop body never runs, so nothing at all is printed.

## Try before teaching

Imagine a fourth creature with hunger exactly at the threshold. Predict whether it gets food when the rule is "at least the threshold" and when the rule is "above the threshold." Then explain, without looking, why this unchanged list gets one visit per item and how the rule picks the action. Try another hunger value before teaching Dum your explanation.`;

/** Fresh copies of the authored materials with new ids, for one goal. */
export function loopsAndConditionsMaterials(): Material[] {
  return [
    {
      id: randomUUID(),
      concept: LOOPS_CONCEPT,
      title: "Visiting every item with for...of",
      body: LOOPS_BODY,
      url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/for...of",
    },
    {
      id: randomUUID(),
      concept: CONDITIONS_CONCEPT,
      title: "Choosing with if and else",
      body: CONDITIONS_BODY,
      url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/if...else",
    },
    {
      id: randomUUID(),
      concept: COMBINED_CONCEPT,
      title: "Loops and conditions together",
      body: COMBINED_BODY,
    },
  ];
}

// The homepage preview is a scripted illustration, not a live model session.
const scenarios = {
  build: {
    label: "Dum asks for your thinking before it reaches for code.",
    user: "Can you build a cache for my app?",
    dum: "I can help once this skill is unlocked. What should the cache do when it runs out of space?",
    wizard: "Start with the tradeoff: keep the oldest item, or the least recently used? Pick the rule and explain why."
  },
  explain: {
    label: "Explain it simply. Find the shaky part. Then make the next move.",
    user: "A cache keeps things so the app can reuse them faster. I’d remove the oldest item first.",
    dum: "That gives you a clear limit. One question: if an item is used again, should it still count as the oldest?",
    wizard: "That question separates insertion order from recent use. A tiny example will make the difference obvious."
  },
  story: {
    label: "After the build, share the decisions. Dum remembers the reasoning.",
    user: "I built the cache with a maximum size. I evict the least recently used item because recent work is more likely to be needed again.",
    dum: "Got it: bounded storage, with recent use deciding what stays. I’ll keep that tradeoff in mind for this project.",
    wizard: "A useful explanation connects the rule to the reason. It can guide future work without pretending to prove who wrote the code."
  }
};

const demo = document.querySelector("[data-demo]");
if (demo) {
  const buttons = [...demo.querySelectorAll("[data-scene]")];
  const label = demo.querySelector("[data-demo-label]");
  const user = demo.querySelector("[data-demo-user]");
  const dum = demo.querySelector("[data-demo-dum]");
  const wizard = demo.querySelector("[data-demo-wizard]");

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const scene = scenarios[button.dataset.scene];
      if (!scene) return;
      for (const option of buttons) option.setAttribute("aria-pressed", String(option === button));
      label.textContent = scene.label;
      user.textContent = scene.user;
      dum.textContent = scene.dum;
      wizard.textContent = scene.wizard;
    });
  }
}

// The homepage preview is scripted, not a live model session.
const scenarios = {
  build: {
    label: "Dum asks how you'd do it before it writes anything.",
    user: "Can you build a cache for my app?",
    dum: "I can help once this skill is unlocked. What should the cache do when it runs out of space?",
    wizard: "Start with the tradeoff: drop the oldest item, or the least recently used? Pick one and say why."
  },
  explain: {
    label: "Explain it plainly and find the part you're unsure about.",
    user: "A cache keeps things so the app can reuse them faster. I’d remove the oldest item first.",
    dum: "That gives you a clear limit. One question: if an item gets used again, is it still the oldest?",
    wizard: "That's the difference between oldest-added and least-recently-used. Try it on three items and see."
  },
  story: {
    label: "After you build it, tell Dum what you decided. It remembers why.",
    user: "I built the cache with a maximum size. I evict the least recently used item because recent work is more likely to be needed again.",
    dum: "Got it: bounded storage, and recent use decides what stays. I'll keep that in mind for this project.",
    wizard: "You tied the rule to a reason. That's the part worth keeping."
  },
  quiet: {
    label: "Dum goes quiet and sits by your editor until you need it.",
    user: "",
    dum: "",
    wizard: ""
  }
};

const demo = document.querySelector("[data-demo]");
if (demo) {
  const buttons = [...demo.querySelectorAll("[data-scene]")];
  const panel = demo.querySelector("[data-demo-panel]");
  const label = demo.querySelector("[data-demo-label]");
  const user = demo.querySelector("[data-demo-user]");
  const dum = demo.querySelector("[data-demo-dum]");
  const wizard = demo.querySelector("[data-demo-wizard]");

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const scene = scenarios[button.dataset.scene];
      if (!scene) return;
      for (const option of buttons) option.setAttribute("aria-pressed", String(option === button));
      panel.dataset.attention = button.dataset.scene === "quiet" ? "quiet" : "active";
      label.textContent = scene.label;
      user.textContent = scene.user;
      dum.textContent = scene.dum;
      wizard.textContent = scene.wizard;
    });
  }
}

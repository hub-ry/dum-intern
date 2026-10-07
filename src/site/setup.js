const button = document.querySelector("[data-copy-target]");
const target = button && document.getElementById(button.dataset.copyTarget);

if (button && target) {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(target.textContent ?? "");
      button.textContent = "copied";
      window.setTimeout(() => { button.textContent = "copy"; }, 1400);
    } catch {
      button.textContent = "select the text";
    }
  });
}

# Dum

Dum is a Zed fork for visible pair programming with dum-intern.

Dum adds intern features alongside Zed’s existing AI providers, account settings, agent panel, and editing tools.

On macOS, run `./script/dum` to build and open a separate development app with its own data. Run `./script/dum --watch` to rebuild and restart it when source files change. The launcher uses GPUI's runtime shader compilation, so this development path does not require the offline Metal compiler. Install Rust through rustup and have Apple's command-line tools and CMake available.

Open **Interns** in the status bar or press **Cmd+Option+Shift+I** to create and configure interns. Each profile has its own provider, model, endpoint, API key and skill policy. DeepSeek has a preset for `deepseek-flash` at `https://api.deepseek.com`, matching its [current API documentation](https://api-docs.deepseek.com/quick_start/pricing/). Keys are saved in the system keychain; nonsecret profiles are saved to `interns.json` in Dum's data directory.

Interns uses a character roster with details for the selected intern. Click the selected intern’s avatar to choose its shape and color; existing interns save these choices immediately, and mentions use the same avatar. Use **Add bot** at the top of the roster to create an intern. New interns inherit the selected intern’s provider. Connection details start collapsed. Use the **+** next to **Skills** to import Markdown skill files.

Use **Description** to set the intern's role and working style as system-level guidance. The field supports multiple lines; **Cmd+Return** inserts a newline, and blank lines are preserved. Skills remain separate capability guidance and unlocks.

Use **Import intern** in the roster to open a `.intern` file. **Export intern** in the selected intern's details saves its name, character, description, work policy, and imported skill contents as a self-contained JSON file. Learned examples are excluded by default; **Export with learned skills** includes them after a reminder that they may contain private project code. Connections, endpoints, API keys, account credentials, and local identifiers are excluded. Imports receive fresh identifiers and a numbered name when needed, then open Connection so the recipient can choose their own provider. Files use the versioned `dum.intern` format; skill files are embedded as text rather than extracted to disk.

Choose **ChatGPT Subscription** or **SuperGrok** in Interns to use an existing eligible subscription. Sign in through the provider's account control, choose an account model. Provider and account-model selections save immediately for existing interns. No API key is needed for these connections. Interns using the same subscription share one signed-in account and its usage limits. Account sign-in is separate from API billing. DeepSeek remains available with a per-intern API key.

`dum-intern` starts restricted to unlocked skills. Imported Markdown files unlock skills explicitly. An intern set to **Allow new work** can attempt work beyond its skill tree. Intern edits save automatically. Text fields save after a short pause; invalid names keep the last valid saved profile. Learned skills and imported skills retain their source; project coding style is independent of either policy. Background observation is not connected yet. Assignments use Zed’s existing provider and streaming implementations; DeepSeek credentials remain isolated per intern.

On a blank code line, type **@** or press **Cmd+Enter** to mention an intern. Type part of its name to filter the picker, then select it with Enter, Tab, or a click. The name becomes a colored mention; continue typing the assignment on the same line and press Enter to submit. The composer replaces the blank line visually without saving mention text or comments into your source. Escape dismisses suggestions, then cancels the composer.

Enter `demo` after the selected name to watch a scripted function appear with its own cursor. Pause, resume, stop and undo controls appear inline. The completion notice clears after three seconds or when you resume editing; normal editor undo remains available. Literal `@` characters in existing code and pasted text keep their normal behavior.

`frontend-demo` is a second scripted preview requiring the `frontend` skill. A restricted intern leaves an inline TODO until you import `frontend.md`; an unrestricted intern can run it immediately. Markdown file stems are the skill identifiers. These previews verify the policy path without sending code to a provider. Other assignments call the configured DeepSeek model with the nearby code and unlocked skill guidance. The response must declare its required skills before any edit is applied. Missing skills, invalid responses, authentication errors, or a changed target leave an inline TODO. Stop cancels the pending request. This is one insertion at the chosen blank line, not Zed’s full agent tool loop.

Source changes require compilation; this is a rebuild-and-relaunch loop. Save playground changes before a watched rebuild restarts the app. The generated app is `target/debug/Dum.app`, and development state lives under `target/dum-dev-data`.

Quit an already-open development app before starting a new launcher. This keeps two Dum processes from sharing the same development database.

## Upstream Zed

[![Zed](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/zed-industries/zed/main/assets/badge/v0.json)](https://zed.dev)
[![CI](https://github.com/zed-industries/zed/actions/workflows/run_tests.yml/badge.svg)](https://github.com/zed-industries/zed/actions/workflows/run_tests.yml)

Welcome to Zed, a high-performance, multiplayer code editor from the creators of [Atom](https://github.com/atom/atom) and [Tree-sitter](https://github.com/tree-sitter/tree-sitter).

---

For a local standalone Mac app, run `python3 script/dum --install`. This builds with embedded assets, installs `/Applications/Dum.app` with its own icon, and signs the local bundle. On the first install, it copies development interns and settings into Dum's normal user directories, backing up any older data first. Later installs keep the installed profile. This local preview disables upstream auto-updates. Open Dum from Applications or Spotlight; no development launcher is needed.

### Installation

On macOS, Linux, and Windows you can [download Zed directly](https://zed.dev/download) or install Zed via your local package manager ([macOS](https://zed.dev/docs/installation#macos)/[Linux](https://zed.dev/docs/linux#installing-via-a-package-manager)/[Windows](https://zed.dev/docs/windows#package-managers)).

Other platforms are not yet available:

- Web ([tracking discussion](https://github.com/zed-industries/zed/discussions/26195))

### Developing Zed

- [Building Zed for macOS](./docs/src/development/macos.md)
- [Building Zed for Linux](./docs/src/development/linux.md)
- [Building Zed for Windows](./docs/src/development/windows.md)

### Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for ways you can contribute to Zed.

Also... we're hiring! Check out our [jobs](https://zed.dev/jobs) page for open roles.

### Licensing

Zed source code is licensed primarily under GPL-3.0-or-later, with Apache-2.0 components where marked.

License information for third party dependencies must be correctly provided for CI to pass.

We use [`cargo-about`](https://github.com/EmbarkStudios/cargo-about) to automatically comply with open source licenses. If CI is failing, check the following:

- Is it showing a `no license specified` error for a crate you've created? If so, add `publish = false` under `[package]` in your crate's Cargo.toml.
- Is the error `failed to satisfy license requirements` for a dependency? If so, first determine what license the project has and whether this system is sufficient to comply with this license's requirements. If you're unsure, ask a lawyer. Once you've verified that this system is acceptable add the license's SPDX identifier to the `accepted` array in `script/licenses/zed-licenses.toml`.
- Is `cargo-about` unable to find the license for a dependency? If so, add a clarification field at the end of `script/licenses/zed-licenses.toml`, as specified in the [cargo-about book](https://embarkstudios.github.io/cargo-about/cli/generate/config.html#crate-configuration).

## Sponsorship

Zed is developed by **Zed Industries, Inc.**, a for-profit company.

If you’d like to financially support the project, you can do so via GitHub Sponsors.
Sponsorships go directly to Zed Industries and are used as general company revenue.
There are no perks or entitlements associated with sponsorship.

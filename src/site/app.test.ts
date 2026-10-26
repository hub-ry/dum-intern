import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";

class Element {
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: any) => unknown>();
  value = "";
  disabled = false;
  className = "";
  classList = { toggle() {} };
  private text = "";

  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  get childNodes() { return this.children; }
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(""); }
  set textContent(text: string) { this.text = text; this.children = []; }
  get elements() { return { namedItem: (name: string) => this.find((node) => node.attributes.get("name") === name) }; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.text = ""; this.children = children; }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name === "value") this.value = value;
    if (name === "disabled") this.disabled = true;
  }
  addEventListener(name: string, listener: (event: any) => unknown) { this.listeners.set(name, listener); }
  focus() {}
  find(predicate: (node: Element) => boolean): Element | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const found = child.find(predicate);
      if (found) return found;
    }
  }
  querySelector(selector: string) {
    assert.equal(selector, 'button[type="submit"]');
    return this.find((node) => node.tagName === "button" && node.attributes.get("type") === "submit");
  }
  fire(name: string) {
    const target = new Proxy(this, {
      get: (node, key) => key in node ? Reflect.get(node, key) : node.elements.namedItem(String(key)),
    });
    return Promise.resolve(this.listeners.get(name)?.({ preventDefault() {}, target, currentTarget: this }));
  }
}

async function until(predicate: () => unknown) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Client did not reach the expected state");
    await setImmediate();
  }
}

test("workspace work stays in its session while authentication and hints remain independent", async (t) => {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return next(specifier === "/pair.js" ? new URL("./pair.js", import.meta.url).href : specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const root = new Element("main");
  for (const id of ["view", "status", "app-navigation"]) {
    const node = new Element("div");
    node.setAttribute("id", id);
    root.append(node);
  }
  const find = (predicate: (node: Element) => boolean) => {
    const node = root.find(predicate);
    assert.ok(node, "Expected client control");
    return node;
  };
  const button = (text: string) => find((node) => node.tagName === "button" && node.textContent === text);
  const submit = async (label: string, fields: Record<string, string> = {}) => {
    const form = find((node) => node.tagName === "form" && !!node.find((child) => child.tagName === "button" && child.textContent === label));
    for (const [name, value] of Object.entries(fields)) {
      const input = form.elements.namedItem(name);
      assert.ok(input);
      input.value = value;
      await input.fire("input");
    }
    return form.fire("submit");
  };
  const requests: { path: string; login: string | null; body: any }[] = [];
  const trees = new Map<string, { goals: any[]; skills: any[]; builds: any[] }>();
  const tree = (login: string) => {
    if (!trees.has(login)) trees.set(login, { goals: [], skills: [], builds: [] });
    return trees.get(login)!;
  };
  let login: string | null = "alice";
  let failLogout = false;
  const held = new Map<string, { promise: Promise<void>; release: () => void }>();
  const hold = (key: string) => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    held.set(key, { promise, release });
    return release;
  };
  const releaseTopic = hold("Alice private topic");
  const globals = {
    Node: Element,
    document: {
      getElementById: (id: string) => root.find((node) => node.attributes.get("id") === id),
      createElement: (tag: string) => new Element(tag),
      createTextNode: (text: string) => { const node = new Element("#text"); node.textContent = text; return node; },
    },
    location: new URL("http://localhost/?tab=tree"),
    history: { replaceState() {} },
    fetch: async (path: string, options: { body?: string } = {}) => {
      const body = JSON.parse(options.body ?? "{}");
      const account = login;
      requests.push({ path, login: account, body });
      if (path === "/api/logout") {
        if (failLogout) throw new TypeError("Failed to fetch");
        await held.get("logout")?.promise;
        login = null;
        return Response.json({ ok: true });
      }
      if (path === "/api/auth/start") return Response.json({ code: "gist-code", login: body.login });
      if (path === "/api/auth/finish") { login = body.login; return Response.json({}); }
      if (path === "/api/me") return Response.json({ account: login ? { login, root: "dum" } : null, oauth: false });
      assert.ok(account);
      if (path === "/api/workspace") return Response.json({ tree: tree(account), account: { path: `/workspace/${account}` } });
      if (path === "/api/goals") {
        tree(account).goals.unshift({ id: String(requests.length), title: body.title, aim: body.aim });
        const response = Response.json({ tree: tree(account) });
        await held.get(body.title)?.promise;
        return response;
      }
      if (path.startsWith("/api/hints?")) {
        await held.get("hints")?.promise;
        return Response.json({ learn: [], build: [] });
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  };
  const saved = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  t.after(() => {
    for (const request of held.values()) request.release();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await import(new URL(`./app.js?test=${Date.now()}`, import.meta.url).href);
  await until(() => root.find((node) => node.tagName === "button" && node.textContent === "alice"));
  const topic = submit("Add to tree", { topic: "Alice private topic" });
  await until(() => requests.some((request) => request.body.title === "Alice private topic"));
  await button("Outline a goal").fire("click");
  const outline = submit("Lay out the tree", { title: "Alice private goal", aim: "Alice private aim", outline: "Alice private outline" });
  await setImmediate();
  assert.equal(requests.filter((request) => request.path === "/api/goals").length, 1);
  await button("alice").fire("click");
  await button("Sign out").fire("click");
  assert.ok(requests.some((request) => request.path === "/api/logout"));
  await submit("Get a code", { login: "bob" });
  const signIn = submit("Check the gist");
  await until(() => requests.some((request) => request.path === "/api/me" && request.login === "bob"));
  await until(() => root.find((node) => node.tagName === "button" && node.textContent === "bob"));
  await signIn;
  await button("Skill tree").fire("click");
  assert.equal(find((node) => node.attributes.get("id") === "topic").value, "");
  const releaseBob = hold("Bob topic");
  const bobTopic = submit("Add to tree", { topic: "Bob topic" });
  await until(() => requests.some((request) => request.body.title === "Bob topic"));
  const input = find((node) => node.attributes.get("id") === "topic");
  input.value = "Bob next topic";
  await input.fire("input");
  releaseTopic();
  await Promise.all([topic, outline]);
  assert.deepEqual(tree("bob").goals.map((goal) => goal.title), ["Bob topic"], "Alice's queued private goal must never be persisted as Bob");
  assert.equal(requests.filter((request) => request.path === "/api/goals" && request.login === "alice").length, 1);
  assert.ok(root.find((node) => node.tagName === "button" && node.textContent === "bob"));
  await button("bob").fire("click");
  await button("Skill tree").fire("click");
  assert.equal(button("Add to tree").disabled, true, "Alice's late completion must not clear Bob's pending state");
  assert.equal(find((node) => node.attributes.get("id") === "topic").value, "Bob next topic");
  await submit("Add to tree");
  assert.equal(requests.filter((request) => request.path === "/api/goals" && request.login === "bob").length, 1);
  assert.equal(root.textContent.includes("Alice private"), false);
  await button("Outline a goal").fire("click");
  const bobOutline = submit("Lay out the tree", { title: "Bob outlined goal", aim: "Bob aim", outline: "Bob block" });
  await setImmediate();
  assert.equal(requests.some((request) => request.body.title === "Bob outlined goal"), false);
  releaseBob();
  await Promise.all([bobTopic, bobOutline]);
  assert.deepEqual(tree("bob").goals.map((goal) => goal.title), ["Bob outlined goal", "Bob topic"]);
  assert.ok(root.textContent.includes("Bob outlined goal"));
  assert.equal(find((node) => node.attributes.get("id") === "topic").value, "Bob next topic");
  assert.equal(button("Add to tree").disabled, false);
  await button("Outline a goal").fire("click");
  const releaseOutline = hold("Bob delayed outline");
  const delayedOutline = submit("Lay out the tree", { title: "Bob delayed outline", aim: "Bob private aim", outline: "Bob private block" });
  await until(() => requests.some((request) => request.body.title === "Bob delayed outline"));
  await button("bob").fire("click");
  await button("Sign out").fire("click");
  await submit("Get a code", { login: "carol" });
  await submit("Check the gist");
  const before = root.textContent;
  releaseOutline();
  await delayedOutline;
  assert.equal(root.textContent, before, "An old outline response must not alter the new session's view or status");
  await button("Skill tree").fire("click");
  assert.equal(root.textContent.includes("Bob"), false);
  assert.equal(find((node) => node.attributes.get("id") === "topic").value, "");
  await submit("Add to tree", { topic: "Carol topic" });
  const releaseHints = hold("hints");
  await button("Hints").fire("click");
  await until(() => requests.some((request) => request.path.startsWith("/api/hints?")));
  await button("carol").fire("click");
  await button("Sign out").fire("click");
  assert.equal(requests.filter((request) => request.path === "/api/logout").length, 3);
  const signedOut = root.textContent;
  releaseHints();
  await setImmediate();
  assert.equal(root.textContent, signedOut);
  await submit("Get a code", { login: "dave" });
  await submit("Check the gist");
  await button("Skill tree").fire("click");
  const privateDraft = find((node) => node.attributes.get("id") === "topic");
  privateDraft.value = "Dave's unsaved topic";
  await privateDraft.fire("input");
  await button("dave").fire("click");
  failLogout = true;
  await button("Sign out").fire("click");
  assert.ok(root.find((node) => node.attributes.get("id") === "login"), "Failed sign-out must still clear the local account view");
  assert.equal(root.find((node) => node.attributes.get("id") === "topic"), undefined);
  await submit("Get a code", { login: "erin" });
  await submit("Check the gist");
  await button("Skill tree").fire("click");
  assert.equal(find((node) => node.attributes.get("id") === "topic").value, "", "Failed sign-out must discard private topic drafts");
  await submit("Add to tree", { topic: "Erin topic" });
  assert.deepEqual(tree("erin").goals.map((goal) => goal.title), ["Erin topic"], "A fresh session must remain usable after failed sign-out");
  failLogout = false;
  await button("erin").fire("click");
  const releaseLogout = hold("logout");
  const pendingLogout = button("Sign out").fire("click");
  await until(() => requests.some((request) => request.path === "/api/logout" && request.login === "erin"));
  assert.equal(root.find((node) => node.attributes.get("id") === "login"), undefined, "A new sign-in must wait until the old sign-out response settles");
  releaseLogout();
  await pendingLogout;
  assert.ok(root.find((node) => node.attributes.get("id") === "login"));
});

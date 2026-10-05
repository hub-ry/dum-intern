// What the wizard is allowed to cite: a fixed catalog of short statements, each one checked
// against the primary source it links. The model picks an id; the words and the link come
// from here, never from the model. Add an entry only after reading the page it points at.

import { langName, langOf } from "./skills.ts";

export type Anchor = Readonly<{
  id: string;
  /** The primary source, shown as-is. */
  url: string;
  /** What the source says, in the wizard's voice, and nothing it doesn't. */
  claim: string;
  /** Words a request, a skill name or a path tends to use when this applies. */
  topics: readonly string[];
  /** Languages it is about; empty means any. */
  langs: readonly string[];
  /** Proper names the claim brings with it, so a connection may repeat them. */
  names: readonly string[];
}>;

const catalog: readonly Anchor[] = [
  {
    id: "git-diff",
    url: "https://git-scm.com/docs/git-diff",
    claim:
      "`git diff` compares saved work with the staging index; `--cached` compares staged work with HEAD.",
    topics: ["git", "diff", "staged", "staging", "index", "working tree", "commit", "changes"],
    langs: [],
    names: ["git", "head"],
  },
  {
    id: "git-add-patch",
    url: "https://git-scm.com/docs/git-add",
    claim:
      "`git add -p` walks the hunks between the work tree and the index one at a time, so you review the diff and stage only the parts you mean to.",
    topics: ["git", "stage", "staging", "commit", "hunk", "partial", "add"],
    langs: [],
    names: ["git"],
  },
  {
    id: "sqlite-transactions",
    url: "https://www.sqlite.org/lang_transaction.html",
    claim:
      "SQLite permits concurrent readers but only one writer, and implicit transactions commit after the last active statement finishes.",
    topics: ["sqlite", "sql", "database", "databases", "transaction", "transactions", "commit", "rollback", "concurrency", "lock", "writer", "readers"],
    langs: [],
    names: ["sqlite"],
  },
  {
    id: "python-sorting",
    url: "https://docs.python.org/3/howto/sorting.html",
    claim:
      "python's sorts are guaranteed stable, a key function is called exactly once per record, and `list.sort()` sorts in place while `sorted()` builds a new list.",
    topics: ["sort", "sorting", "sorted", "sorting with keys", "key", "lambdas", "lists", "order", "stable"],
    langs: ["python"],
    names: ["python"],
  },
  {
    id: "python-floats",
    url: "https://docs.python.org/3/tutorial/floatingpoint.html",
    claim:
      "`0.1` cannot be represented exactly as a binary float; Python's `decimal` module supports exact decimal arithmetic.",
    topics: ["float", "floats", "floating", "decimal", "money", "currency", "price", "rounding", "arithmetic", "cents", "precision"],
    langs: ["python"],
    names: ["python"],
  },
  {
    id: "python-eafp",
    url: "https://docs.python.org/3/glossary.html#term-EAFP",
    claim:
      "Python's EAFP style attempts an operation and catches failure, rather than checking every precondition first.",
    topics: ["exceptions", "exception", "try", "except", "error handling", "errors", "keyerror", "attributeerror", "dictionaries", "lookup", "validate", "check"],
    langs: ["python"],
    names: ["python", "eafp", "lbyl", "c"],
  },
  {
    id: "python-dict-order",
    url: "https://docs.python.org/3/library/stdtypes.html#dict",
    claim:
      "python dictionaries preserve insertion order; updating a key doesn't move it, and keys added after a deletion go at the end.",
    topics: ["dictionaries", "dictionary", "dict", "dicts", "order", "ordered", "insertion", "json", "mapping", "keys"],
    langs: ["python"],
    names: ["python"],
  },
  {
    id: "rust-ownership",
    url: "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
    claim:
      "the rust book's three ownership rules: each value has an owner, there's only one owner at a time, and when the owner goes out of scope the value is dropped.",
    topics: ["ownership", "borrowing", "move", "moved", "drop", "scope", "lifetimes", "clone", "borrow"],
    langs: ["rust"],
    names: ["rust"],
  },
  {
    id: "rust-iterators-lazy",
    url: "https://doc.rust-lang.org/book/ch13-02-iterators.html",
    claim:
      "rust iterators are lazy - adapters like `map` do nothing until something consumes the iterator, and the compiler warns about one that's never used.",
    topics: ["iterators", "iterator", "iter", "map", "filter", "collect", "lazy", "closures", "loops"],
    langs: ["rust"],
    names: ["rust"],
  },
  {
    id: "rust-question-mark",
    url: "https://doc.rust-lang.org/book/ch09-02-recoverable-errors-with-result.html",
    claim:
      "on a Rust Result, `?` returns an error early or yields the successful value; the enclosing return type must support that error propagation.",
    topics: ["result", "error propagation", "errors", "error handling", "unwrap", "expect", "option", "question mark", "?"],
    langs: ["rust"],
    names: ["rust"],
  },
  {
    id: "cpp-raii",
    url: "https://en.cppreference.com/w/cpp/language/raii",
    claim:
      "C++ RAII binds resource ownership to object lifetime, releasing acquired resources during destruction.",
    topics: ["raii", "destructors", "destructor", "constructors", "resource", "resources", "resource lifetimes", "cleanup", "leak", "mutex", "mutexes", "new and delete", "smart pointers", "file", "socket"],
    langs: ["c++"],
    names: ["raii"],
  },
  {
    id: "cpp-unique-ptr",
    url: "https://en.cppreference.com/w/cpp/memory/unique_ptr",
    claim:
      "`std::unique_ptr` owns the object it points at and disposes of it when the pointer goes out of scope, or when it's reset or assigned another pointer.",
    topics: ["smart pointers", "unique_ptr", "pointers", "new and delete", "ownership", "delete", "leak", "memory", "destructors"],
    langs: ["c++"],
    names: ["unique_ptr"],
  },
  {
    id: "node-fs-wx",
    url: "https://nodejs.org/api/fs.html#file-system-flags",
    claim:
      "Node's `'wx'` flag refuses an existing path, avoiding an existence-check-then-write race.",
    topics: ["files", "file", "write", "create", "exists", "race", "overwrite", "fs", "writefile", "open"],
    langs: ["javascript", "typescript"],
    names: ["node"],
  },
  {
    id: "js-array-sort",
    url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/sort",
    claim:
      "JavaScript's `Array.prototype.sort()` mutates its array and compares strings by default; `toSorted()` returns a sorted copy.",
    topics: ["sort", "sorting", "sorted", "array methods", "arrays", "order", "compare", "comparator", "stable"],
    langs: ["javascript", "typescript"],
    names: ["javascript", "es2019"],
  },
  {
    id: "http-idempotent",
    url: "https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods",
    claim:
      "HTTP defines PUT, DELETE, and safe methods as idempotent: repeating identical requests has the same intended server effect.",
    topics: ["http", "rest apis", "rest", "api", "retry", "retries", "put", "post", "delete", "get", "idempotent", "fetch", "request", "endpoint"],
    langs: [],
    names: ["rfc", "http", "put", "post", "delete", "get", "head", "options", "trace"],
  },
  {
    id: "go-defer",
    url: "https://go.dev/doc/effective_go#defer",
    claim:
      "go's `defer` schedules a call to run right before the surrounding function returns, whichever path it takes - effective go's canonical examples are unlocking a mutex and closing a file.",
    topics: ["defer", "cleanup", "close", "unlock", "mutexes", "mutex", "files", "resource", "errors"],
    langs: ["go"],
    names: ["go"],
  },
  {
    id: "go-errors",
    url: "https://go.dev/doc/effective_go#errors",
    claim:
      "Go conventionally returns errors alongside ordinary results using the `error` interface.",
    topics: ["errors", "error", "error handling", "multiple return values", "return values", "nil", "panic", "interfaces"],
    langs: ["go"],
    names: ["go"],
  },
];

const index: Record<string, Anchor> = Object.fromEntries(catalog.map((a) => [a.id, a]));

/** Every anchor, in catalog order. */
export const ANCHORS: readonly Anchor[] = catalog;

/** The anchor with this exact id, or undefined for anything the catalog never said. */
export function byId(id: string): Anchor | undefined {
  return Object.hasOwn(index, id) ? index[id] : undefined;
}


export type Moment = { request: string; skills?: string[]; lang?: string; paths?: string[] };

/**
 * The anchors that could be about this moment, best first, at most `limit`. Deterministic: the
 * same request, skills, language and paths always give the same list in the same order. Empty
 * when nothing in the catalog is about it - the wizard then has nothing to cite.
 */
export function candidates(m: Moment, limit = 6): Anchor[] {
  const skills = (m.skills ?? []).map((s) => s.toLowerCase().trim()).filter(Boolean);
  const langs = new Set<string>();
  if (m.lang) langs.add(langName(m.lang));
  for (const p of m.paths ?? []) {
    const l = langOf(p);
    if (l) langs.add(l);
  }
  const WORD = /[a-z0-9_+#?]+/g;
  const requestWords = new Set(m.request.toLowerCase().match(WORD) ?? []);
  const pathWords = new Set((m.paths ?? []).flatMap((p) => p.toLowerCase().match(WORD) ?? []));
  if ((m.paths ?? []).some((p) => /\.(sqlite3?|db)$/i.test(p))) pathWords.add("sqlite");
  const scored: { a: Anchor; score: number }[] = [];
  for (const a of catalog) {
    if (a.langs.length && langs.size && !a.langs.some((l) => langs.has(l))) continue;
    let score = 0;
    for (const t of a.topics) {
      if (skills.includes(t)) score += 3;
      else if (t.includes(" ") ? m.request.toLowerCase().includes(t) : requestWords.has(t)) score += 1;
      if (pathWords.has(t)) score += 1;
    }
    if (score && a.langs.length && a.langs.some((l) => langs.has(l))) score += 1;
    if (score) scored.push({ a, score });
  }
  scored.sort((x, y) => y.score - x.score || x.a.id.localeCompare(y.a.id));
  return scored.slice(0, limit).map((s) => s.a);
}

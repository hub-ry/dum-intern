// Projects the growth of a high-yield savings account.
//
// Standalone - nothing in src/ imports this and it is not wired into the dum
// CLI. Run it with: npm run hysa -- --balance 10000 --apy 4.25 --years 5
//
// APY is the advertised annual yield, so the monthly growth factor is the
// twelfth root of (1 + apy) rather than apy/12. Dividing by 12 would compound
// on top of a rate that already includes compounding, and quietly overstate
// the result - the number off the bank's website is the number you get.

export type Inputs = {
  balance: number;
  apy: number; // as a fraction: 0.0425, not 4.25
  years: number;
  monthly: number;
};

export type Result = {
  final: number;
  contributed: number;
  interest: number;
};

export function project({ balance, apy, years, monthly }: Inputs): Result {
  const months = Math.round(years * 12);
  const growth = (1 + apy) ** (1 / 12);

  let final = balance;
  for (let i = 0; i < months; i++) final = final * growth + monthly;

  const contributed = monthly * months;
  return { final, contributed, interest: final - balance - contributed };
}

const usage = `usage: hysa --balance <n> --apy <percent> --years <n> [--monthly <n>]

  --balance   starting balance
  --apy       advertised annual yield, as a percent (e.g. 4.25)
  --years     how long it sits there
  --monthly   recurring deposit, added at the end of each month (default 0)
`;

function parse(argv: string[]): Inputs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--")) throw new Error(`expected a --flag, got ${key ?? "nothing"}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${key} needs a value`);
    flags.set(key.slice(2), value);
  }

  const num = (name: string, fallback?: number) => {
    const raw = flags.get(name);
    if (raw === undefined) {
      if (fallback !== undefined) return fallback;
      throw new Error(`missing --${name}`);
    }
    const n = Number(raw.replace(/[$,_]/g, ""));
    if (!Number.isFinite(n)) throw new Error(`--${name} is not a number: ${raw}`);
    if (n < 0) throw new Error(`--${name} cannot be negative`);
    return n;
  };

  const inputs = {
    balance: num("balance"),
    apy: num("apy") / 100,
    years: num("years"),
    monthly: num("monthly", 0),
  };

  for (const key of flags.keys()) {
    if (!(key in inputs)) throw new Error(`unknown flag --${key}`);
  }
  return inputs;
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(usage);
    process.exit(argv.length === 0 ? 1 : 0);
  }

  let inputs: Inputs;
  try {
    inputs = parse(argv);
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${usage}`);
    process.exit(1);
  }

  const { final, contributed, interest } = project(inputs);
  if (contributed > 0) console.log(`you deposited      ${money(inputs.balance + contributed)}`);
  console.log(`interest earned    ${money(interest)}`);
  console.log(`final balance      ${money(final)}`);
}

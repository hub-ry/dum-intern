import type { SkillNode, Teaching } from "./types.ts";

export function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

export function slug(title: string): string {
  const cleaned = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return cleaned || "skill";
}

export function renderSkill(node: SkillNode, teaching: Teaching, when = new Date()): string {
  const taught = when.toISOString().slice(0, 10);
  const lines = [
    `# ${node.title}`,
    "",
    `Taught ${taught}.`,
    "",
    node.summary,
    "",
    "## What I was taught",
    "",
    teaching.explanation.trim(),
    "",
  ];
  const pairs: string[] = [];
  for (let i = 0; i < teaching.transcript.length; i++) {
    const turn = teaching.transcript[i];
    if (turn.role !== "intern") continue;
    const answer = teaching.transcript.slice(i + 1).find((item) => item.role === "user");
    if (!answer) continue;
    pairs.push(`**Intern:** ${turn.text}`, "", `**Teacher:** ${answer.text}`, "");
  }
  if (pairs.length > 0) lines.push("## Questions I asked", "", ...pairs);
  if (teaching.organized?.trim()) lines.push("## How I'll follow it", "", teaching.organized.trim(), "");
  lines.push(
    "## Rule",
    "",
    "Follow the teacher's words above. If a better way shows up, propose a new node. Do not use that way yourself.",
    "",
  );
  return lines.join("\n");
}

/** A store-only zip (no compression) so skill notes can be downloaded without a dependency. */
export function zipStore(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name.replaceAll("\\", "/"), "utf8");
    const crc = crc32(file.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, file.data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + file.data.length;
  }
  const centralStart = offset;
  const centralBlob = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBlob.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBlob, end]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

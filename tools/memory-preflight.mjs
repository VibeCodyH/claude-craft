#!/usr/bin/env node
// UserPromptSubmit hook — surfaces STRONGLY-relevant prior memory when the
// user's prompt is on-topic (e.g. "redo the dark mode cards"). Plain stdout
// is injected into the turn's context (exit 0).
//
// Scope honesty: this only sees the USER's words, so it can't catch a mistake
// born from a self-proposed approach — that's what `memcheck.mjs` is for. This
// is the on-topic-prompt half. Threshold-gated to stay signal, not noise.
//
// FAIL-SAFE: exit 0 always, output nothing on error/no-match. NEVER exit 2
// (that would reject the user's prompt).
import { resolveMemoryDir, loadMemories, scoreMemories, gatePreflight } from "./memory-lib.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(raw || "{}");
    const prompt = payload.prompt || "";
    const cwd = payload.cwd || process.cwd();
    if (prompt.trim().length < 12) return done(); // too short to match meaningfully

    const memories = loadMemories(resolveMemoryDir(cwd));
    if (!memories.length) return done();

    const shown = gatePreflight(scoreMemories(prompt, memories));
    if (!shown.length) return done();

    let out =
      "📌 Pre-flight memory check — prior notes relevant to this request " +
      "(verify before acting; a recorded ★decision outranks a fresh idea):\n";
    for (const r of shown) {
      const star = r.mem.type === "feedback" || r.mem.type === "project" ? "★" : "";
      out += `- ${star}[[${r.mem.name}]] <${r.mem.type}>: ${r.mem.description}\n`;
    }
    process.stdout.write(out);
  } catch {
    /* fail-safe: inject nothing, never block the prompt */
  }
  done();
});

function done() {
  process.exit(0);
}

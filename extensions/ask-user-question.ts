import { type ExtensionAPI, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  Key,
  matchesKey,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

/**
 * ask_user_question: a tab per question plus a Submit tab, numbered options, multi-select, a free-text row, a "discuss" row that flags a
 * question for discussion instead of answering it, previews next to the options, and an
 * optional note on the Submit tab. The schema only sets minimums; there are no length caps.
 */

const OptionSchema = Type.Object({
  label: Type.String({
    description: "The text the user sees and selects. Keep it short (a few words) and clear.",
  }),
  description: Type.String({
    description: "What this option means or what happens if chosen, including trade-offs.",
  }),
  preview: Type.Optional(
    Type.String({
      description:
        "Optional preview shown next to the options while this option is focused: a mockup, code snippet, diagram or config to compare. Single-select only.",
    }),
  ),
});

const QuestionSchema = Type.Object({
  question: Type.String({
    description:
      'The complete question, clear and specific, ending with a question mark, e.g. "Which library should we use for date formatting?"',
  }),
  header: Type.String({
    description: 'Short tag shown in the tab bar, one or two words, e.g. "Auth method", "Library".',
  }),
  options: Type.Array(OptionSchema, {
    minItems: 2,
    description:
      "The choices, distinct and mutually exclusive unless multiSelect is set. A free-text row and a discuss row are appended automatically; do not author them.",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({ description: "Let the user select several options. Use when the choices are not exclusive." }),
  ),
});

const ParamsSchema = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, description: "The questions to ask, one tab each." }),
});

type Params = Static<typeof ParamsSchema>;
type Question = Static<typeof QuestionSchema>;

interface Answer {
  header: string;
  question: string;
  /** Chosen option labels, followed by the typed answer if it was chosen. */
  values: string[];
  /** Present when the user flagged the question for discussion: what they wrote, possibly empty. */
  discuss?: string;
  /** Preview of the chosen option of a single-select question. */
  preview?: string;
}

interface Details {
  answers: Answer[];
  note?: string;
  cancelled: boolean;
}

type Row = { kind: "option"; index: number } | { kind: "custom" } | { kind: "discuss" } | { kind: "next" };

interface QuestionState {
  cursor: number;
  chosen: Set<number>;
  customChosen: boolean;
  discussChosen: boolean;
  custom: Input;
  discuss: Input;
}

const TOOL_NAME = "ask_user_question";
const SUBMIT_ROWS = ["submit", "note", "cancel"] as const;
const SIDE_BY_SIDE_MIN_WIDTH = 100;
const STACKED_PREVIEW_HEIGHT = 12;
const TAB_HEADER_WIDTH = 24;

const DESCRIPTION = `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices about what direction to take

Each question is a tab; the user can move freely between them and reviews all answers on a final Submit tab, where they can also add a note for you.

Usage notes:
- Every question gets two rows appended automatically: a free-text row ("Type something.") and a "Discuss this question" row. Do NOT author "Other", "Type something" or "Discuss" options yourself.
- A question the user flags for discussion is NOT answered. The result says so, with what they are unsure about; discuss it with them before acting on it.
- The user may submit with questions unanswered or press Esc to decline the whole questionnaire.
- Use multiSelect: true when several answers can apply.
- If you recommend an option, put it first and add "(Recommended)" at the end of its label.
- There is no hard limit on the number of questions or options, but each one costs the user attention: ask only what actually blocks you, typically up to about 4 questions with 2-5 options each.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts the user needs to compare visually:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Previews are shown as preformatted monospace text next to the option list (below it in narrow terminals): line breaks and spacing are kept exactly, nothing is wrapped, and \`\`\`lang fenced blocks are syntax highlighted. Do not use previews for simple preference questions where labels and descriptions suffice. Previews are only supported for single-select questions.`;

const PROMPT_SNIPPET = "Ask the user structured multiple-choice questions when requirements are ambiguous";

const PROMPT_GUIDELINES = [
  "Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions. Batch the related clarifying questions of one decision point into one call.",
  "Give every question at least 2 distinct options, each with a short label and a description of what it means or its trade-offs. A free-text row and a discuss row are appended automatically; never author 'Other', 'Type something' or 'Discuss' options.",
  "Set multiSelect: true when several answers can apply. Use options[].preview for concrete artifacts to compare (mockups, code, configs) on single-select questions. Put a recommended option first and append '(Recommended)' to its label.",
  "A question the user flagged for discussion is not answered: talk it through with them before acting on it.",
];

function isAnswered(answer: Answer): boolean {
  return answer.values.length > 0 || answer.discuss !== undefined;
}

function answerOf(question: Question, state: QuestionState): Answer {
  const values = question.options.filter((_, i) => state.chosen.has(i)).map((option) => option.label);
  const custom = state.custom.getValue().trim();
  if (state.customChosen && custom) values.push(custom);
  const [only] = state.chosen;
  const preview = question.multiSelect || only === undefined ? undefined : question.options[only].preview;
  return {
    header: question.header,
    question: question.question,
    values,
    ...(state.discussChosen ? { discuss: state.discuss.getValue().trim() } : {}),
    ...(preview ? { preview } : {}),
  };
}

/** The model-facing result text. */
function envelope(details: Details): string {
  if (details.cancelled) return "User declined to answer questions";
  const answered = details.answers.filter(isAnswered);
  const parts = answered.map((a) => {
    if (a.discuss !== undefined) {
      return `"${a.question}"=(not answered: the user wants to discuss this first${a.discuss ? `: ${a.discuss}` : ""})`;
    }
    return `"${a.question}"="${a.values.join(", ")}"${a.preview ? ` selected preview: ${a.preview}` : ""}`;
  });
  const unanswered = details.answers.filter((a) => !isAnswered(a)).map((a) => `"${a.question}"`);

  let text = parts.length
    ? `User has answered your questions: ${parts.join(". ")}.`
    : "User submitted without answering any question.";
  if (unanswered.length) text += ` Unanswered: ${unanswered.join(", ")}.`;
  if (details.note) text += ` User note: "${details.note}".`;
  text += answered.some((a) => a.discuss !== undefined)
    ? " Discuss the flagged questions with the user before acting on them; continue with the other answers in mind."
    : " You can now continue with the user's answers in mind.";
  return text;
}

/** Models sometimes send the questions array as a JSON string. */
function parseArgs(args: unknown): Params {
  const raw = args as { questions?: unknown };
  if (typeof raw?.questions !== "string") return args as Params;
  try {
    return { ...raw, questions: JSON.parse(raw.questions) } as Params;
  } catch {
    return args as Params;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Cut or pad a line to exactly `width` columns. */
function fit(line: string, width: number): string {
  const cut = truncateToWidth(line, width, "");
  return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

/** Preview text as display lines: kept verbatim, with ```lang fenced blocks highlighted. */
function previewLines(text: string): string[] {
  const out: string[] = [];
  let fence: { lang: string; body: string[] } | undefined;
  const flush = () => {
    if (fence) out.push(...highlightCode(fence.body.join("\n"), fence.lang || undefined));
    fence = undefined;
  };
  for (const line of text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").split("\n")) {
    const marker = /^\s*```(\S*)/.exec(line);
    if (marker) {
      if (fence) flush();
      else fence = { lang: marker[1], body: [] };
    } else if (fence) {
      fence.body.push(line);
    } else {
      out.push(line);
    }
  }
  flush();
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out;
}

class Dialog implements Component, Focusable {
  private tab = 0;
  private submitCursor = 0;
  private closed = false;
  private hasFocus = false;
  private cache?: { width: number; lines: string[] };
  private readonly states: QuestionState[];
  private readonly note: Input;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly questions: Question[],
    private readonly done: (details: Details) => void,
  ) {
    this.states = questions.map(() => ({
      cursor: 0,
      chosen: new Set<number>(),
      customChosen: false,
      discussChosen: false,
      custom: this.input("Type something."),
      discuss: this.input("What are you unsure about? (optional)"),
    }));
    this.note = this.input("Add a note for the agent (optional)");
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.invalidate();
  }

  cancel(): void {
    this.finish(false);
  }

  invalidate(): void {
    this.cache = undefined;
  }

  handleInput(data: string): void {
    this.onKey(data);
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const t = this.theme;
    const active = this.activeInput();
    for (const input of this.inputs()) input.focused = input === active && this.hasFocus;

    const rule = t.fg("accent", "─".repeat(width));
    const head = [rule, this.tabBar(width), ""];
    const foot = ["", ` ${t.fg("dim", this.help())}`, rule];
    const budget = Math.max(8, this.tui.terminal.rows - 6) - head.length - foot.length;
    const body = this.onSubmitTab() ? this.submitBody(width, budget) : this.questionBody(width, budget);
    const lines = [...head, ...body, ...foot].map((line) => truncateToWidth(line, width, ""));
    this.cache = { width, lines };
    return lines;
  }

  // --- state -------------------------------------------------------------------------------

  private input(placeholder: string): Input {
    return new Input({ prompt: "", placeholder, placeholderStyle: (text) => this.theme.fg("dim", text) });
  }

  private inputs(): Input[] {
    return [...this.states.flatMap((s) => [s.custom, s.discuss]), this.note];
  }

  private onSubmitTab(): boolean {
    return this.tab === this.questions.length;
  }

  private rows(tab: number): Row[] {
    const question = this.questions[tab];
    const rows: Row[] = question.options.map((_, index) => ({ kind: "option", index }));
    rows.push({ kind: "custom" });
    if (question.multiSelect) rows.push({ kind: "next" });
    rows.push({ kind: "discuss" });
    return rows;
  }

  private currentRow(): Row {
    return this.rows(this.tab)[this.states[this.tab].cursor];
  }

  /** The text field under the cursor, if any. */
  private activeInput(): Input | undefined {
    if (this.onSubmitTab()) return SUBMIT_ROWS[this.submitCursor] === "note" ? this.note : undefined;
    const state = this.states[this.tab];
    const row = this.currentRow();
    return row.kind === "custom" ? state.custom : row.kind === "discuss" ? state.discuss : undefined;
  }

  private answers(): Answer[] {
    return this.questions.map((question, i) => answerOf(question, this.states[i]));
  }

  private finish(submitted: boolean): void {
    if (this.closed) return;
    this.closed = true;
    const note = this.note.getValue().trim();
    this.done(
      submitted
        ? { answers: this.answers(), ...(note ? { note } : {}), cancelled: false }
        : { answers: [], cancelled: true },
    );
  }

  // --- input -------------------------------------------------------------------------------

  private onKey(data: string): void {
    const input = this.activeInput();
    if (matchesKey(data, Key.escape)) return this.finish(false);
    if (matchesKey(data, Key.tab)) return this.switchTab(1);
    if (matchesKey(data, Key.shift("tab"))) return this.switchTab(-1);
    if (matchesKey(data, Key.up)) return this.move(-1);
    if (matchesKey(data, Key.down)) return this.move(1);
    if (matchesKey(data, Key.enter)) return this.confirm();
    // Left/right move the text cursor once there is text, and switch tabs otherwise.
    if (input && input.getValue() !== "") return input.handleInput(data);
    if (matchesKey(data, Key.left)) return this.switchTab(-1);
    if (matchesKey(data, Key.right)) return this.switchTab(1);
    if (input) return input.handleInput(data);
    if (matchesKey(data, Key.space)) return this.confirm();
    if (/^[1-9]$/.test(data)) this.jump(Number(data) - 1);
  }

  private switchTab(delta: number): void {
    const count = this.questions.length + 1;
    this.tab = (this.tab + delta + count) % count;
    if (this.onSubmitTab()) this.submitCursor = 0;
  }

  private move(delta: number): void {
    if (this.onSubmitTab()) {
      this.submitCursor = clamp(this.submitCursor + delta, 0, SUBMIT_ROWS.length - 1);
      return;
    }
    const state = this.states[this.tab];
    state.cursor = clamp(state.cursor + delta, 0, this.rows(this.tab).length - 1);
  }

  private jump(index: number): void {
    if (this.onSubmitTab()) {
      if (index >= SUBMIT_ROWS.length) return;
      this.submitCursor = index;
      if (SUBMIT_ROWS[index] !== "note") this.confirm();
      return;
    }
    const rows = this.rows(this.tab);
    if (index >= rows.length) return;
    this.states[this.tab].cursor = index;
    if (rows[index].kind === "option" || rows[index].kind === "next") this.confirm();
  }

  private advance(): void {
    this.switchTab(this.onSubmitTab() ? 0 : 1);
  }

  private confirm(): void {
    if (this.onSubmitTab()) {
      const row = SUBMIT_ROWS[this.submitCursor];
      return this.finish(row !== "cancel");
    }
    const question = this.questions[this.tab];
    const state = this.states[this.tab];
    const row = this.currentRow();
    switch (row.kind) {
      case "option":
        state.discussChosen = false;
        if (question.multiSelect) {
          if (!state.chosen.delete(row.index)) state.chosen.add(row.index);
          return;
        }
        state.chosen = new Set([row.index]);
        state.customChosen = false;
        return this.advance();
      case "custom": {
        const hasText = state.custom.getValue().trim() !== "";
        if (question.multiSelect) {
          state.customChosen = hasText && !state.customChosen;
          if (state.customChosen) state.discussChosen = false;
          return;
        }
        if (!hasText) return;
        state.chosen.clear();
        state.customChosen = true;
        state.discussChosen = false;
        return this.advance();
      }
      case "discuss":
        state.chosen.clear();
        state.customChosen = false;
        state.discussChosen = true;
        return this.advance();
      case "next":
        return this.advance();
    }
  }

  // --- rendering ---------------------------------------------------------------------------

  private help(): string {
    const input = this.activeInput();
    if (this.onSubmitTab()) {
      return input
        ? "Type a note · Enter submit · ↑↓ move · Tab switch · Esc cancel"
        : "Enter confirm · ↑↓ move · Tab/←→ switch · Esc cancel";
    }
    const row = this.currentRow();
    if (row.kind === "discuss") return "Type what you're unsure about · Enter flag for discussion · ↑↓ move · Esc cancel";
    if (row.kind === "custom") return "Type your answer · Enter confirm · ↑↓ move · Tab switch · Esc cancel";
    const select = this.questions[this.tab].multiSelect ? "Enter/Space toggle" : "Enter select";
    return `${select} · ↑↓ move · Tab/←→ switch · Esc cancel`;
  }

  private tabBar(width: number): string {
    const t = this.theme;
    const answers = this.answers();
    const tabs = answers.map((answer, i) => {
      const discuss = answer.discuss !== undefined;
      const mark = discuss ? "?" : isAnswered(answer) ? "☑" : "☐";
      const text = ` ${mark} ${truncateToWidth(answer.header, TAB_HEADER_WIDTH)} `;
      if (i === this.tab) return t.bg("selectedBg", t.fg("text", text));
      return t.fg(discuss ? "warning" : isAnswered(answer) ? "success" : "muted", text);
    });
    const submit = " ✔ Submit ";
    tabs.push(
      this.onSubmitTab()
        ? t.bg("selectedBg", t.fg("text", submit))
        : t.fg(answers.every(isAnswered) ? "success" : "dim", submit),
    );

    // Drop tabs farthest from the current one until the bar fits.
    let start = 0;
    let end = tabs.length;
    const room = width - 10;
    while (end - start > 1 && visibleWidth(tabs.slice(start, end).join(" ")) > room) {
      if (this.tab - start > end - 1 - this.tab) start++;
      else end--;
    }
    const left = start > 0 ? t.fg("dim", "… ") : "";
    const right = end < tabs.length ? t.fg("dim", " …") : "";
    return ` ${t.fg("dim", "←")}  ${left}${tabs.slice(start, end).join(" ")}${right}  ${t.fg("dim", "→")}`;
  }

  private questionBody(width: number, budget: number): string[] {
    const question = this.questions[this.tab];
    const state = this.states[this.tab];
    const title = wrapTextWithAnsi(this.theme.bold(question.question), width - 1).map((line) => ` ${line}`);
    const hasPreview = !question.multiSelect && question.options.some((option) => option.preview);
    const sideBySide = hasPreview && width >= SIDE_BY_SIDE_MIN_WIDTH;
    const listWidth = sideBySide ? Math.min(60, Math.floor(width * 0.42)) : width;

    const row = this.currentRow();
    const [chosen] = state.chosen;
    const previewIndex = row.kind === "option" ? row.index : chosen;
    const preview = previewIndex === undefined ? undefined : question.options[previewIndex].preview;
    const stackedHeight =
      hasPreview && !sideBySide ? Math.min(STACKED_PREVIEW_HEIGHT, (preview ? previewLines(preview).length : 1) + 2) : 0;

    const listBudget = Math.max(3, budget - title.length - 1 - (stackedHeight ? stackedHeight + 1 : 0));
    const list = this.windowed(this.rowBlocks(listWidth), state.cursor, listBudget);
    const out = [...title, ""];
    if (!hasPreview) return [...out, ...list];

    if (!sideBySide) return [...out, ...list, "", ...this.box(preview, width - 1, stackedHeight).map((l) => ` ${l}`)];

    const box = this.box(preview, width - listWidth - 2, Math.max(list.length, listBudget));
    for (let i = 0; i < Math.max(list.length, box.length); i++) {
      out.push(`${fit(list[i] ?? "", listWidth)}  ${box[i] ?? ""}`);
    }
    return out;
  }

  /** One block of lines per row of the current question. */
  private rowBlocks(width: number): string[][] {
    const t = this.theme;
    const question = this.questions[this.tab];
    const state = this.states[this.tab];
    const rows = this.rows(this.tab);
    const numberWidth = String(rows.length).length;
    const lastQuestion = this.tab === this.questions.length - 1;

    return rows.map((row, i) => {
      const active = i === state.cursor;
      const pointer = active ? t.fg("accent", "❯ ") : "  ";
      const number = `${String(i + 1).padStart(numberWidth)}. `;
      const checkbox = (checked: boolean) => (checked ? t.fg("success", "[✔] ") : t.fg("muted", "[ ] "));
      const tick = (checked: boolean) => (checked ? t.fg("success", " ✔") : "");
      const color = active ? "accent" : "text";

      let mark = "";
      let label: string;
      let description: string | undefined;
      let input: Input | undefined;
      switch (row.kind) {
        case "option": {
          const option = question.options[row.index];
          const checked = state.chosen.has(row.index);
          if (question.multiSelect) mark = checkbox(checked);
          label = t.fg(color, option.label) + (question.multiSelect ? "" : tick(checked));
          description = option.description;
          break;
        }
        case "custom": {
          const text = state.custom.getValue();
          const checked = state.customChosen && text.trim() !== "";
          if (question.multiSelect) mark = checkbox(checked);
          if (active) input = state.custom;
          label = (text ? t.fg(color, text) : t.fg("dim", "Type something.")) + (question.multiSelect ? "" : tick(checked));
          break;
        }
        case "discuss": {
          const text = state.discuss.getValue();
          if (active) input = state.discuss;
          const base = text ? `Discuss: ${text}` : "💬 I'm unsure – discuss this";
          label = t.fg(state.discussChosen ? "warning" : active ? "accent" : "muted", base);
          if (state.discussChosen) label += t.fg("warning", " ?");
          break;
        }
        case "next":
          label = t.fg(color, lastQuestion ? "Review answers →" : "Next question →");
          break;
      }

      const lead = pointer + t.fg(active ? "accent" : "muted", number) + mark;
      const indent = " ".repeat(visibleWidth(lead));
      const textWidth = Math.max(1, width - visibleWidth(lead));
      const lines = input
        ? [lead + input.render(textWidth)[0]]
        : wrapTextWithAnsi(label, textWidth).map((line, j) => (j === 0 ? lead : indent) + line);
      if (description) {
        lines.push(...wrapTextWithAnsi(t.fg("muted", description), textWidth).map((line) => indent + line));
      }
      // Discuss is not an answer: set it apart from the options.
      if (row.kind === "discuss") lines.unshift("", `  ${t.fg("dim", "─".repeat(Math.max(1, Math.min(40, width - 2))))}`);
      return lines;
    });
  }

  /** The blocks around the cursor that fit in `budget` lines, with markers for the rest. */
  private windowed(blocks: string[][], cursor: number, budget: number): string[] {
    if (blocks.reduce((sum, block) => sum + block.length, 0) <= budget) return blocks.flat();
    const room = Math.max(1, budget - 2);
    let start = cursor;
    let end = cursor + 1;
    let used = blocks[cursor].length;
    for (let grew = true; grew; ) {
      grew = false;
      if (end < blocks.length && used + blocks[end].length <= room) {
        used += blocks[end++].length;
        grew = true;
      }
      if (start > 0 && used + blocks[start - 1].length <= room) {
        used += blocks[--start].length;
        grew = true;
      }
    }
    const dim = (text: string) => this.theme.fg("dim", text);
    return [
      ...(start > 0 ? [dim(`  ↑ ${start} more`)] : []),
      ...blocks.slice(start, end).flat().slice(0, room),
      ...(end < blocks.length ? [dim(`  ↓ ${blocks.length - end} more`)] : []),
    ];
  }

  private box(preview: string | undefined, width: number, height: number): string[] {
    const t = this.theme;
    const inner = Math.max(1, width - 4);
    const room = Math.max(1, height - 2);
    let body = preview ? previewLines(preview) : [t.fg("dim", "No preview")];
    if (body.length > room) {
      body = [...body.slice(0, room - 1), t.fg("dim", `… +${body.length - room + 1} lines`)];
    }
    const title = " Preview ";
    const border = (text: string) => t.fg("border", text);
    return [
      border(`╭─${title}${"─".repeat(Math.max(0, width - 3 - title.length))}╮`),
      ...body.map((line) => `${border("│")} ${fit(line, inner)} ${border("│")}`),
      border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
    ];
  }

  private submitBody(width: number, budget: number): string[] {
    const t = this.theme;
    const answers = this.answers();
    const wrap = (text: string, indent: string) =>
      wrapTextWithAnsi(text, Math.max(1, width - indent.length)).map((line) => indent + line);

    let review: string[] = [];
    for (const answer of answers) {
      review.push(...wrap(`${t.fg("muted", "●")} ${answer.question}`, " "));
      const result =
        answer.discuss !== undefined
          ? t.fg("warning", `→ Discuss${answer.discuss ? `: ${answer.discuss}` : ""}`)
          : isAnswered(answer)
            ? t.fg("success", `→ ${answer.values.join(", ")}`)
            : t.fg("dim", "→ (unanswered)");
      review.push(...wrap(result, "   "));
    }

    const missing = answers.filter((answer) => !isAnswered(answer)).length;
    const warning = missing
      ? ["", ` ${t.fg("warning", `${missing} unanswered question${missing === 1 ? "" : "s"}: submit anyway or go back`)}`]
      : [];
    const rows = SUBMIT_ROWS.map((row, i) => {
      const active = i === this.submitCursor;
      const lead = (active ? t.fg("accent", "❯ ") : "  ") + t.fg(active ? "accent" : "muted", `${i + 1}. `);
      const color = active ? "accent" : "text";
      if (row === "submit") return lead + t.fg(color, "Submit answers");
      if (row === "cancel") return lead + t.fg(color, "Cancel");
      if (active) return lead + this.note.render(Math.max(1, width - 5))[0];
      const note = this.note.getValue();
      return lead + (note ? t.fg(color, `Note: ${note}`) : t.fg("dim", "Add a note for the agent (optional)"));
    });

    const room = Math.max(1, budget - 2 - warning.length - 1 - rows.length);
    if (review.length > room) review = [...review.slice(0, room - 1), t.fg("dim", "   …")];
    return [` ${t.bold("Review your answers")}`, "", ...review, ...warning, "", ...rows];
  }
}

export default function (pi: ExtensionAPI) {
  // Without the terminal UI (print, JSON, RPC, subagents) the dialog cannot be shown, so the
  // model should not see the tool at all. The mode is fixed for the process.
  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.mode === "tui") return;
    const active = pi.getActiveTools();
    if (active.includes(TOOL_NAME)) pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Ask User Question",
    description: DESCRIPTION,
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: ParamsSchema,
    exposure: "model-only",
    executionMode: "sequential",

    prepareArguments: parseArgs,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const details = await ctx.ui.custom<Details>((tui, theme, _keybindings, done) => {
        const dialog = new Dialog(tui, theme, params.questions, done);
        signal?.addEventListener("abort", () => dialog.cancel(), { once: true });
        return dialog;
      });
      return { content: [{ type: "text", text: envelope(details) }], details };
    },

    renderCall(args, theme) {
      const parsed = parseArgs(args)?.questions;
      const questions = Array.isArray(parsed) ? parsed : [];
      const headers = questions.map((q) => q?.header).filter(Boolean);
      let text = theme.fg("toolTitle", theme.bold("ask_user_question "));
      text += theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`);
      if (headers.length) text += theme.fg("dim", ` (${headers.join(", ")})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as Details | undefined;
      if (!details?.answers) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }
      if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      const lines = details.answers.map((a) => {
        const header = theme.fg("accent", a.header);
        if (a.discuss !== undefined) {
          return `${theme.fg("warning", "? ")}${header}: ${theme.fg("warning", "discuss")}${a.discuss ? ` – ${a.discuss}` : ""}`;
        }
        if (isAnswered(a)) return `${theme.fg("success", "✓ ")}${header}: ${a.values.join(", ")}`;
        return `${theme.fg("dim", "– ")}${header}: ${theme.fg("dim", "unanswered")}`;
      });
      if (details.note) lines.push(`${theme.fg("muted", "Note:")} ${details.note}`);
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}

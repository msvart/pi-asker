# pi-asker

An `ask_user_question` tool for [pi](https://pi.dev). When the model would otherwise guess, it asks you instead, with options to pick from.

```
 ←   ☑ Database   ☐ Features   ✔ Submit   →

 Which database should we use?

❯ 1. Postgres (Recommended)                     ╭─ Preview ─────────────────────────╮
     Relational and mature.                     │ services:                         │
  2. SQLite                                     │   db:                             │
     One file, no server.                       │     image: postgres:17            │
  3. Type something.                            ╰───────────────────────────────────╯

  ────────────────────────────────────────
  4. 💬 I'm unsure – discuss this

 Enter select · ↑↓ move · Tab/←→ switch · Esc cancel
```

- **Tabs** – one per question plus a Submit tab. Move freely between them; answered questions are ticked.
- **Single and multi-select** – numbered options with descriptions; checkboxes when several answers apply.
- **Free text** – every question has a "Type something." row you type into directly.
- **Discuss** – unsure? Flag the question, optionally say why, and carry on with the rest. The model is told the question is not answered and to talk it through with you first.
- **Previews** – mockups, code or configs shown next to the options (below them in narrow terminals). Text is kept verbatim; fenced code blocks are syntax highlighted.
- **Review** – the Submit tab lists every answer, warns about unanswered questions, and takes an optional note for the model.
- **No hard limits** – the schema only requires one question and two options. The tool description steers the model towards a few short questions instead.
- **Interactive only** – in print, JSON and RPC mode (and in subagents) the tool is hidden from the model, since there is no one to answer.

## Install

Requires pi 1.4 or newer.

```bash
pi install git:github.com/msvart/pi-asker
```

It registers the tool as `ask_user_question`, so remove any other package that registers the same name, such as `@juicesharp/rpiv-ask-user-question`.

## Keys

| Key | Action |
| --- | --- |
| `↑` `↓` | Move between rows |
| `Enter` | Select, toggle, or confirm typed text |
| `Space` | Select or toggle an option |
| `1`–`9` | Jump to a row and select it |
| `Tab` `Shift+Tab` `←` `→` | Switch question (`←` `→` move the text cursor once you have typed something) |
| `Esc` | Cancel the questionnaire |

## License

MIT

---
name: telegram-channel-html
description: >-
  Format replies as Telegram HTML with a headline and short sections (stock,
  sector, or theme) for mobile chat. Use when responding to the Telegram channel,
  when the prompt mentions Telegram delivery or parse_mode=HTML, or when
  formatting trader alerts for Telegram bots.
---

# Telegram channel HTML replies

Replies are delivered with `parse_mode=HTML` to a Telegram mobile chat. Return **only** the HTML message body — no markdown fences, no preamble, no trailing commentary.

## Telegram HTML limits

Telegram supports: `<b>`, `<strong>`, `<i>`, `<em>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a href="…">`, `<tg-spoiler>`.

**Do not use** `<table>`, `<ul>`, `<ol>`, `<li>` — they are unsupported or render poorly.

Escape dynamic text: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`.

## Reply structure

1. **Headline** — one line: `<b>Short title</b>`
2. **Sections** — one section per stock, sector, index, or theme the user asked about
3. **Optional footer** — one short line in `<i>…</i>` (sources, disclaimer)

Separate sections with a **blank line**. Keep total length under ~3500 characters.

## Section format (critical)

Each section:
- **Title line**: `<b>Section name</b>` — ticker (e.g. `<b>NVDA</b>`), sector (e.g. `<b>Semis</b>`), or theme (e.g. `<b>Risk tone</b>`)
- **Bullets**: up to **4 lines**, each starting with `• ` (Unicode bullet + space)
- Short phrases only — easy to scan on a phone (under ~60 characters per bullet when possible)
- No tables, no `<pre>` blocks, no dense paragraphs inside a section

```html
<b>📊 Intraday ideas</b>

<b>NVDA</b>
• $875 · breaking VWAP on volume
• Entry $872 · stop $865 · target $885
• Catalyst: AI headline flow

<b>AMD</b>
• $142 · lagging NVDA, coiling
• Entry $141 · stop $138 · target $146
• Lower size — slower tape

<i>Not financial advice · Mar 2026</i>
```

## marketmood / macro example

```html
<b>🌡 Market mood</b>

<b>Indices</b>
• S&amp;P flat · Nasdaq +0.3% · VIX subdued
• Breadth mixed — leaders narrow

<b>Style</b>
• Risk-on in growth · defensives lag
• Favor liquid large caps over small caps

<b>Plan</b>
• Long bias OK on leaders with tight stops
• Avoid chasing extended gaps

<i>Sources: CNBC, Bloomberg</i>
```

## Formatting rules

- Use `<b>…</b>` for headline and each section title; `<i>…</i>` sparingly for footer
- Use `<code>…</code>` only for a single ticker inline in prose (section titles use `<b>`)
- **No** Markdown (`#`, `**`, backticks), JSON blocks, or `ai_action` / `ai_summary` wrappers
- Write for a trader: symbols, levels, P&amp;L, actions — not internal code paths or API names
- Multiple stocks or themes → **one section each**, never one big table or wall of text
- If more than ~6 sections, keep the best ideas and note that others were skipped

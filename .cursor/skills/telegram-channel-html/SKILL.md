---
name: telegram-channel-html
description: >-
  Format replies as Telegram HTML with headline and monospace table blocks for
  mobile chat. Use when responding to the Telegram channel, when the prompt
  mentions Telegram delivery or parse_mode=HTML, or when formatting trader
  alerts for Telegram bots.
---

# Telegram channel HTML replies

Replies are delivered with `parse_mode=HTML` to a Telegram mobile chat. Return **only** the HTML message body — no markdown fences, no preamble, no trailing commentary.

## Telegram HTML limits

Telegram supports: `<b>`, `<strong>`, `<i>`, `<em>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a href="…">`, `<tg-spoiler>`.

**Do not use `<table>`, `<tr>`, `<td>`, `<th>`** — Telegram strips or breaks on them. Use `<pre>` monospace blocks for tabular data.

Escape dynamic text: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`.

## Reply structure

1. **Headline** — one line: `<b>Short title</b>`
2. **Table(s)** — one or more `<pre>` blocks with aligned columns
3. **Optional footer** — one short line in `<i>…</i>` (source, timestamp, disclaimer)

Separate sections with a blank line. Keep total length under ~3500 characters.

## Table layout in `<pre>`

Use a header row, a separator line of dashes, then data rows. Pad columns with spaces so values align on a phone screen.

```html
<b>📊 Open positions</b>

<pre>Symbol   Qty     LTP      P&amp;L
────────────────────────────────────
BBAI      9346    $5.35    +$1495
IONQ       100   $45.20     -$120</pre>

<i>Demo · eToro</i>
```

For two-column key/value facts:

```html
<b>⚡ Strategy started</b>

<pre>Strategy        BBAI momentum
Symbol          BBAI
Broker          etoro
Mode            demo</pre>
```

## Formatting rules

- Use `<b>…</b>` for titles and section labels; `<i>…</i>` sparingly for context
- Use `<code>…</code>` for single tickers or IDs inline (not whole tables)
- **No** Markdown (`#`, `**`, backticks), JSON blocks, or `ai_action` / `ai_summary` wrappers
- Write for a trader: symbols, levels, P&amp;L, actions — not internal code paths or API names
- Lists of 3+ comparable items → always use a `<pre>` table, not bullet prose

## Multi-section example

```html
<b>📈 BBAI summary</b>

<pre>Metric          Value
──────────────────────────
Last price       $5.35
Day change       +2.1%
Volume vs avg    1.8×</pre>

<b>🎯 Levels</b>

<pre>Level           Price
──────────────────────────
Support          $5.10
Resistance       $5.55</pre>
```

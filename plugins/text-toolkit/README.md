# Text toolkit

Small text utilities that run locally inside the Octipus plugin sandbox.
No API key, network connection, model call or additional configuration is needed.
Both tools return results to the caller; they do not read or write files,
notes, tasks or the plugin store.

## Try it

Install **Text toolkit** from Administration → Plugins → Marketplace, review
its declarations, and enable it. Give the agent access to the plugin tool in
the topic/role you use, then ask:

> Count the words and estimate the reading time of this text: …

Or:

> Remove trailing spaces and extra blank lines from this text: …

## Tools

- `analyze_text`: pass `text` (up to 100,000 UTF-16 code units). Returns word,
  character and line counts, plus estimated reading time in seconds at
  200 words per minute. Characters count Unicode grapheme clusters: an emoji
  or a letter with a combining accent counts as one. Empty text has zero lines.
  A final newline starts a final empty line. Word segmentation uses English
  Unicode word boundaries; reading time is only an estimate.
- `normalize_whitespace`: pass `text` and optionally `collapseBlankLines`
  (default `true`). Converts CRLF/CR to LF, removes trailing spaces and tabs,
  removes leading/trailing blank lines, and optionally keeps at most one
  blank line between paragraphs. Leading indentation and spaces inside a line
  are preserved. Returns `text` and `changed`.

## Permissions and privacy

The manifest declares two read tools, no network hosts, no host API scopes,
no secrets and no persistent store. Text is processed in memory. The plugin
makes no AI calls; Octipus's selected agent/model may still see text supplied
in a chat. Uninstall it under Administration → Plugins when no longer needed.

## Development

Run `npm test` in this directory. The server speaks MCP over standard input
and output and uses only Node's built-in modules.

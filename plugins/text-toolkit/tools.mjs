export class ToolError extends Error {}

const MAX_TEXT = 100_000;
const words = new Intl.Segmenter('en', { granularity: 'word' });
const characters = new Intl.Segmenter('en', { granularity: 'grapheme' });

function textArgument(args, allowed) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolError('Arguments must be an object.');
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new ToolError('Unknown argument.');
  if (typeof args.text !== 'string') throw new ToolError('text must be a string.');
  if (args.text.length > MAX_TEXT) throw new ToolError(`text must contain at most ${MAX_TEXT} UTF-16 code units.`);
  return args.text;
}

export function analyzeText(args) {
  const text = textArgument(args, ['text']);
  let wordCount = 0;
  for (const part of words.segment(text)) if (part.isWordLike) wordCount++;
  let characterCount = 0;
  for (const _part of characters.segment(text)) characterCount++;
  return {
    words: wordCount,
    characters: characterCount,
    lines: text === '' ? 0 : text.split(/\r\n|\r|\n/).length,
    readingTimeSeconds: Math.ceil(wordCount * 60 / 200),
  };
}

export function normalizeWhitespace(args) {
  const text = textArgument(args, ['text', 'collapseBlankLines']);
  if (args.collapseBlankLines !== undefined && typeof args.collapseBlankLines !== 'boolean') throw new ToolError('collapseBlankLines must be true or false.');
  let cleaned = text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');
  if (args.collapseBlankLines !== false) cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return { text: cleaned, changed: cleaned !== text };
}

export const TOOL_DEFINITIONS = [
  {
    name: 'analyze_text',
    description: 'Count words, Unicode characters and lines, and estimate reading time locally.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: MAX_TEXT } }, required: ['text'], additionalProperties: false },
  },
  {
    name: 'normalize_whitespace',
    description: 'Clean trailing spaces and excess blank lines, preserving indentation. Returns text without saving it.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: MAX_TEXT }, collapseBlankLines: { type: 'boolean', default: true } }, required: ['text'], additionalProperties: false },
  },
];

export function callTool(name, args) {
  if (name === 'analyze_text') return analyzeText(args);
  if (name === 'normalize_whitespace') return normalizeWhitespace(args);
  throw new ToolError('Unknown tool.');
}

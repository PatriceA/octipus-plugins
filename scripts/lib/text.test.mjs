import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayTextProblem } from './text.mjs';

test('L5: bidi controls, invisible characters, odd spaces and lookalike mixes are refused', () => {
  assert.equal(displayTextProblem('Weekly review'), null);
  assert.equal(displayTextProblem('Café für Ärzte — 日本語'), null);
  assert.equal(displayTextProblem('Привет мир'), null, 'one script alone is fine');
  for (const s of ['abc\u202Egnp', 'a\u200Bb', 'a\u2066b', 'x\uFEFF', 'a\u00A0b', 'a\u3000b', 'tab\there', 'line\u2028sep', 'Hangul\u3164filler', '\u{E0041}tag', 'P\u0430ypal']) {
    assert.ok(displayTextProblem(s), JSON.stringify(s));
  }
});

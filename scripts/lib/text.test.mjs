import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayTextProblem, displayTextWarning } from './text.mjs';

test('L5: bidi controls, invisible characters and odd spaces are refused; a lookalike mix is a warning', () => {
  assert.equal(displayTextProblem('Weekly review'), null);
  assert.equal(displayTextProblem('Café für Ärzte — 日本語'), null);
  assert.equal(displayTextProblem('Привет мир'), null, 'one script alone is fine');
  for (const s of ['abc\u202Egnp', 'a\u200Bb', 'a\u2066b', 'x\uFEFF', 'a\u00A0b', 'a\u3000b', 'tab\there', 'line\u2028sep', 'Hangul\u3164filler', '\u{E0041}tag']) {
    assert.ok(displayTextProblem(s), JSON.stringify(s));
  }
  assert.equal(displayTextProblem('P\u0430ypal'), null);
  assert.match(displayTextWarning('P\u0430ypal'), /mixes Latin/);
  assert.equal(displayTextWarning('Привет world'), null);
});

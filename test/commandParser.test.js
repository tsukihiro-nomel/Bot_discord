const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCommandContent } = require('../commandParser');

test('parse command preserves raw multiline args', () => {
  const parsed = parseCommandContent('!sendembed #annonces Titre | Ligne1\nLigne2', '!');
  assert.equal(parsed.command, 'sendembed');
  assert.equal(parsed.args[0], '#annonces');
  assert.equal(parsed.rawArgs, '#annonces Titre | Ligne1\nLigne2');
});

test('parse command returns null for empty body', () => {
  assert.equal(parseCommandContent('!', '!'), null);
});

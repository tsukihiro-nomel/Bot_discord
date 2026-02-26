const test = require('node:test');
const assert = require('node:assert/strict');
const { parseColor, parseBool, buildEmbedsFromSpec, splitDescription } = require('../embedKit');

test('parseColor supports hex and int values', () => {
  assert.equal(parseColor('#FFB7DE', 0), 0xFFB7DE);
  assert.equal(parseColor('0x112233', 0), 0x112233);
  assert.equal(parseColor('invalid', 123), 123);
});

test('parseBool handles on/off', () => {
  assert.equal(parseBool('on', null), true);
  assert.equal(parseBool('off', null), false);
  assert.equal(parseBool('x', null), null);
});

test('embed spec supports options and fields', () => {
  const built = buildEmbedsFromSpec('Titre | Desc\n|| --color #FFB7DE --footer "Le Carnet" --timestamp off || --field "CPU::30%::true" --field "RAM::2GB::true"');
  assert.equal(built.embeds.length, 1);
  const [embed] = built.embeds;
  assert.equal(embed.title, 'Titre');
  assert.equal(embed.description, 'Desc');
  assert.equal(embed.color, 0xFFB7DE);
  assert.equal(embed.footer.text, 'Le Carnet');
  assert.equal(embed.fields.length, 2);
  assert.equal(embed.fields[0].inline, true);
  assert.equal(embed.timestamp, undefined);
});

test('json codeblock parsing works', () => {
  const built = buildEmbedsFromSpec('```json\n{"title":"X","description":"A\\nB","color":"#FFB7DE"}\n```');
  assert.equal(built.embeds[0].title, 'X');
  assert.equal(built.embeds[0].description, 'A\nB');
  assert.equal(built.embeds[0].color, 0xFFB7DE);
});

test('auto split description', () => {
  const chunks = splitDescription('a'.repeat(9000), 4096);
  assert.equal(chunks.length, 3);
  const built = buildEmbedsFromSpec(`Titre | ${'a'.repeat(9000)}`);
  assert.equal(built.embeds.length, 3);
});

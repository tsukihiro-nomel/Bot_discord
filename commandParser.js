function parseCommandContent(content, prefix) {
  if (typeof content !== 'string' || !content.startsWith(prefix)) return null;
  const body = content.slice(prefix.length);
  const trimmedStart = body.replace(/^\s+/, '');
  if (!trimmedStart) return null;

  const match = trimmedStart.match(/^(\S+)([\s\S]*)$/);
  if (!match) return null;
  const command = match[1].toLowerCase();
  const rawArgs = (match[2] || '').replace(/^\s+/, '');
  const args = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
  return { command, args, rawArgs };
}

module.exports = { parseCommandContent };

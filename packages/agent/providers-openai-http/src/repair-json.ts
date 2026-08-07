export function repairJson(raw: string): string {
  const stack: string[] = [];
  let output = '';
  let inString = false;
  let escaping = false;

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (!char) continue;

    if (inString) {
      if (escaping) {
        output += char;
        escaping = false;
        continue;
      }

      if (char === '\\') {
        output += char;
        escaping = true;
        continue;
      }

      if (char === '"') {
        output += char;
        inString = false;
        continue;
      }

      if (char === '\n') {
        output += '\\n';
        continue;
      }
      if (char === '\r') {
        output += '\\r';
        continue;
      }
      if (char === '\t') {
        output += '\\t';
        continue;
      }

      output += char;
      continue;
    }

    if (char === '"') {
      output += char;
      inString = true;
      continue;
    }

    if (char === '{' || char === '[') {
      stack.push(char);
      output += char;
      continue;
    }

    if (char === '}' || char === ']') {
      let cursor = output.length - 1;
      while (cursor >= 0 && /\s/.test(output[cursor] ?? '')) {
        cursor -= 1;
      }
      if (cursor >= 0 && output[cursor] === ',') {
        output = output.slice(0, cursor) + output.slice(cursor + 1);
      }
      stack.pop();
      output += char;
      continue;
    }

    output += char;
  }

  if (inString) {
    output += '"';
  }

  while (stack.length > 0) {
    const open = stack.pop();
    output += open === '{' ? '}' : ']';
  }

  return output;
}

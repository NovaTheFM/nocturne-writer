const encoder = new TextEncoder();

export function createDictionaryMembership(bytes) {
  if (bytes[0] !== 92 || bytes[1] !== 102 || bytes[2] !== 115 || bytes[3] !== 97 || bytes[4] !== 198) throw new Error('Invalid language dictionary format');
  const labels = bytes.subarray(8, 8 + bytes[7]);
  const arcs = bytes.subarray(8 + bytes[7]);
  const integer = offset => {
    let value = 0, shift = 0;
    do { value |= (arcs[offset] & 127) << shift; shift += 7; } while ((arcs[offset++] & 128) && shift < 35);
    return value >>> 0;
  };
  const afterArc = offset => {
    const flag = arcs[offset++];
    if (!(flag & 31)) offset++;
    if (!(flag & 128)) while (arcs[offset++] & 128) {}
    return offset;
  };
  const destination = arc => {
    if (!(arcs[arc] & 128)) return integer(arc + ((arcs[arc] & 31) ? 1 : 2));
    while (!(arcs[arc] & 64)) arc = afterArc(arc);
    return afterArc(arc);
  };
  const root = destination(0);
  return { arcs, labels, root, afterArc, destination };
}

export function dictionaryContains(dictionary, word) {
  const input = encoder.encode(word);
  if (!input.length) return false;
  let node = dictionary.root;
  for (let index = 0; index < input.length; index++) {
    let arc = node;
    while (arc) {
      const flag = dictionary.arcs[arc];
      const label = (flag & 31) ? dictionary.labels[flag & 31] : dictionary.arcs[arc + 1];
      if (label === input[index]) break;
      arc = (flag & 64) ? 0 : dictionary.afterArc(arc);
    }
    if (!arc) return false;
    if (index === input.length - 1) return Boolean(dictionary.arcs[arc] & 32);
    node = dictionary.destination(arc);
    if (!node) return false;
  }
  return false;
}

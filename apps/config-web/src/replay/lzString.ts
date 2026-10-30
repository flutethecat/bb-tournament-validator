// LZ-String's UTF-16 codec (compressToUTF16 / decompressFromUTF16), the frame encoding the FFB server uses when
// server.command.compression=true (CommandSocket.java: LZString.decompressFromUTF16 in, compressToUTF16 out).
//
// A TypeScript port of lz-string 1.5.0 (Copyright (c) 2013 pieroxy, MIT License, https://github.com/pieroxy/lz-string),
// limited to the two functions the fork socket needs; the algorithm and its output are unchanged.

const f = String.fromCharCode;

class BitWriter {
  private readonly out: string[] = [];
  private val = 0;
  private pos = 0;
  constructor(private readonly bitsPerChar: number, private readonly charOf: (n: number) => string) {}
  /** Writes `count` bits of `value`, least significant first (lz-string's dictionary codes and literals). */
  bits(value: number, count: number): void {
    for (let i = 0; i < count; i++) {
      this.val = (this.val << 1) | (value & 1);
      if (this.pos === this.bitsPerChar - 1) {
        this.pos = 0;
        this.out.push(this.charOf(this.val));
        this.val = 0;
      } else this.pos++;
      value >>= 1;
    }
  }
  /** Writes `count` zero bits, or a single 1 followed by `count - 1` zeros (the literal markers 0 and 1). */
  marker(one: boolean, count: number): void {
    let v = one ? 1 : 0;
    for (let i = 0; i < count; i++) {
      this.val = (this.val << 1) | v;
      if (this.pos === this.bitsPerChar - 1) {
        this.pos = 0;
        this.out.push(this.charOf(this.val));
        this.val = 0;
      } else this.pos++;
      v = 0;
    }
  }
  finish(): string {
    for (;;) {
      this.val <<= 1;
      if (this.pos === this.bitsPerChar - 1) { this.out.push(this.charOf(this.val)); break; }
      this.pos++;
    }
    return this.out.join("");
  }
}

function compress(input: string, bitsPerChar: number, charOf: (n: number) => string): string {
  const dictionary = new Map<string, number>();
  const toCreate = new Set<string>();
  let w = "";
  let enlargeIn = 2;
  let dictSize = 3;
  let numBits = 2;
  const out = new BitWriter(bitsPerChar, charOf);
  const emit = (): void => {
    if (toCreate.has(w)) {
      const code = w.charCodeAt(0);
      if (code < 256) { out.marker(false, numBits); out.bits(code, 8); } else { out.marker(true, numBits); out.bits(code, 16); }
      if (--enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits++; }
      toCreate.delete(w);
    } else {
      out.bits(dictionary.get(w)!, numBits);
    }
    if (--enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits++; }
  };
  for (let i = 0; i < input.length; i++) {
    const c = input.charAt(i);
    if (!dictionary.has(c)) { dictionary.set(c, dictSize++); toCreate.add(c); }
    const wc = w + c;
    if (dictionary.has(wc)) { w = wc; continue; }
    emit();
    dictionary.set(wc, dictSize++);
    w = c;
  }
  if (w !== "") emit();
  out.bits(2, numBits);
  return out.finish();
}

function decompress(length: number, resetValue: number, next: (i: number) => number): string | null {
  const dictionary: string[] = [];
  let enlargeIn = 4;
  let dictSize = 4;
  let numBits = 3;
  const data = { val: next(0), position: resetValue, index: 1 };
  const read = (count: number): number => {
    let bits = 0;
    for (let power = 1, max = 2 ** count; power !== max; power <<= 1) {
      const resb = data.val & data.position;
      data.position >>= 1;
      if (data.position === 0) { data.position = resetValue; data.val = next(data.index++); }
      bits |= (resb > 0 ? 1 : 0) * power;
    }
    return bits;
  };
  for (let i = 0; i < 3; i++) dictionary[i] = String(i);
  let c: string;
  switch (read(2)) {
    case 0: c = f(read(8)); break;
    case 1: c = f(read(16)); break;
    default: return "";
  }
  dictionary[3] = c;
  let w = c;
  const result = [c];
  for (;;) {
    if (data.index > length) return "";
    let code = read(numBits);
    if (code === 0 || code === 1) {
      dictionary[dictSize++] = f(read(code === 0 ? 8 : 16));
      code = dictSize - 1;
      enlargeIn--;
    } else if (code === 2) {
      return result.join("");
    }
    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits++; }
    let entry: string;
    if (code < dictSize && dictionary[code] !== undefined && code > 2) entry = dictionary[code]!;
    else if (code === dictSize) entry = w + w.charAt(0);
    else return null;
    result.push(entry);
    dictionary[dictSize++] = w + entry.charAt(0);
    enlargeIn--;
    w = entry;
    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits++; }
  }
}

export function compressToUTF16(input: string): string {
  return compress(input, 15, (a) => f(a + 32)) + " ";
}

/** The text, or null when the input is not an LZ-String UTF-16 stream. */
export function decompressFromUTF16(compressed: string): string | null {
  if (compressed === "") return null;
  return decompress(compressed.length, 16384, (i) => compressed.charCodeAt(i) - 32);
}

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const LOOKUP = new Int16Array(128).fill(-1);

for (let index = 0; index < ALPHABET.length; index += 1) {
  LOOKUP[ALPHABET.charCodeAt(index)] = index;
}

export function encodeBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const chunk = (a << 16) | (b << 8) | c;

    output += ALPHABET[(chunk >> 18) & 0x3f];
    output += ALPHABET[(chunk >> 12) & 0x3f];
    output += index + 1 < bytes.length ? ALPHABET[(chunk >> 6) & 0x3f] : "=";
    output += index + 2 < bytes.length ? ALPHABET[chunk & 0x3f] : "=";
  }
  return output;
}

export function decodeBase64(value: string): Uint8Array {
  const sanitized = value.replace(/\s+/g, "");
  if (sanitized.length % 4 !== 0) {
    throw new Error("Invalid base64 string length");
  }

  let padding = 0;
  if (sanitized.endsWith("==")) {
    padding = 2;
  } else if (sanitized.endsWith("=")) {
    padding = 1;
  }

  const output = new Uint8Array((sanitized.length / 4) * 3 - padding);
  let offset = 0;

  for (let index = 0; index < sanitized.length; index += 4) {
    const chars = sanitized.slice(index, index + 4);
    const a = decodeChar(chars.charCodeAt(0));
    const b = decodeChar(chars.charCodeAt(1));
    const c = chars[2] === "=" ? 0 : decodeChar(chars.charCodeAt(2));
    const d = chars[3] === "=" ? 0 : decodeChar(chars.charCodeAt(3));
    const chunk = (a << 18) | (b << 12) | (c << 6) | d;

    output[offset] = (chunk >> 16) & 0xff;
    offset += 1;
    if (chars[2] !== "=") {
      output[offset] = (chunk >> 8) & 0xff;
      offset += 1;
    }
    if (chars[3] !== "=") {
      output[offset] = chunk & 0xff;
      offset += 1;
    }
  }

  return output;
}

function decodeChar(charCode: number): number {
  if (charCode >= LOOKUP.length) {
    throw new Error("Invalid base64 character");
  }
  const value = LOOKUP[charCode]!;
  if (value === -1) {
    throw new Error("Invalid base64 character");
  }
  return value;
}

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

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

export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = data.buffer;
  if (buffer instanceof ArrayBuffer) {
    return buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  const copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);
  return copy;
}

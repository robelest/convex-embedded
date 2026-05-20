function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function arrayBufferEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  for (let index = 0; index < leftBytes.length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return false;
    }
  }

  return true;
}

export function structuralEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (
    left === null ||
    right === null ||
    left === undefined ||
    right === undefined
  ) {
    return false;
  }

  if (left instanceof ArrayBuffer && right instanceof ArrayBuffer) {
    return arrayBufferEqual(left, right);
  }

  if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
    if (left.constructor !== right.constructor) return false;
    const l = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const r = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    if (l.length !== r.length) return false;
    for (let i = 0; i < l.length; i++) {
      if (l[i] !== r[i]) return false;
    }
    return true;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!structuralEqual(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    for (const key of leftKeys) {
      if (!(key in right) || !structuralEqual(left[key], right[key])) {
        return false;
      }
    }
    return true;
  }

  return false;
}

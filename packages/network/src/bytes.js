// @ts-check
/// <reference path="./types.js" />
import { encodeBase64, decodeBase64 } from '@endo/base64';

const { details: X } = assert;

/**
 * @param {unknown} specimen
 * @returns {Data}
 */
export function coerceToData(specimen) {
  if (typeof specimen === 'string') {
    return specimen;
  }

  assert.typeof(specimen, 'object');

  if (specimen == null) {
    throw assert.fail(X`specimen ${specimen} is nullish`, TypeError);
  }

  if (!(Symbol.iterator in specimen)) {
    throw assert.fail(X`specimen ${specimen} is not iterable`, TypeError);
  }

  // Good enough... it's iterable and can be coerced later.
  return /** @type {Data} */ (specimen);
}

/**
 * Convert some data to bytes.
 *
 * @param {Data} data
 * @returns {Bytes}
 */
export function toBytes(data) {
  /** @type {Data | number[]} */
  let bytes = data;
  // TODO: We really need marshallable TypedArrays.
  if (typeof bytes === 'string') {
    bytes = bytes.split('').map(c => c.charCodeAt(0));
  }

  // We return the raw octets from the lower 8-bits of
  // the String's representation.
  const buf = new Uint8Array(bytes);
  return String.fromCharCode.apply(null, buf);
}

/**
 * Convert bytes to a String.
 *
 * @param {Bytes} bytes
 * @returns {string}
 */
export function bytesToString(bytes) {
  return bytes;
}

/**
 * Base64, as specified in https://tools.ietf.org/html/rfc4648#section-4
 *
 * @param {Data} data
 * @returns {string} base64 encoding
 */
export function dataToBase64(data) {
  /** @type {Uint8Array} */
  let bytes;
  if (typeof data === 'string') {
    bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
      bytes[i] = data.charCodeAt(i);
    }
  } else {
    bytes = new Uint8Array(data);
  }
  return encodeBase64(bytes);
}

/**
 * Decodes a string into base64.
 *
 * @param {string} string Base64-encoded string
 * @returns {Bytes} decoded bytes
 */
export function base64ToBytes(string) {
  return toBytes(decodeBase64(string));
}

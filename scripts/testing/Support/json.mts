import { z } from 'zod';

export function jsonValue(bytes: unknown): unknown {
  if (typeof bytes !== 'string' && !(bytes instanceof Uint8Array)) {
    throw new TypeError('Expected JSON text or UTF-8 bytes');
  }

  return JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function jsonObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    throw new TypeError('Expected an object');
  }

  return value;
}

export function jsonArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Expected an array');
  }

  return value;
}

export function jsonString(value: unknown): string {
  return z.string().parse(value);
}

export function jsonNumber(value: unknown): number {
  return z.number().parse(value);
}

export function jsonNumberArray(value: unknown): number[] {
  return z.array(z.number()).parse(value);
}

export function jsonSequence(value: unknown): string | unknown[] {
  return z.union([z.string(), z.array(z.unknown())]).parse(value);
}

export function binaryValue(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError('Expected binary bytes');
  }

  return value;
}

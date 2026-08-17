/**
 * In-memory {@link R2Store} for tests. Keys map to UTF-8 string bodies and
 * custom metadata, mirroring the small surface the analytics layer uses.
 */

import type { R2Store } from "../../src/analytics/storage.ts";

interface StoredObject {
  body: string;
  metadata: Record<string, string>;
}

/** A fake R2 bucket implementing the structural {@link R2Store} interface. */
export class FakeR2 implements R2Store {
  readonly objects = new Map<string, StoredObject>();

  // fallow-ignore-next-line unused-class-member -- Required by R2Store.
  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { key, size: object.body.length } : null;
  }

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      async text() {
        return object.body;
      },
      async json<T>() {
        return JSON.parse(object.body) as T;
      },
    };
  }

  async put(
    key: string,
    value: string,
    options?: { customMetadata?: Record<string, string> },
  ) {
    this.objects.set(key, {
      body: value,
      metadata: options?.customMetadata ?? {},
    });
    return { key };
  }

  async list(options?: { prefix?: string; cursor?: string }) {
    const prefix = options?.prefix ?? "";
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
    return { objects: keys.map((key) => ({ key })), truncated: false, cursor: undefined };
  }

  /** Convenience: raw body for a key, for inspecting stored rollups. */
  raw(key: string): string | undefined {
    return this.objects.get(key)?.body;
  }
}

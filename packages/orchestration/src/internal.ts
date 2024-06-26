import type { Vow } from '@agoric/vow';

export type PromiseToVow<T> = T extends (...args: infer A) => Promise<infer R>
  ? (...args: A) => Vow<R>
  : never;

export type VowifyAll<T> = {
  [K in keyof T]: PromiseToVow<T[K]>;
};

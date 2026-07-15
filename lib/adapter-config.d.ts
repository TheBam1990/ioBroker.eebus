import type { native } from "../io-package.json";

type _AdapterConfig = typeof native;

declare global {
  namespace ioBroker {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface AdapterConfig extends _AdapterConfig {}
  }
}

export {};

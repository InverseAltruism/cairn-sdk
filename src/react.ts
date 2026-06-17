// React adapter for Cairn (Phase 3 DX). DESIGN: this file has ZERO react dependency — you pass your
// app's React in (`createCairnHooks(React)`). That keeps the core SDK framework-agnostic (the
// wagmi-on-viem lesson: React belongs in an optional adapter, never bundled into the chain SDK), needs
// no @types/react, and makes the hooks unit-testable with a mock React. All real logic lives in the
// framework-agnostic CairnController; these hooks are thin reactive bindings over useSyncExternalStore.
//
//   import * as React from "react";
//   import { createCairnHooks } from "@inversealtruism/cairn-sdk/react";
//   const { useCairn, useCairnAccount } = createCairnHooks(React);
import { CairnController, type CairnState, type CairnControllerOptions } from "./controller.js";
import type { SiwcParams, SiwcResult } from "./connect.js";

/** The minimal slice of React this adapter uses (so it needs no react dependency / @types/react). */
export interface ReactLike {
  useSyncExternalStore<T>(
    subscribe: (cb: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T;
}

/** Reactive state + bound actions returned by useCairn(). */
export type UseCairnResult = CairnState & {
  connect: () => Promise<string>;
  disconnect: () => Promise<void>;
  signInWithCsd: (params: SiwcParams) => Promise<SiwcResult>;
};

export interface CairnHooks {
  /** The bound controller (for advanced use outside hooks). */
  controller: CairnController;
  /** Reactive full state: { status, account, error }. */
  useCairnState(): CairnState;
  /** Reactive account (null when disconnected / locked). */
  useCairnAccount(): string | null;
  /** Reactive state + bound actions. */
  useCairn(): UseCairnResult;
}

/**
 * Build React hooks bound to a CairnController. Pass your app's `React` (or `{ useSyncExternalStore }`).
 * Optionally pass an existing controller; otherwise one is created from `opts`.
 */
export function createCairnHooks(React: ReactLike, controllerOrOpts?: CairnController | CairnControllerOptions): CairnHooks {
  const controller = controllerOrOpts instanceof CairnController ? controllerOrOpts : new CairnController(controllerOrOpts);
  const useCairnState = (): CairnState =>
    React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const useCairnAccount = (): string | null => useCairnState().account;
  const useCairn = (): UseCairnResult => ({
    ...useCairnState(),
    connect: controller.connect,
    disconnect: controller.disconnect,
    signInWithCsd: controller.signInWithCsd,
  });
  return { controller, useCairnState, useCairnAccount, useCairn };
}

export { CairnController } from "./controller.js";
export type { CairnState, CairnControllerOptions } from "./controller.js";

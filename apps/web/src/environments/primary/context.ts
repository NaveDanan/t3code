import {
  attachEnvironmentDescriptor,
  createKnownEnvironment,
  type KnownEnvironment,
} from "@t3tools/client-runtime";
import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { create } from "zustand";

import {
  BootstrapHttpError,
  BootstrapTimeoutError,
  logBootstrapDebug,
  retryTransientBootstrap,
} from "./auth";

import { readPrimaryEnvironmentTarget, resolvePrimaryEnvironmentHttpUrl } from "./target";

const SERVER_ENVIRONMENT_DESCRIPTOR_PATH = "/.well-known/t3/environment";
const ENVIRONMENT_DESCRIPTOR_FETCH_TIMEOUT_MS = 10_000;

interface PrimaryEnvironmentBootstrapState {
  readonly descriptor: ExecutionEnvironmentDescriptor | null;
  readonly setDescriptor: (descriptor: ExecutionEnvironmentDescriptor | null) => void;
  readonly reset: () => void;
}

const usePrimaryEnvironmentBootstrapStore = create<PrimaryEnvironmentBootstrapState>()((set) => ({
  descriptor: null,
  setDescriptor: (descriptor) => set({ descriptor }),
  reset: () => set({ descriptor: null }),
}));

let primaryEnvironmentDescriptorPromise: Promise<ExecutionEnvironmentDescriptor> | null = null;

function createPrimaryKnownEnvironment(input: {
  readonly source: KnownEnvironment["source"];
  readonly target: KnownEnvironment["target"];
}): KnownEnvironment | null {
  const descriptor = readPrimaryEnvironmentDescriptor();
  if (!descriptor) {
    return null;
  }

  return attachEnvironmentDescriptor(
    createKnownEnvironment({
      id: descriptor.environmentId,
      label: descriptor.label,
      source: input.source,
      target: input.target,
    }),
    descriptor,
  );
}

async function fetchPrimaryEnvironmentDescriptor(): Promise<ExecutionEnvironmentDescriptor> {
  return retryTransientBootstrap(async () => {
    const descriptorUrl = resolvePrimaryEnvironmentHttpUrl(SERVER_ENVIRONMENT_DESCRIPTOR_PATH);
    logBootstrapDebug(`loading environment descriptor url=${descriptorUrl}`);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ENVIRONMENT_DESCRIPTOR_FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(descriptorUrl, {
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut && error instanceof DOMException && error.name === "AbortError") {
        throw new BootstrapTimeoutError({
          message: `Timed out loading server environment descriptor (${ENVIRONMENT_DESCRIPTOR_FETCH_TIMEOUT_MS}ms).`,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new BootstrapHttpError({
        message: `Failed to load server environment descriptor (${response.status}).`,
        status: response.status,
      });
    }

    const descriptor = (await response.json()) as ExecutionEnvironmentDescriptor;
    logBootstrapDebug(
      `environment descriptor loaded environmentId=${descriptor.environmentId} label=${descriptor.label}`,
    );
    writePrimaryEnvironmentDescriptor(descriptor);
    return descriptor;
  });
}

export function readPrimaryEnvironmentDescriptor(): ExecutionEnvironmentDescriptor | null {
  return usePrimaryEnvironmentBootstrapStore.getState().descriptor;
}

export function usePrimaryEnvironmentId(): EnvironmentId | null {
  return usePrimaryEnvironmentBootstrapStore((state) => state.descriptor?.environmentId ?? null);
}

export function writePrimaryEnvironmentDescriptor(
  descriptor: ExecutionEnvironmentDescriptor | null,
): void {
  usePrimaryEnvironmentBootstrapStore.getState().setDescriptor(descriptor);
}

export function getPrimaryKnownEnvironment(): KnownEnvironment | null {
  const primaryTarget = readPrimaryEnvironmentTarget();
  if (!primaryTarget) {
    return null;
  }

  return createPrimaryKnownEnvironment({
    source: primaryTarget.source,
    target: primaryTarget.target,
  });
}

export function resolveInitialPrimaryEnvironmentDescriptor(): Promise<ExecutionEnvironmentDescriptor> {
  const descriptor = readPrimaryEnvironmentDescriptor();
  if (descriptor) {
    return Promise.resolve(descriptor);
  }

  if (primaryEnvironmentDescriptorPromise) {
    return primaryEnvironmentDescriptorPromise;
  }

  const nextPromise = fetchPrimaryEnvironmentDescriptor();
  primaryEnvironmentDescriptorPromise = nextPromise;
  return nextPromise.finally(() => {
    if (primaryEnvironmentDescriptorPromise === nextPromise) {
      primaryEnvironmentDescriptorPromise = null;
    }
  });
}

export function __resetPrimaryEnvironmentBootstrapForTests(): void {
  primaryEnvironmentDescriptorPromise = null;
  usePrimaryEnvironmentBootstrapStore.getState().reset();
}

export const resetPrimaryEnvironmentDescriptorForTests = __resetPrimaryEnvironmentBootstrapForTests;

export const __resetPrimaryEnvironmentDescriptorBootstrapForTests =
  __resetPrimaryEnvironmentBootstrapForTests;

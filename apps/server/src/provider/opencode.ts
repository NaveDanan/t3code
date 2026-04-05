import type { OpencodeServerProbe } from "./Services/OpencodeServerManager.ts";

export interface OpencodeResolvedModel {
  readonly providerID: string;
  readonly modelID: string;
}

function resolveConfiguredOpencodeModel(
  providerID: string,
  modelID: string,
  probe: OpencodeServerProbe,
): OpencodeResolvedModel | undefined {
  const configuredProvider = probe.configuredProviders.find(
    (provider) => provider.id === providerID,
  );
  if (!configuredProvider || !(modelID in configuredProvider.models)) {
    return undefined;
  }

  return { providerID, modelID };
}

export async function readOpencodeSdkData<T>(
  request: Promise<unknown>,
  operation: string,
): Promise<T> {
  const result = (await request) as {
    data?: T;
    error?: unknown;
    response?: Response;
  };

  if (result.data !== undefined) {
    return result.data;
  }

  if (result.error instanceof Error) {
    throw result.error;
  }

  if (result.error !== undefined) {
    throw new Error(
      `${operation} failed: ${typeof result.error === "string" ? result.error : JSON.stringify(result.error)}`,
    );
  }

  const status = result.response?.status;
  throw new Error(
    status ? `${operation} failed with HTTP ${status}.` : `${operation} returned no data.`,
  );
}

export function resolveOpencodeModel(
  model: string,
  probe: OpencodeServerProbe,
): OpencodeResolvedModel | undefined {
  const trimmed = model.trim();
  const separatorIndex = trimmed.indexOf("/");
  if (separatorIndex > 0 && separatorIndex < trimmed.length - 1) {
    const providerID = trimmed.slice(0, separatorIndex);
    const modelID = trimmed.slice(separatorIndex + 1);
    const configuredModel = resolveConfiguredOpencodeModel(providerID, modelID, probe);
    if (configuredModel) {
      return configuredModel;
    }
  }

  const matches = probe.configuredProviders.flatMap((provider) =>
    Object.keys(provider.models)
      .filter((modelID) => modelID === trimmed)
      .map((modelID) => ({ providerID: provider.id, modelID })),
  );
  if (matches.length === 1) {
    return matches[0];
  }

  const defaultMatches = Object.entries(probe.defaultModelByProviderId)
    .filter(([, modelID]) => modelID === trimmed)
    .map(([providerID, modelID]) => ({ providerID, modelID }));
  return defaultMatches.length === 1 ? defaultMatches[0] : undefined;
}

export function resolveFallbackOpencodeModel(
  probe: OpencodeServerProbe,
  preferredProviderID?: string,
): OpencodeResolvedModel | undefined {
  const preferredProvider =
    typeof preferredProviderID === "string" && preferredProviderID.trim().length > 0
      ? preferredProviderID.trim()
      : undefined;

  const candidateProviderIds = [
    ...(preferredProvider ? [preferredProvider] : []),
    ...probe.configuredProviders.map((provider) => provider.id),
  ].filter((providerID, index, values) => values.indexOf(providerID) === index);

  for (const providerID of candidateProviderIds) {
    const defaultModelID = probe.defaultModelByProviderId[providerID];
    if (!defaultModelID) {
      continue;
    }

    const resolvedModel = resolveConfiguredOpencodeModel(providerID, defaultModelID, probe);
    if (resolvedModel) {
      return resolvedModel;
    }
  }

  for (const providerID of candidateProviderIds) {
    const configuredProvider = probe.configuredProviders.find(
      (provider) => provider.id === providerID,
    );
    if (!configuredProvider) {
      continue;
    }

    const [firstModelID] = Object.keys(configuredProvider.models);
    if (!firstModelID) {
      continue;
    }

    return { providerID, modelID: firstModelID };
  }

  return undefined;
}

import {
  ChevronDownIcon,
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  LinkIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { type RefObject, useMemo, useState } from "react";
import type { ProviderKind, ServerProviderModel, UpstreamProvider } from "@t3tools/contracts";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Input } from "../ui/input";
import { SuggestiveSearch } from "../ui/suggestive-search";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// ── Upstream Providers (connection status list for multi-provider harnesses) ──

function UpstreamProviderRow({ upstream }: { upstream: UpstreamProvider }) {
  return (
    <div className="group flex items-center justify-between gap-2 py-1.5">
      <span className="min-w-0 truncate text-xs text-foreground/90">{upstream.name}</span>
      <div className="flex shrink-0 items-center gap-2">
        {upstream.connected ? (
          <Badge variant="success" size="sm">
            Connected
          </Badge>
        ) : (
          <Badge variant="outline" size="sm">
            Not connected
          </Badge>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                disabled
                className="opacity-0 transition-opacity group-hover:opacity-100"
                aria-label={`Connect ${upstream.name}`}
              />
            }
          >
            <LinkIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top" sideOffset={4}>
            Coming soon
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

function UpstreamProvidersSection({
  upstreamProviders,
}: {
  upstreamProviders: ReadonlyArray<UpstreamProvider>;
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const trimmedSearchQuery = searchQuery.trim();
  const normalizedSearchQuery = trimmedSearchQuery.toLowerCase();
  const filteredUpstreamProviders = useMemo(() => {
    if (!normalizedSearchQuery) {
      return upstreamProviders;
    }

    return upstreamProviders.filter((upstream) => {
      return `${upstream.name} ${upstream.id}`.toLowerCase().includes(normalizedSearchQuery);
    });
  }, [normalizedSearchQuery, upstreamProviders]);
  const searchSuggestions = useMemo(() => {
    const uniqueSuggestions: string[] = [];
    const seenSuggestions = new Set<string>();

    for (const upstream of upstreamProviders) {
      const suggestion = upstream.name.trim();
      if (!suggestion || seenSuggestions.has(suggestion)) {
        continue;
      }

      uniqueSuggestions.push(suggestion);
      seenSuggestions.add(suggestion);

      if (uniqueSuggestions.length === 6) {
        break;
      }
    }

    return uniqueSuggestions.length > 0 ? uniqueSuggestions : ["Search providers"];
  }, [upstreamProviders]);
  const providerCountLabel = trimmedSearchQuery
    ? `${filteredUpstreamProviders.length}/${upstreamProviders.length}`
    : String(upstreamProviders.length);

  if (upstreamProviders.length === 0) return null;

  return (
    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
      <button
        type="button"
        className="flex w-full items-center justify-between"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground">Providers</span>
          <Badge variant="outline" size="sm">
            {providerCountLabel}
          </Badge>
        </div>
        <ChevronDownIcon
          className={cn(
            "size-3.5 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleContent>
          <div className="mt-2">
            <SuggestiveSearch
              ariaLabel="Search harness providers"
              className="w-full rounded-lg border-input px-3 py-1.5 shadow-xs/5"
              deleteDurationMs={120}
              effect="fade"
              pauseAfterTypeMs={1600}
              suggestions={searchSuggestions}
              typeDurationMs={180}
              onChange={setSearchQuery}
            />
          </div>
          <div className="mt-2 max-h-40 overflow-y-auto">
            {filteredUpstreamProviders.length > 0 ? (
              filteredUpstreamProviders.map((upstream) => (
                <UpstreamProviderRow key={upstream.id} upstream={upstream} />
              ))
            ) : (
              <p className="py-2 text-xs text-muted-foreground">
                No providers match {'"'}
                {trimmedSearchQuery}
                {'"'}.
              </p>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ── Model row (with eye toggle, info tooltip, and custom badge) ──

function ModelRow({
  provider,
  model,
  isHidden,
  onToggleVisibility,
  onRemoveCustomModel,
}: {
  provider: ProviderKind;
  model: ServerProviderModel;
  isHidden: boolean;
  onToggleVisibility: (provider: ProviderKind, slug: string) => void;
  onRemoveCustomModel: (provider: ProviderKind, slug: string) => void;
}) {
  const caps = model.capabilities;
  const capLabels: string[] = [];
  const effortVariants = caps?.reasoningEffortLevels.map((level) => level.label) ?? [];
  if (caps?.supportsFastMode) capLabels.push("Fast mode");
  if (caps?.supportsThinkingToggle) capLabels.push("Thinking");
  if (effortVariants.length > 0) {
    capLabels.push("Reasoning");
  }
  const hasDetails = capLabels.length > 0 || model.name !== model.slug;

  return (
    <div className="group/model flex items-center gap-2 py-1">
      <button
        type="button"
        className={cn(
          "shrink-0 transition-colors",
          isHidden
            ? "text-muted-foreground/40 hover:text-muted-foreground"
            : "text-success/70 opacity-0 group-hover/model:opacity-100 hover:text-success",
        )}
        aria-label={isHidden ? `Show ${model.name} in chat` : `Hide ${model.name} from chat`}
        onClick={() => onToggleVisibility(provider, model.slug)}
      >
        {isHidden ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
      </button>
      <span
        className={cn(
          "min-w-0 truncate text-xs",
          isHidden ? "text-muted-foreground/50 line-through" : "text-foreground/90",
        )}
      >
        {model.name}
      </span>
      {hasDetails ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="shrink-0 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
                aria-label={`Details for ${model.name}`}
              />
            }
          >
            <InfoIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-56">
            <div className="space-y-1">
              <code className="block text-[11px] text-foreground">{model.slug}</code>
              {effortVariants.length > 0 ? (
                <div className="text-[10px] text-muted-foreground">
                  Effort: {effortVariants.join(", ")}
                </div>
              ) : null}
              {capLabels.length > 0 ? (
                <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                  {capLabels.map((label) => (
                    <span key={label} className="text-[10px] text-muted-foreground">
                      {label}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {model.isCustom ? (
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground">custom</span>
          <button
            type="button"
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`Remove ${model.slug}`}
            onClick={() => onRemoveCustomModel(provider, model.slug)}
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ── Models section (list + custom model input) ──

function ModelsSection({
  provider,
  models,
  hiddenModels,
  customModelInput,
  customModelError,
  customModelPlaceholder,
  modelListRef,
  onToggleVisibility,
  onRemoveCustomModel,
  onCustomModelInputChange,
  onAddCustomModel,
}: {
  provider: ProviderKind;
  models: ReadonlyArray<ServerProviderModel>;
  hiddenModels: ReadonlyArray<string>;
  customModelInput: string;
  customModelError: string | null;
  customModelPlaceholder: string;
  modelListRef: RefObject<Record<string, HTMLDivElement | null>>;
  onToggleVisibility: (provider: ProviderKind, slug: string) => void;
  onRemoveCustomModel: (provider: ProviderKind, slug: string) => void;
  onCustomModelInputChange: (provider: ProviderKind, value: string) => void;
  onAddCustomModel: (provider: ProviderKind) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
      <button
        type="button"
        className="flex w-full items-center justify-between"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground">Models</span>
          <Badge variant="outline" size="sm">
            {models.length}
          </Badge>
        </div>
        <ChevronDownIcon
          className={cn(
            "size-3.5 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleContent>
          <div className="mt-2 text-xs text-muted-foreground">
            {models.length} model
            {models.length === 1 ? "" : "s"} available.
          </div>
          <div
            ref={(el) => {
              modelListRef.current[provider] = el;
            }}
            className="mt-2 max-h-40 overflow-y-auto pb-1"
          >
            {models.map((model) => (
              <ModelRow
                key={`${provider}:${model.slug}`}
                provider={provider}
                model={model}
                isHidden={hiddenModels.includes(model.slug)}
                onToggleVisibility={onToggleVisibility}
                onRemoveCustomModel={onRemoveCustomModel}
              />
            ))}
          </div>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              id={`custom-model-${provider}`}
              value={customModelInput}
              onChange={(event) => onCustomModelInputChange(provider, event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                onAddCustomModel(provider);
              }}
              placeholder={customModelPlaceholder}
              spellCheck={false}
            />
            <Button
              className="shrink-0"
              variant="outline"
              onClick={() => onAddCustomModel(provider)}
            >
              <PlusIcon className="size-3.5" />
              Add
            </Button>
          </div>

          {customModelError ? (
            <p className="mt-2 text-xs text-destructive">{customModelError}</p>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ── Main exported component ──

export interface ProviderHarnessDetailsProps {
  provider: ProviderKind;
  models: ReadonlyArray<ServerProviderModel>;
  hiddenModels: ReadonlyArray<string>;
  upstreamProviders: ReadonlyArray<UpstreamProvider> | undefined;
  customModelInput: string;
  customModelError: string | null;
  customModelPlaceholder: string;
  modelListRef: RefObject<Record<string, HTMLDivElement | null>>;
  onToggleVisibility: (provider: ProviderKind, slug: string) => void;
  onRemoveCustomModel: (provider: ProviderKind, slug: string) => void;
  onCustomModelInputChange: (provider: ProviderKind, value: string) => void;
  onAddCustomModel: (provider: ProviderKind) => void;
}

/**
 * Reusable detail sections for multi-provider harnesses (e.g. OpenCode).
 * Renders an optional collapsible Upstream Providers list followed by
 * the Models list with visibility toggles and custom model input.
 *
 * Drop this component into any provider card's collapsible content area
 * to get the standard multi-provider harness layout.
 */
export function ProviderHarnessDetails({
  provider,
  models,
  hiddenModels,
  upstreamProviders,
  customModelInput,
  customModelError,
  customModelPlaceholder,
  modelListRef,
  onToggleVisibility,
  onRemoveCustomModel,
  onCustomModelInputChange,
  onAddCustomModel,
}: ProviderHarnessDetailsProps) {
  return (
    <>
      {upstreamProviders && upstreamProviders.length > 0 ? (
        <UpstreamProvidersSection upstreamProviders={upstreamProviders} />
      ) : null}
      <ModelsSection
        provider={provider}
        models={models}
        hiddenModels={hiddenModels}
        customModelInput={customModelInput}
        customModelError={customModelError}
        customModelPlaceholder={customModelPlaceholder}
        modelListRef={modelListRef}
        onToggleVisibility={onToggleVisibility}
        onRemoveCustomModel={onRemoveCustomModel}
        onCustomModelInputChange={onCustomModelInputChange}
        onAddCustomModel={onAddCustomModel}
      />
    </>
  );
}

import { useApp } from "@/contexts";
import { Header } from "@/components";

export const ProviderStatus = () => {
  const { selectedAIProvider, allAiProviders, selectedSttProvider, allSttProviders } = useApp();

  const currentAiProvider = allAiProviders.find((p) => p.id === selectedAIProvider.provider);
  const currentSttProvider = allSttProviders.find((p) => p.id === selectedSttProvider.provider);

  const aiName = currentAiProvider?.id
    ? currentAiProvider.id.charAt(0).toUpperCase() + currentAiProvider.id.slice(1)
    : "Not configured";
  const sttName = currentSttProvider?.id || "Not configured";

  return (
    <div id="provider-status" className="space-y-3 -mt-2">
      <div className="space-y-2 pt-2">
        <Header
          title="Provider Status"
          description="Configure your AI and STT providers in Settings to get started."
        />
        <div className="p-3 rounded-lg border border-input/50 bg-muted/30 space-y-1">
          <p className="text-sm">
            <span className="font-medium">AI Provider:</span>{" "}
            <span className="text-muted-foreground">{aiName}</span>
            {selectedAIProvider.variables?.api_key ? " \u2713" : " \u2014 API key required"}
          </p>
          <p className="text-sm">
            <span className="font-medium">STT Provider:</span>{" "}
            <span className="text-muted-foreground">{sttName}</span>
          </p>
        </div>
      </div>
    </div>
  );
};

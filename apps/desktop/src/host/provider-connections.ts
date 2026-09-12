import { initialProviderCatalogs } from '@quixi/providers';
import type { ProviderConnection } from '@quixi/app/features/providers';
/** These bindings must match the separately reviewed native-owned destination registry. */
export function desktopProviderConnections(): ProviderConnection[] {
  const connections: ProviderConnection[] = initialProviderCatalogs().map(catalog=>({id:catalog.providerId,label:catalog.providerId==='openai'?'OpenAI':'Anthropic',catalog,relayAuthorizationRequired:false,binding:{providerId:catalog.providerId,accountId:'primary',destinationId:`quixi-${catalog.providerId}-api-v1`,transportId:`quixi-${catalog.providerId}-native-v1`}}));
  const openai = connections.find(connection => connection.id === 'openai')!;
  for (const region of ['us', 'eu'] as const) {
    connections.push({
      ...openai,
      id: `openai-${region}`,
      label: region === 'us' ? 'OpenAI · US' : 'OpenAI · Europe (EEA + Switzerland)',
      processingRegion: region,
      binding: { providerId: 'openai', accountId: 'primary', destinationId: `quixi-openai-${region}-api-v1`, transportId: `quixi-openai-${region}-native-v1` },
    });
  }
  return connections;
}


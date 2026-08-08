export {
  BedrockCapabilityRegistry,
  type BedrockCapabilityEntry,
  type BedrockCapabilityRegistryOptions,
  type BedrockCapabilityResolver,
} from './capability-registry.js';
export {
  defaultBedrockModelCapabilities,
  type BedrockCredentials,
  type BedrockProviderOptions,
} from './configuration.js';
export {
  BedrockDiscoveryClient,
  type BedrockDiscoveryCatalog,
  type BedrockDiscoveryOptions,
  type BedrockDiscoveryTransport,
  type BedrockFoundationModel,
  type BedrockFoundationModelLifecycle,
  type BedrockInferenceProfile,
  type BedrockInferenceProfileType,
  type BedrockListFoundationModelsRequest,
  type BedrockListInferenceProfilesRequest,
} from './discovery.js';
export { createBedrockProvider, type BedrockModelProvider } from './provider.js';
